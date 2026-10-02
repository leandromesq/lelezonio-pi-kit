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
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadNamingConfig } from "../auto-naming/src/config.ts";
import { generateTaskTitle } from "../auto-naming/src/title-generator.ts";
import { formatElapsed } from "../shared/format.ts";
import { loadRemoteAgentsConfig } from "./src/config.ts";
import {
  buildRemotePrompt,
  deriveTitle,
  redactSensitiveText,
} from "./src/context.ts";
import { isRemoteAgentActive, type RemoteAgentSnapshot } from "./src/domain.ts";
import { HerdrClient } from "./src/herdr-client.ts";
import { RemoteAgentManager } from "./src/manager.ts";
import { RemoteJobStore } from "./src/persistence.ts";
import { detectLocalGitProject, remoteProjectLocation } from "./src/project.ts";
import { openRemoteUi } from "./src/remote-ui.ts";
import { SshTransport } from "./src/transport.ts";
import { openRemotePicker } from "./src/ui/dashboard.ts";
import { remoteActivityStatus } from "./src/ui/status.ts";

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
  // A legacy (unowned) job is preserved and inspectable but never
  // auto-delivered; an explicit check/wait/send adopts it for this session.
  const ownership =
    snapshot.ownerSessionId === undefined
      ? " [unowned · remote_check to adopt]"
      : "";
  return `${snapshot.id} [${snapshot.status}] "${snapshot.title}" (${snapshot.host}:${snapshot.remoteCwd}, ${formatElapsed(snapshot.createdAt, snapshot.settledAt)})${ownership}`;
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
  return `Remote agent ${snapshot.id} "${snapshot.title}" ${snapshot.status} after ${formatElapsed(snapshot.createdAt, snapshot.settledAt)}.\nWorkspace: ${snapshot.host}:${snapshot.remoteCwd}${snapshot.workspaceId ? ` (${snapshot.workspaceId})` : ""}\n\n## ${heading}\n\n${output}`;
}

/**
 * Custom-message envelope shared by the remote result messages: the recap
 * card of `/summary` (section 10 of `docs/ui-conventions.md`) with the label
 * on the `customMessageLabel` role and the body in `customMessageText`.
 */
