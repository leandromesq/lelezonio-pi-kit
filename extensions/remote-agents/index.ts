import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  BorderedLoader,
  getAgentDir,
  getMarkdownTheme,
  keyHint,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadNamingConfig } from "../auto-naming/src/config.ts";
import { generateTaskTitle } from "../auto-naming/src/title-generator.ts";
import { loadRemoteAgentsConfig } from "./src/config.ts";
import {
  buildRemotePrompt,
  deriveTitle,
  redactSensitiveText,
} from "./src/context.ts";
import {
  formatElapsed,
  isRemoteAgentActive,
  type RemoteAgentSnapshot,
} from "./src/domain.ts";
import { HerdrClient } from "./src/herdr-client.ts";
import { RemoteAgentManager } from "./src/manager.ts";
import { RemoteJobStore } from "./src/persistence.ts";
import { detectLocalGitProject, remoteProjectLocation } from "./src/project.ts";
import { SshTransport } from "./src/transport.ts";
import { openRemotePicker, openRemoteTakeover } from "./src/ui/dashboard.ts";

const RESULT_TRANSCRIPT_CHARS = 24 * 1024;

class RemoteProjectMissingError extends Error {
  constructor(
    readonly project: string,
    readonly origin: string | undefined,
    readonly destination: string,
  ) {
    super(`Remote project ${project} is missing at ${destination}`);
  }
}

function describe(snapshot: RemoteAgentSnapshot) {
  return `${snapshot.id} [${snapshot.status}] "${snapshot.title}" (${snapshot.host}:${snapshot.remoteCwd}, ${formatElapsed(snapshot)})`;
}

function snapshotDetails(snapshot: RemoteAgentSnapshot) {
  return {
    id: snapshot.id,
    title: snapshot.title,
    host: snapshot.host,
    remoteCwd: snapshot.remoteCwd,
    workspaceId: snapshot.workspaceId,
    status: snapshot.status,
    generation: snapshot.generation,
  };
}

function completionMessage(snapshot: RemoteAgentSnapshot) {
  const structured = snapshot.finalText?.trim();
  const output =
    structured ||
    snapshot.transcript.trim().slice(-RESULT_TRANSCRIPT_CHARS) ||
    "(no result captured)";
  const heading = structured ? "Remote result" : "Remote transcript tail";
  return `Remote agent ${snapshot.id} "${snapshot.title}" ${snapshot.status} after ${formatElapsed(snapshot)}.\nWorkspace: ${snapshot.host}:${snapshot.remoteCwd}${snapshot.workspaceId ? ` (${snapshot.workspaceId})` : ""}\n\n## ${heading}\n\n${output}`;
}