function remoteMessageCard(options: {
  theme: Theme;
  expanded: boolean;
  icon: string;
  label: string;
  meta: string;
  content: string;
}) {
  const { theme } = options;
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(
    new Text(
      options.icon +
        " " +
        theme.fg("customMessageLabel", theme.bold(options.label)) +
        theme.fg("muted", ` · ${options.meta}`),
      0,
      0,
    ),
  );
  if (options.expanded) {
    box.addChild(
      new Markdown(options.content, 0, 1, getMarkdownTheme(), {
        color: (text) => theme.fg("customMessageText", text),
      }),
    );
  } else {
    box.addChild(
      new Text(
        theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`),
        0,
        0,
      ),
    );
  }
  return box;
}

export default function (pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const config = loadRemoteAgentsConfig(
    path.join(agentDir, "remote-agents.json"),
  );
  // The store is created up front (it performs no I/O until it is used) so a
  // session can tell, without SSH, whether any remote job is tracked.
  const store = new RemoteJobStore(
    path.join(agentDir, "remote-agents", "jobs.json"),
  );
  let managerPromise: Promise<RemoteAgentManager> | undefined;
  let manager: RemoteAgentManager | undefined;
  let closed = false;
  let ui: ExtensionUIContext | undefined;
  // The Pi session id of the current session. Jobs spawned here record it as
  // their owner, and only that session (resumed with the same id) delivers
  // their results.
  let sessionId: string | undefined;
  let unsubscribe: (() => void) | undefined;
  // Incremented on every session_start. Async continuations capture the value
  // when they start and bail when it changes: after session replacement or
  // reload their captured ctx/pi are stale and must never be touched.
  let sessionGeneration = 0;

  const updateStatus = () => {
    if (!ui || !manager) return;
    ui.setStatus(
      "remote-agents",
      remoteActivityStatus(ui.theme, manager.list()),
    );
  };

  /**
   * Report a delivery failure only while the originating session is still
   * current. `console.error` would write into the TUI and a captured `ui`
   * context is stale after a reload, so both are bounded by generation.
   */
  const notifyDeliveryFailure = (
    startedGeneration: number,
    kind: string,
    error: unknown,
  ) => {
    if (closed || sessionGeneration !== startedGeneration) return;
    const message = error instanceof Error ? error.message : String(error);
    ui?.notify(`Remote ${kind} delivery failed: ${message}`, "error");
  };

  /**
   * Deliver one settled run. The atomic claim prevents two live managers (or
   * two sessions) from both sending the same result, but it cannot make
   * `pi.sendMessage` and this external registry commit atomically: a process
   * crash between the send and `settle*Delivery` can still redeliver once. That
   * is a bounded, at-least-once window, not a promise of crash-proof
   * exactly-once delivery.
   */
  const deliverCompletion = async (snapshot: RemoteAgentSnapshot) => {
    if (!manager || !manager.owns(snapshot)) return;
    const owningManager = manager;
    const startedGeneration = sessionGeneration;
    const generation = snapshot.generation;
    let claimed = false;
    let settled = false;
    try {
      // Herdr can report the Pi turn settled just before post-run integrations
      // finish updating the terminal/session file.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      // The session was replaced/reloaded while delivery was pending: the
      // captured manager is disposed and pi is stale — drop delivery silently.
      if (closed || sessionGeneration !== startedGeneration) return;
      // Refresh BEFORE claiming: the lease is held only across the synchronous
      // send, never across an SSH round-trip where it could expire and be taken
      // by another manager.
      await owningManager
        .refresh(snapshot.id, { transcript: true })
        .catch(() => snapshot);
      const latest = owningManager.get(snapshot.id) ?? snapshot;
      if (
        latest.generation !== generation ||
        isRemoteAgentActive(latest.status) ||
        !owningManager.owns(latest)
      ) {
        return;
      }
      // The claim is the LAST await before the send: after it resolves, only
      // synchronous work runs until pi.sendMessage.
      claimed = await owningManager.claimCompletionDelivery(
        snapshot.id,
        generation,
      );
      if (!claimed) return;
      // session_shutdown may have run while the claim awaited; re-check the
      // live session, generation and ownership synchronously.
      const current = owningManager.get(snapshot.id) ?? latest;
      if (
        closed ||
        sessionGeneration !== startedGeneration ||
        current.generation !== generation ||
        isRemoteAgentActive(current.status) ||
        !owningManager.owns(current)
      ) {
        return;
      }
      pi.sendMessage(
        {
          customType: "remote-agent-result",
          content: completionMessage(current),
          display: true,
          details: {
            id: current.id,
            title: current.title,
            status: current.status,
          },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      await owningManager.settleCompletionDelivery(current.id, generation);
      settled = true;
    } catch (error) {
      notifyDeliveryFailure(startedGeneration, "completion", error);
    } finally {
      // A dropped or failed delivery must not strand the run behind a claim.
      if (claimed && !settled)
        await owningManager
          .releaseCompletionDelivery(snapshot.id)
          .catch(() => {});
    }
  };

  const deliverBlocked = async (snapshot: RemoteAgentSnapshot) => {
    if (!manager || !manager.owns(snapshot)) return;
    const owningManager = manager;
    const startedGeneration = sessionGeneration;
    const generation = snapshot.generation;
    let claimed = false;
    let settled = false;
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      // The session was replaced/reloaded while delivery was pending: the
      // captured manager is disposed and pi is stale — drop delivery silently.
      if (closed || sessionGeneration !== startedGeneration) return;
      // Refresh before the claim; see `deliverCompletion`.
      await owningManager
        .refresh(snapshot.id, { transcript: true })
        .catch(() => snapshot);
      const latest = owningManager.get(snapshot.id) ?? snapshot;
      if (
        latest.generation !== generation ||
        latest.status !== "blocked" ||
        !owningManager.owns(latest)
      ) {
        return;
      }
      claimed = await owningManager.claimBlockedDelivery(
        snapshot.id,
        generation,
      );
      if (!claimed) return;
      const current = owningManager.get(snapshot.id) ?? latest;
      if (
        closed ||
        sessionGeneration !== startedGeneration ||
        current.generation !== generation ||
        current.status !== "blocked" ||
        !owningManager.owns(current)
      ) {
        return;
      }
      const question =
        current.finalText?.trim() ||
        current.transcript.trim().slice(-RESULT_TRANSCRIPT_CHARS) ||
        "The remote agent is waiting for clarification.";
      pi.sendMessage(
        {
          customType: "remote-agent-blocked",
          content: `Remote agent ${current.id} "${current.title}" needs input.\n\n${question}\n\nRespond with remote_send or open /remotes.`,
          display: true,
          details: {
            id: current.id,
            title: current.title,
            status: current.status,
          },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      await owningManager.settleBlockedDelivery(current.id, generation);
      settled = true;
    } catch (error) {
      notifyDeliveryFailure(startedGeneration, "blocked", error);
    } finally {
      if (claimed && !settled)
        await owningManager.releaseBlockedDelivery(snapshot.id).catch(() => {});
    }
  };

  const getManager = () => {
    if (managerPromise) return managerPromise;
    const startedGeneration = sessionGeneration;
    const promise = (async () => {
      const transport = new SshTransport(config);
      const client = new HerdrClient(transport);
      const next = new RemoteAgentManager(config, client, store, {
        sessionId,
      });
      next.setOnSettled((snapshot) => void deliverCompletion(snapshot));
      next.setOnBlocked((snapshot) => void deliverBlocked(snapshot));
      next.setOnWarning((message) => {
        // Warnings can outlive the session that started the manager, and the
        // captured ui context would be stale by then.
        if (closed || sessionGeneration !== startedGeneration) return;
        ui?.notify(message, "warning");
      });
      manager = next;
      unsubscribe?.();
      unsubscribe = next.view.subscribe(updateStatus);
      await next.initialize();
      if (closed || sessionGeneration !== startedGeneration) {
        // The session was shut down or replaced while initialization was in
        // flight. Dispose the manager and report the expected
        // closed-during-init outcome; the session_start caller suppresses it.
        next.dispose();
        throw new Error(
          "Remote agent extension session closed during initialization",
        );
      }
      updateStatus();
      return next;
    })().catch((error) => {
      // Clear only the promise this failure belongs to. A replacement session
      // may have started its own manager while this one was in flight.
      if (managerPromise === promise) managerPromise = undefined;
      throw error;
    });
    managerPromise = promise;
    return managerPromise;
  };

  pi.on("session_start", (_event, ctx) => {
    closed = false;
    const startedGeneration = ++sessionGeneration;
    sessionId = ctx.sessionManager.getSessionId();
    if (ctx.hasUI) ui = ctx.ui;
    if (ctx.mode !== "tui") return;
    // Every Herdr child is a full Pi process that loads this extension. A
    // child never owns a remote job or its delivery, so it must not
    // auto-initialize the manager (and its SSH round-trips) on startup.
    if (process.env.PI_SUBAGENT === "1") return;
    // Every child Herdr agent is a full Pi process that loads this extension.
    // Initializing the manager with nothing to reconcile would still upload the
    // remote helper and ping it over SSH, per process, for no benefit. Real
    // work (commands, tools, completion delivery) still creates it on demand.
    // A registry that cannot be read reports tracked jobs and keeps the old
    // behavior instead of silently dropping them.
    if (!store.hasTrackedJobs()) return;
    void getManager().catch((error) => {
      // Initialization was still in flight when the session was shut down or
      // replaced: this captured ctx is stale (the runner was invalidated) and
      // the failure is expected teardown, so stay silent. Only surface
      // genuine failures while this session is still current.
      if (closed || sessionGeneration !== startedGeneration) return;
      ctx.ui.notify(
        `Remote agents unavailable: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    });
  });

  pi.on("session_shutdown", async () => {
    closed = true;
    unsubscribe?.();
    unsubscribe = undefined;
    ui?.setStatus("remote-agents", undefined);
    ui = undefined;
    manager?.dispose();
    manager = undefined;
    managerPromise = undefined;
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
      const meta = [details?.id ?? "remote", details?.title, details?.status]
        .filter(Boolean)
        .join(" · ");
      return remoteMessageCard({
        theme,
        expanded,
        icon,
        label: "Remote result",
        meta,
        content:
          typeof message.content === "string"
            ? message.content
            : "Remote agent completed",
      });
    },
  );

  pi.registerMessageRenderer(
    "remote-agent-blocked",
    (message, { expanded }, theme) => {
      const details = message.details as
        { id?: string; title?: string } | undefined;
      const meta = [details?.id ?? "remote", details?.title, "needs input"]
        .filter(Boolean)
        .join(" · ");
      return remoteMessageCard({
        theme,
        expanded,
        icon: theme.fg("warning", "?"),
        label: "Remote input",
        meta,
        content:
          typeof message.content === "string"
            ? message.content
            : "Remote agent needs input",
      });
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

  const openRemoteWindow = async (
    snapshot: RemoteAgentSnapshot,
    ctx: ExtensionContext,
    force = false,
  ) => {
    try {
      await openRemoteUi(config, snapshot.title, force);
    } catch (error) {
      ctx.ui.notify(
        `Remote agent started, but the Herdr window could not be opened: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  };

  const spawnPrepared = async (
    prepared: Awaited<ReturnType<typeof prepareRemote>>,
    ctx: ExtensionContext,
  ) => {
    const snapshot = await prepared.remote.spawn(prepared.spawn);
    await openRemoteWindow(snapshot, ctx);
    return snapshot;
  };

  const startRemote = async (
    instructions: string,
    ctx: ExtensionContext,
    options: Parameters<typeof prepareRemote>[2] = {},
  ) => {
    const prepared = await prepareRemote(instructions, ctx, options);
    return spawnPrepared(prepared, ctx);
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
          spawnPrepared(
            {
              ...prepared,
              spawn: { ...prepared.spawn, signal: loader.signal },
            },
            ctx,
          )
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
      ctx.ui.notify(
        `Started ${snapshot.id} on macmini and opened its remote Herdr window`,
        "info",
      );
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
    await openRemotePicker(ctx, remote.view, async (id) => {
      const snapshot = remote.get(id);
      if (!snapshot) {
        ctx.ui.notify(`Remote agent ${id} no longer exists`, "warning");
        return;
      }
      await openRemoteWindow(snapshot, ctx, true);
    });
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
      const suffix = result.closeFailures.length
        ? `; ${result.closeFailures.length} Herdr workspace${result.closeFailures.length === 1 ? "" : "s"} could not be closed`
        : "";
      ctx.ui.notify(
        `Removed ${result.removed.length} stale remote workspaces${suffix}`,
        result.closeFailures.length ? "warning" : "info",
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
      // An explicit check is the user adopting a legacy (unowned) job; a job
      // owned by another session is left alone.
      await remote.adopt(params.id);
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
      await remote.adopt(params.id);
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
      await remote.adopt(params.id);
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
      await remote.adopt(params.id);
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