export default function (pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const config = loadRemoteAgentsConfig(
    path.join(agentDir, "remote-agents.json"),
  );
  let managerPromise: Promise<RemoteAgentManager> | undefined;
  let manager: RemoteAgentManager | undefined;
  let closed = false;
  let ui: ExtensionUIContext | undefined;
  let unsubscribe: (() => void) | undefined;

  const updateStatus = () => {
    if (!ui || !manager) return;
    const jobs = manager.list();
    if (jobs.length === 0) {
      ui.setStatus("remote-agents", undefined);
      return;
    }
    const running = jobs.filter(
      (job) => job.status === "working" || job.status === "starting",
    ).length;
    const blocked = jobs.filter((job) => job.status === "blocked").length;
    const unreachable = jobs.filter(
      (job) => job.status === "unreachable",
    ).length;
    const done = jobs.length - running - blocked - unreachable;
    const parts = [
      running ? `${running} running` : "",
      blocked ? `${blocked} blocked` : "",
      unreachable ? `${unreachable} offline` : "",
      done ? `${done} done` : "",
    ].filter(Boolean);
    ui.setStatus(
      "remote-agents",
      ui.theme.fg(
        unreachable ? "warning" : running ? "accent" : "muted",
        `remote: ${parts.join(" · ")}`,
      ),
    );
  };

  const deliverCompletion = async (snapshot: RemoteAgentSnapshot) => {
    if (!manager || snapshot.completionDelivered) return;
    const generation = snapshot.generation;
    try {
      // Herdr can report the Pi turn settled just before post-run integrations
      // finish updating the terminal/session file.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      if (!manager) return;
      await manager
        .refresh(snapshot.id, { transcript: true })
        .catch(() => snapshot);
      const latest = manager.get(snapshot.id) ?? snapshot;
      if (
        latest.generation !== generation ||
        latest.completionDelivered ||
        isRemoteAgentActive(latest.status)
      ) {
        manager.releaseCompletionDelivery(snapshot.id);
        return;
      }
      pi.sendMessage(
        {
          customType: "remote-agent-result",
          content: completionMessage(latest),
          display: true,
          details: {
            id: latest.id,
            title: latest.title,
            status: latest.status,
          },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      manager.markCompletionDelivered(snapshot.id);
    } catch (error) {
      manager?.releaseCompletionDelivery(snapshot.id);
      console.error("remote-agents: completion delivery failed", error);
    }
  };

  const deliverBlocked = async (snapshot: RemoteAgentSnapshot) => {
    if (!manager || snapshot.blockedDelivered) return;
    const generation = snapshot.generation;
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!manager) return;
      await manager
        .refresh(snapshot.id, { transcript: true })
        .catch(() => snapshot);
      const latest = manager.get(snapshot.id) ?? snapshot;
      if (
        latest.generation !== generation ||
        latest.status !== "blocked" ||
        latest.blockedDelivered
      ) {
        manager.releaseBlockedDelivery(snapshot.id);
        return;
      }
      const question =
        latest.finalText?.trim() ||
        latest.transcript.trim().slice(-RESULT_TRANSCRIPT_CHARS) ||
        "The remote agent is waiting for clarification.";
      pi.sendMessage(
        {
          customType: "remote-agent-blocked",
          content: `Remote agent ${latest.id} "${latest.title}" needs input.\n\n${question}\n\nRespond with remote_send or open /remotes.`,
          display: true,
          details: {
            id: latest.id,
            title: latest.title,
            status: latest.status,
          },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      manager.markBlockedDelivered(snapshot.id);
    } catch (error) {
      manager?.releaseBlockedDelivery(snapshot.id);
      console.error("remote-agents: blocked delivery failed", error);
    }
  };

  const getManager = () => {
    managerPromise ??= (async () => {
      const transport = new SshTransport(config);
      const client = new HerdrClient(transport);
      const store = new RemoteJobStore(
        path.join(agentDir, "remote-agents", "jobs.json"),
      );
      const next = new RemoteAgentManager(config, client, store);
      next.setOnSettled((snapshot) => void deliverCompletion(snapshot));
      next.setOnBlocked((snapshot) => void deliverBlocked(snapshot));
      manager = next;
      unsubscribe?.();
      unsubscribe = next.view.subscribe(updateStatus);
      await next.initialize();
      if (closed) {
        next.dispose();
        throw new Error(
          "Remote agent extension session closed during initialization",
        );
      }
      updateStatus();
      return next;
    })().catch((error) => {
      managerPromise = undefined;
      throw error;
    });
    return managerPromise;
  };

  pi.on("session_start", (_event, ctx) => {
    closed = false;
    if (ctx.hasUI) ui = ctx.ui;
    if (ctx.mode !== "tui") return;
    void getManager().catch((error) =>
      ctx.ui.notify(
        `Remote agents unavailable: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      ),
    );
  });

  pi.on("session_shutdown", () => {
    closed = true;
    unsubscribe?.();
    unsubscribe = undefined;
    ui?.setStatus("remote-agents", undefined);
    ui = undefined;
    manager?.dispose();
    manager = undefined;
    managerPromise = undefined;
    // Deliberately do not close Herdr workspaces: remote jobs survive local Pi.
  });

  pi.registerMessageRenderer(
    "remote-agent-result",
    (message, { expanded }, theme) => {
      const details = message.details as
        { id?: string; title?: string; status?: string } | undefined;
      const icon =
        details?.status === "done"
          ? theme.fg("success", "✓")
          : theme.fg("warning", "■");
      if (!expanded)
        return new Text(
          `${icon} ${theme.fg("accent", details?.id ?? "remote")} ${theme.fg("muted", details?.title ?? "remote task")}\n${theme.fg("dim", keyHint("app.tools.expand", "to expand"))}`,
          0,
          0,
        );
      return new Markdown(
        typeof message.content === "string"
          ? message.content
          : "Remote agent completed",
        0,
        0,
        getMarkdownTheme(),
      );
    },
  );

  pi.registerMessageRenderer(
    "remote-agent-blocked",
    (message, { expanded }, theme) => {
      const details = message.details as
        { id?: string; title?: string } | undefined;
      if (!expanded)
        return new Text(
          `${theme.fg("warning", "?")} ${theme.fg("accent", details?.id ?? "remote")} ${theme.fg("muted", "needs input")}\n${theme.fg("dim", keyHint("app.tools.expand", "to expand"))}`,
          0,
          0,
        );
      return new Markdown(
        typeof message.content === "string"
          ? message.content
          : "Remote agent needs input",
        0,
        0,
        getMarkdownTheme(),
      );
    },
  );

  const prepareRemote = async (
    instructions: string,
    ctx: ExtensionContext,
    options: {
      signal?: AbortSignal;
      titleOverride?: string;
      localCwdOverride?: string;
      cloneIfMissing?: boolean;
    } = {},
  ) => {
    const task = instructions.trim();
    if (!task) throw new Error("Remote instructions must not be empty");
    const localCwd = path.resolve(ctx.cwd, options.localCwdOverride ?? ".");
    const project = await detectLocalGitProject(localCwd);
    const remote = await getManager();
    let remoteCwd = config.worktreesRoot;
    let projectRoot: string | undefined;
    if (project) {
      const location = remoteProjectLocation(config.projectsRoot, project);
      remoteCwd = location.cwd;
      projectRoot = location.root;
      const info = await remote.pathInfo(projectRoot, options.signal);
      if (info.exists && !info.isGitRepository)
        throw new Error(
          `Remote project path exists but is not a Git repository: ${projectRoot}`,
        );
      if (!info.exists) {
        if (!options.cloneIfMissing)
          throw new RemoteProjectMissingError(
            project.name,
            project.origin,
            projectRoot,
          );
        if (!project.origin)
          throw new Error(
            `Remote project ${project.name} is missing and the local repository has no origin remote to clone.`,
          );
        if (/^https?:\/\/[^/\s]+:[^@\s]+@/i.test(project.origin))
          throw new Error(
            `Refusing to transmit a credential-bearing Git origin. Configure a credential-free SSH or HTTPS origin for ${project.name}.`,
          );
        await remote.cloneProject(project.origin, projectRoot, options.signal);
      }
    } else {
      const info = await remote.pathInfo(remoteCwd, options.signal);
      if (!info.exists)
        throw new Error(`Remote worktrees folder does not exist: ${remoteCwd}`);
    }
    const rawTitle =
      options.titleOverride?.trim() ||
      (await generateTaskTitle({
        modelRegistry: ctx.modelRegistry,
        config: loadNamingConfig(),
        prompt: task,
        fallback: deriveTitle(task),
        signal: options.signal,
      }));
    const title = redactSensitiveText(rawTitle).slice(0, 72) || "remote task";
    const prompt = buildRemotePrompt({
      instructions: task,
      title,
      localCwd,
      remoteCwd,
      project: project
        ? { name: project.name, root: projectRoot ?? remoteCwd }
        : undefined,
      context: ctx,
    });
    return {
      remote,
      spawn: {
        title,
        prompt,
        localCwd,
        remoteCwd,
        projectRoot,
        projectName: project?.name,
        signal: options.signal,
      },
    };
  };

  const startRemote = async (
    instructions: string,
    ctx: ExtensionContext,
    options: Parameters<typeof prepareRemote>[2] = {},
  ) => {
    const prepared = await prepareRemote(instructions, ctx, options);
    return prepared.remote.spawn(prepared.spawn);
  };

  pi.registerCommand("remote", {
    description: "Run a task in a persistent Pi agent on the macmini",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /remote <instructions>", "error");
        return;
      }
      if (ctx.mode !== "tui") {
        try {
          const snapshot = await startRemote(args, ctx);
          ctx.ui.notify(`Started ${describe(snapshot)}`, "info");
        } catch (error) {
          ctx.ui.notify(
            error instanceof Error ? error.message : String(error),
            "error",
          );
        }
        return;
      }
      let prepared: Awaited<ReturnType<typeof prepareRemote>>;
      try {
        prepared = await prepareRemote(args, ctx);
      } catch (error) {
        if (!(error instanceof RemoteProjectMissingError)) {
          ctx.ui.notify(
            error instanceof Error ? error.message : String(error),
            "error",
          );
          return;
        }
        if (!error.origin) {
          ctx.ui.notify(
            `${error.message}. The local repository has no origin remote to clone.`,
            "error",
          );
          return;
        }
        const approved = await ctx.ui.confirm(
          "Clone remote project?",
          `${error.project} is missing on macmini. Clone ${redactSensitiveText(error.origin)} into ${error.destination}?`,
        );
        if (!approved) return;
        try {
          prepared = await prepareRemote(args, ctx, { cloneIfMissing: true });
        } catch (cloneError) {
          ctx.ui.notify(
            cloneError instanceof Error
              ? cloneError.message
              : String(cloneError),
            "error",
          );
          return;
        }
      }
      const snapshot = await ctx.ui.custom<RemoteAgentSnapshot | null>(
        (tui, theme, _keybindings, done) => {
          const loader = new BorderedLoader(
            tui,
            theme,
            "Starting remote agent on macmini...",
          );
          loader.onAbort = () => done(null);
          prepared.remote
            .spawn({ ...prepared.spawn, signal: loader.signal })
            .then(done)
            .catch((error) => {
              ctx.ui.notify(
                error instanceof Error ? error.message : String(error),
                "error",
              );
              done(null);
            });
          return loader;
        },
      );
      if (!snapshot) return;
      ctx.ui.notify(`Started ${snapshot.id} on macmini`, "info");
      await openRemoteTakeover(ctx, (await getManager()).view, snapshot.id);
    },
  });

  const listCommand = async (_args: string, ctx: ExtensionCommandContext) => {
    const remote = await getManager();
    if (ctx.mode !== "tui") {
      ctx.ui.notify(
        remote.list().map(describe).join("\n") || "No remote agents",
        "info",
      );
      return;
    }
    await openRemotePicker(ctx, remote.view);
  };

  pi.registerCommand("remotes", {
    description: "List and inspect persistent remote agents",
    handler: listCommand,
  });

  pi.registerCommand("remote-clean", {
    description: "Close and forget all settled remote workspaces",
    handler: async (_args, ctx) => {
      const remote = await getManager();
      const stale = remote
        .list()
        .filter((job) => !isRemoteAgentActive(job.status));
      if (stale.length === 0) {
        ctx.ui.notify("No stale remote workspaces", "info");
        return;
      }
      if (
        ctx.mode === "tui" &&
        !(await ctx.ui.confirm(
          "Clean stale remote workspaces?",
          `Close and forget ${stale.length} settled workspace${stale.length === 1 ? "" : "s"}?`,
        ))
      )
        return;
      const result = await remote.cleanStale();
      const suffix = result.failed.length
        ? `; ${result.failed.length} could not be removed`
        : "";
      ctx.ui.notify(
        `Removed ${result.removed.length} stale remote workspaces${suffix}`,
        result.failed.length ? "warning" : "info",
      );
    },
  });

  pi.registerTool({
    name: "remote_spawn",
    label: "Spawn Remote Agent",
    description:
      "Start a persistent Pi agent through Herdr on the Tailscale-connected macmini. The job survives local Pi shutdown and is monitored in /remotes.",
    promptSnippet:
      "Delegate a long-running task to a persistent remote Pi agent on the macmini",
    promptGuidelines: [
      "Use remote_spawn only when the user explicitly requests remote execution or approves delegating a long-running task.",
      "After remote_spawn, continue useful local work; use remote_check only when current status is needed.",
      "Remote agents must not push, merge, deploy, or receive secrets unless the user explicitly authorizes it.",
    ],
    parameters: Type.Object({
      instructions: Type.String({
        description: "Self-contained instructions for the remote agent",
      }),
      title: Type.Optional(Type.String({ description: "Short display title" })),
      working_dir: Type.Optional(
        Type.String({
          description: "Local working directory used to detect the Git project",
        }),
      ),
      clone_if_missing: Type.Optional(
        Type.Boolean({
          description:
            "Clone a missing remote project from its local origin; only set after explicit user approval",
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const snapshot = await startRemote(params.instructions, ctx, {
        signal,
        titleOverride: params.title,
        localCwdOverride: params.working_dir,
        cloneIfMissing: params.clone_if_missing,
      });
      return {
        content: [
          {
            type: "text",
            text: `Started ${describe(snapshot)}. It continues remotely; use remote_check or remote_list when needed.`,
          },
        ],
        details: snapshotDetails(snapshot),
      };
    },
  });

  pi.registerTool({
    name: "remote_check",
    label: "Check Remote Agent",
    description:
      "Refresh one remote agent and return its status plus a tail of its Herdr terminal transcript.",
    parameters: Type.Object({
      id: Type.String({ description: "Remote agent id, e.g. ra-a31f" }),
    }),
    async execute(_toolCallId, params, signal) {
      const remote = await getManager();
      const snapshot = await remote.refresh(params.id, {
        transcript: true,
        signal,
      });
      const tail =
        snapshot.finalText?.trim() ||
        snapshot.transcript.slice(-16 * 1024) ||
        "(no output yet)";
      if (!isRemoteAgentActive(snapshot.status))
        remote.markCompletionDelivered(snapshot.id);
      return {
        content: [{ type: "text", text: `${describe(snapshot)}\n\n${tail}` }],
        details: snapshotDetails(snapshot),
      };
    },
  });

  pi.registerTool({
    name: "remote_list",
    label: "List Remote Agents",
    description:
      "List persistent remote agents known to this machine, including jobs recovered after Pi restarts.",
    parameters: Type.Object({}),
    async execute() {
      const remote = await getManager();
      return {
        content: [
          {
            type: "text",
            text: remote.list().map(describe).join("\n") || "No remote agents.",
          },
        ],
        details: { jobs: remote.list().map(snapshotDetails) },
      };
    },
  });

  pi.registerTool({
    name: "remote_send",
    label: "Send to Remote Agent",
    description:
      "Send follow-up instructions to an existing remote Herdr agent.",
    parameters: Type.Object({ id: Type.String(), message: Type.String() }),
    async execute(_toolCallId, params, signal) {
      const remote = await getManager();
      await remote.send(params.id, params.message, signal);
      return {
        content: [
          {
            type: "text",
            text: `Sent follow-up instructions to ${params.id}.`,
          },
        ],
        details: remote.get(params.id)
          ? snapshotDetails(remote.get(params.id)!)
          : undefined,
      };
    },
  });

  pi.registerTool({
    name: "remote_wait",
    label: "Wait for Remote Agent",
    description:
      "Wait until a remote agent settles. Prefer automatic completion delivery unless its result is required before continuing.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_toolCallId, params, signal) {
      const remote = await getManager();
      const snapshot = await remote.wait(params.id, signal);
      if (snapshot.status !== "blocked")
        remote.markCompletionDelivered(snapshot.id);
      return {
        content: [{ type: "text", text: completionMessage(snapshot) }],
        details: snapshotDetails(snapshot),
      };
    },
  });

  pi.registerTool({
    name: "remote_cancel",
    label: "Cancel Remote Agent",
    description:
      "Send Ctrl+C to a running remote Herdr agent. The workspace remains available for inspection.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_toolCallId, params, signal) {
      const remote = await getManager();
      const snapshot = await remote.cancel(params.id, signal);
      return {
        content: [
          {
            type: "text",
            text: `Cancellation requested for ${describe(snapshot)}.`,
          },
        ],
        details: snapshotDetails(snapshot),
      };
    },
  });
}
