/**
 * Subagents — spawn background subagents on Pi or Codex, unified behind a
 * single Effect service interface.
 *
 * Tools (for the parent LLM):
 * - subagent_spawn: fire-and-forget spawn (prompt, title, agent, working_dir,
 *   model, reasoning_effort). Max 4 running at once across all backends.
 * - subagent_wait: block until the listed subagents settle, return results.
 * - subagent_cancel: stop one or more running subagents.
 * - subagent_check: peek at a subagent's status and recent activity.
 * - subagent_list: list all subagents.
 *
 * Unawaited subagents queue their result as a follow-up message when they
 * settle. `/subagents` opens a picker + full interactive takeover view.
 *
 * Architecture: Effect v4 generators throughout (backends -> manager ->
 * runtime); this file is the async boundary where tool handlers run effects
 * against one shared ManagedRuntime. Both backends are real: Pi runs
 * in-process SDK sessions and Codex speaks JSON-RPC to a scoped
 * `codex app-server` process.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getAgentDir,
  getMarkdownTheme,
  ProjectTrustStore,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadNamingConfig } from "../auto-naming/src/config.ts";
import { generateTaskTitle } from "../auto-naming/src/title-generator.ts";
import {
  btwStatusLabel,
  deriveBtwTitle,
  isModelVisible,
} from "./src/by-the-way.ts";
import {
  clearMergedCache,
  loadConfigMerged,
  loadSubagentsConfig,
  resolveProfileBehavior,
  resolveSpawnOptions,
  type SubagentsConfig,
} from "./src/config.ts";
import {
  BACKEND_NAMES,
  formatElapsed,
  latestText,
  REASONING_EFFORTS,
  type SpawnChildFn,
  type SubagentSnapshot,
} from "./src/domain.ts";
import {
  formatActivityStatus,
  formatCompactTokens,
  formatContextUtilization,
  isStalled,
} from "./src/format.ts";
import {
  SubagentManager,
  type CancelResult,
  type SubagentManagerShape,
} from "./src/manager.ts";
import { registerSubagentName, resolveSubagentTarget } from "./src/naming.ts";
import {
  buildChildPrompt,
  loadProfileSystemPrompt,
  nestingAllowed,
  toolPolicyFor,
} from "./src/profile.ts";
import {
  buildSubagentResultMessage,
  buildSubagentSendResult,
  buildSubagentSpawnResult,
  SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CANCEL_TOOL_DESCRIPTION,
  SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CHECK_TOOL_DESCRIPTION,
  SUBAGENT_LIST_TOOL_DESCRIPTION,
  SUBAGENT_SEND_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SEND_TOOL_DESCRIPTION,
  SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_PROMPT_SNIPPET,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
  SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS,
  SUBAGENT_WAIT_TOOL_DESCRIPTION,
} from "./src/prompt.ts";
import { createDeferredResultDelivery } from "./src/result-delivery.ts";
import {
  createSubagentRuntime,
  runTool,
  type SubagentRuntime,
} from "./src/runtime.ts";
import { openSubagentPicker, openSubagentTakeover } from "./src/ui/takeover.ts";
import {
  workerWorkspaceForSession,
  disposeWorkerWorkspace,
} from "../shared/herdr-workspace.ts";
import {
  setHerdrWorkerSessionDirRoot,
  setHerdrWorkerSpecDirRoot,
  setHerdrWorkerWorkspace,
} from "./src/backends/herdr-worker.ts";

const SUBAGENT_OUTPUT_MAX_BYTES = 24 * 1024;
const WAIT_OUTPUT_MAX_BYTES = 48 * 1024;
const WAIT_PER_AGENT_MAX_BYTES = 16 * 1024;

interface BtwResultData {
  readonly id: string;
  readonly title: string;
  readonly status: SubagentSnapshot["status"];
  readonly errorText?: string;
  readonly prompt: string;
  readonly answer: string;
  readonly sessionFilePath?: string;
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line) ?? ""
  );
}

function describeSubagent(snap: SubagentSnapshot) {
  const details = [
    `${snap.backend}: ${snap.meta.modelLabel ?? "?"}`,
    formatContextUtilization(snap.usage),
    formatElapsed(snap),
    snap.cwd,
  ].filter(Boolean);
  let text = `${snap.id} [${snap.status}] "${snap.title}" (${details.join(", ")})`;
  if (snap.question) text += `\n❓ ${snap.question.text}`;
  return text;
}

function truncatedOutput(
  snap: SubagentSnapshot,
  maxBytes = SUBAGENT_OUTPUT_MAX_BYTES,
): string {
  const output = snap.finalText || "(no output)";
  const truncation = truncateHead(output, {
    maxBytes: Math.min(maxBytes, DEFAULT_MAX_BYTES),
    maxLines: Math.min(600, DEFAULT_MAX_LINES),
  });
  let text = truncation.content;
  if (truncation.truncated) {
    text += `\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)} shown. Full transcript in session file: ${snap.meta.sessionFilePath ?? "?"}]`;
  }
  return text;
}

/**
 * Same-directory children inherit the live parent decision. An alternate cwd
 * is trusted only when pi's persisted trust store explicitly trusts it (or a
 * containing directory); unreadable/invalid trust data fails closed.
 */
function resolveChildProjectTrust(options: {
  parentCwd: string;
  childCwd: string;
  parentTrusted: boolean;
}) {
  const canonical = (value: string) => {
    const resolved = path.resolve(value);
    try {
      return fs.realpathSync.native(resolved);
    } catch {
      return resolved;
    }
  };
  const childCwd = canonical(options.childCwd);
  if (childCwd === canonical(options.parentCwd)) {
    return options.parentTrusted;
  }
  try {
    const trustStore = new ProjectTrustStore(getAgentDir());
    return trustStore.get(childCwd) === true;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  const subagentConfig = loadSubagentsConfig(
    path.join(getAgentDir(), "subagents.json"),
  );
  const profileNames = Object.keys(subagentConfig.profiles);
  const profileSummary =
    profileNames.length > 0 ? profileNames.join(", ") : "none";
  let runtime: SubagentRuntime | undefined;
  let managerPromise: Promise<SubagentManagerShape> | undefined;
  let sessionContext: ExtensionContext | undefined;
  let ui: ExtensionUIContext | undefined;
  let unsubStatus: (() => void) | undefined;
  const resultDelivery = createDeferredResultDelivery<SubagentSnapshot>(
    (snap) => `${snap.id}:${snap.run}`,
  );
  /** Session-scoped friendly names (optional `name` at spawn) → id. */
  const subagentNames = new Map<string, string>();
  let stallTimer: ReturnType<typeof setInterval> | undefined;

  const getRuntime = () =>
    (runtime ??= createSubagentRuntime({
      maxRunning: subagentConfig.maxConcurrent,
    }));

  /** Project-aware config: global subagents.json merged with the project
   * overlay at the given cwd (`.pi/subagents.json`), cached per cwd. */
  const configFor = (cwd: string) => loadConfigMerged(subagentConfig, cwd);

  /** Resolve the manager service once per runtime and wire the extension hooks. */
  const getManager = () => {
    managerPromise ??= getRuntime()
      .runPromise(SubagentManager)
      .then((manager) => {
        manager.view.setOnSettled(onSettled);
        unsubStatus?.();
        unsubStatus = manager.view.subscribe(() => updateStatus(manager));
        updateStatus(manager);
        return manager;
      });
    return managerPromise;
  };

  /** Build the in-process nested-spawn callback threaded to children via
   * `parent.spawnChild`. Enforces the caller's allowlist/depth budget here
   * (defense in depth — the child tool also forwards the request through this
   * single closure), applies the target profile's system prompt/tool policy,
   * and waits for the grandchild before returning its output. */
  const makeNestedSpawn = (base: {
    parentCwd: string;
    projectTrusted: boolean;
    parentSessionId?: string;
    inheritedModel?: { provider: string; id: string };
    inheritedThinkingLevel?: string;
    modelRegistry?: ModelRegistry;
    config: SubagentsConfig;
  }): SpawnChildFn => {
    const fn: SpawnChildFn = async ({
      profile,
      task: childTask,
      name,
      nest,
    }) => {
      if (!nestingAllowed(nest, profile)) {
        return {
          id: "?",
          text: "",
          error: `Profile "${profile}" is not allowed here or exceeds the nesting depth.`,
        };
      }
      const resolved = resolveSpawnOptions(base.config, { profile });
      const behavior = resolveProfileBehavior(base.config.profiles[profile]);
      const systemPrompt = loadProfileSystemPrompt(getAgentDir(), behavior);
      const childNest =
        behavior.allowChildren.length > 0
          ? {
              allow: behavior.allowChildren,
              depth: nest.depth + 1,
              maxDepth: behavior.maxDepth,
            }
          : undefined;
      const title = await generateTaskTitle({
        modelRegistry: base.modelRegistry,
        config: loadNamingConfig(),
        prompt: childTask,
        hint: name,
        fallback:
          name?.trim().slice(0, 160) ||
          firstLine(childTask) ||
          "child subagent",
      });
      const manager = await getManager();
      const snap = await runTool(
        getRuntime(),
        manager.spawn(resolved.harness, {
          origin: "model",
          prompt: buildChildPrompt({
            prompt: childTask,
            systemPrompt,
            contextMode: behavior.contextMode,
            parentCwd: base.parentCwd,
            parentSessionId: base.parentSessionId,
          }),
          title,
          cwd: base.parentCwd,
          model: resolved.model,
          reasoningEffort: resolved.reasoningEffort,
          parent: {
            ...base,
            toolPolicy: toolPolicyFor(behavior),
            nest: childNest,
            spawnChild: childNest ? fn : undefined,
          },
        }),
        { interruptMessage: "Nested subagent aborted." },
      );
      if (name?.trim()) registerSubagentName(subagentNames, name, snap.id);
      const settled = await runTool(getRuntime(), manager.waitFor([snap.id]), {
        interruptMessage: "Nested subagent wait aborted.",
      });
      // The grandchild's terminal result returns inline to the spawning
      // child, so suppress the redundant automatic root follow-up.
      resultDelivery.consumeResults(settled);
      const finalSnap = settled[0];
      return {
        id: snap.id,
        text: finalSnap?.finalText ?? "",
        error:
          finalSnap && finalSnap.status === "error"
            ? finalSnap.errorText
            : undefined,
      };
    };
    return fn;
  };

  const updateStatus = (manager: SubagentManagerShape) => {
    if (!ui) return;
    const subs = manager.view.list();
    if (subs.length === 0) {
      ui.setStatus("subagents", undefined);
      return;
    }
    const running = subs.filter((snap) => snap.status === "running").length;
    const failed = subs.filter((snap) => snap.status === "error").length;
    const done = subs.length - running - failed;
    const questions = subs.filter((snap) => snap.question !== undefined).length;
    const stalled = subs.filter((snap) => isStalled(snap)).length;
    ui.setStatus(
      "subagents",
      formatActivityStatus(ui.theme, {
        running,
        done,
        failed,
        questions,
        stalled,
      }),
    );
  };

  /** Read only the tail of a session JSONL so restoring many (possibly
   * multi-MB) workers at startup reads bounded I/O. */
  const readFileTail = (filePath: string, maxBytes: number): string => {
    const fd = fs.openSync(filePath, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - maxBytes);
      const length = size - start;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      const tail = buffer.toString("utf8");
      // Drop a partial first line (truncated mid-entry) — the rest is intact.
      const newline = tail.indexOf("\n");
      return newline >= 0 ? tail.slice(newline + 1) : tail;
    } finally {
      fs.closeSync(fd);
    }
  };

  /** Parse the final assistant text/error from a persisted worker session
   * JSONL (best-effort, tail-bounded). */
  const summaryFromSessionFile = (filePath: string) => {
    let finalText = "";
    let errorText: string | undefined;
    let settledAt = 0;
    try {
      for (const line of readFileTail(filePath, 256 * 1024).split("\n")) {
        if (!line.trim()) continue;
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const record = entry as {
          type?: string;
          timestamp?: number;
          message?: {
            role?: string;
            content?: Array<{ type?: string; text?: string }>;
            stopReason?: string;
            errorMessage?: string;
            timestamp?: number;
          };
        };
        if (record.type !== "message" || record.message?.role !== "assistant")
          continue;
        const text = (record.message.content ?? [])
          .filter((block) => block.type === "text")
          .map((block) => block.text ?? "")
          .join("\n");
        if (text) finalText = text;
        if (record.message.stopReason === "error") {
          errorText = record.message.errorMessage ?? "Restored run failed";
        }
        const ts = record.timestamp ?? record.message.timestamp ?? 0;
        if (ts) settledAt = ts;
      }
    } catch {
      // unreadable session → skip adoption
    }
    return { finalText, errorText, settledAt };
  };

  /** Re-surface persisted children of a previous pi session as inspect-only
   * entries (dashboard, subagent_check). Resume after restart is not wired
   * for restored entries — send() explains how to take over in a pane. */
  const restoreWorkers = async (parentSessionId: string) => {
    const root = path.join(
      getAgentDir(),
      "sessions",
      "workers",
      parentSessionId,
    );
    let dirs: string[] = [];
    try {
      dirs = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => path.join(root, dirent.name));
    } catch {
      return; // no previous session persisted
    }
    const manager = await getManager();
    for (const dir of dirs) {
      const id = path.basename(dir);
      if (manager.view.get(id)) continue;
      const files = fs
        .readdirSync(dir)
        .filter((file) => file.endsWith(".jsonl"))
        .sort();
      const filePath = files.length
        ? path.join(dir, files[files.length - 1])
        : undefined;
      if (!filePath) continue;
      const { finalText, errorText, settledAt } =
        summaryFromSessionFile(filePath);
      try {
        await runTool(
          getRuntime(),
          manager.adopt({
            id,
            title: `Restored ${id}`,
            backend: "pi",
            finalText,
            errorText,
            sessionFilePath: filePath,
            settledAt: settledAt || Date.now(),
          }),
        );
      } catch {
        // adopt is best-effort; keep the previous session intact
      }
    }
  };

  const deliverResult = (snap: SubagentSnapshot) => {
    const usageText = (() => {
      const { tokens, contextWindow } = snap.usage ?? {};
      if (tokens === undefined && contextWindow === undefined) return undefined;
      const parts: string[] = [];
      if (tokens !== undefined) parts.push(`↑${formatCompactTokens(tokens)}`);
      const ctx = formatContextUtilization({ tokens, contextWindow });
      if (ctx) parts.push(ctx);
      return parts.join(" · ");
    })();
    pi.sendMessage(
      {
        customType: "subagent-result",
        content: buildSubagentResultMessage({
          id: snap.id,
          title: snap.title,
          status: snap.status,
          errorText: snap.errorText,
          output: truncatedOutput(snap),
          question: snap.question?.text,
          usageText,
        }),
        display: true,
        details: { id: snap.id, title: snap.title, status: snap.status },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  const flushResults = () => {
    for (const snap of resultDelivery.drain()) deliverResult(snap);
  };

  const deliverBtwEntry = (entry: {
    id: string;
    title: string;
    status: SubagentSnapshot["status"];
    errorText?: string;
    prompt: string;
    answer: string;
  }) => {
    // appendEntry is a synchronous SessionManager operation and emits an
    // entry_appended event, so it is safe while the parent is streaming and
    // never enters the model's context or follow-up queue.
    pi.appendEntry<BtwResultData>("btw-result", {
      id: entry.id,
      title: entry.title,
      status: entry.status,
      errorText: entry.errorText,
      prompt: entry.prompt,
      answer: entry.answer,
    });
  };

  const deliverBtwResult = (snap: SubagentSnapshot) => {
    deliverBtwEntry({
      id: snap.id,
      title: snap.title,
      status: snap.status,
      errorText: snap.errorText,
      prompt: snap.prompt,
      answer: truncatedOutput(snap),
    });
    ui?.notify(
      snap.status === "error"
        ? `by the way “${snap.title}” failed — reopen it with /subagents`
        : `by the way “${snap.title}” answered — reopen it with /subagents`,
      snap.status === "error" ? "error" : "info",
    );
  };

  const onSettled = (snap: SubagentSnapshot, consumed: boolean) => {
    // A shutdown can settle children while disposing their scopes. Never
    // append into a session whose extension runtime is already closing.
    if (!sessionContext) return;
    if (snap.origin === "btw") {
      deliverBtwResult({ ...snap, meta: { ...snap.meta } });
      return;
    }
    // Always retain a copy until a collector successfully returns it. An
    // active wait/cancel is only a provisional claim: if that tool is aborted
    // after settlement, automatic delivery must still have the result.
    // The live snapshot can mutate if the same session is restarted, so defer
    // an immutable top-level/meta copy for each settled run.
    resultDelivery.defer(structuredClone(snap));
    if (!consumed && sessionContext?.isIdle()) flushResults();
  };

  pi.on("session_start", (_event, ctx) => {
    sessionContext = ctx;
    if (ctx.hasUI) ui = ctx.ui;
    // One ephemeral "Pi Workers" workspace per parent pi session, shared via
    // the process-wide singleton with the background-terminals extension; the
    // Herdr worker backend allocates its Subagents tab lazily on first spawn.
    setHerdrWorkerWorkspace(
      workerWorkspaceForSession(
        path.basename(ctx.cwd),
        ctx.sessionManager.getSessionId() ?? "session",
        ctx.cwd,
      ),
    );
    // Named Pi sessions persist under the normal agent sessions tree —
    // <agentDir>/sessions/workers/<parent session>/<sa-id> — and are NEVER
    // deleted on scope close/prune, so children stay discoverable/resumable
    // (take-over reopens with `pi --session`). Launcher specs stay transient
    // under tmp and are cleaned after launch / at scope close.
    const parentSessionId = ctx.sessionManager.getSessionId();
    setHerdrWorkerSessionDirRoot(
      path.join(
        getAgentDir(),
        "sessions",
        "workers",
        parentSessionId ?? "session",
      ),
    );
    setHerdrWorkerSpecDirRoot(path.join(getAgentDir(), "tmp", "worker-specs"));
    // Project-local profiles may have changed on disk; drop the per-cwd
    // merged-config cache so the rest of this session sees the overlay.
    clearMergedCache();
    // Refresh the footer stalled badge while anything is running (the
    // event-driven updateStatus alone would stop after the last event). Only
    // start the ticker with a UI, and skip ticks with no running subagents
    // so a long idle session does zero per-tick work.
    if (ctx.hasUI) {
      stallTimer = setInterval(() => {
        managerPromise
          ?.then((manager) => {
            if (!manager.view.list().some((s) => s.status === "running"))
              return;
            updateStatus(manager);
          })
          .catch(() => {});
      }, 20_000);
    }
    // Re-surface children of a previous pi session (same parent id) that are
    // persisted under the workers dir: inspect-only entries in the dashboard.
    void restoreWorkers(parentSessionId ?? "session");
  });

  pi.on("agent_settled", flushResults);

  pi.on("session_shutdown", async () => {
    sessionContext = undefined;
    resultDelivery.clear();
    subagentNames.clear();
    if (stallTimer !== undefined) {
      clearInterval(stallTimer);
      stallTimer = undefined;
    }
    unsubStatus?.();
    unsubStatus = undefined;
    ui?.setStatus("subagents", undefined);
    ui = undefined;
    const closing = runtime;
    runtime = undefined;
    managerPromise = undefined;
    // Disposing the runtime runs the manager finalizer, which tears down all
    // subagent scopes (and, later, their real child processes).
    await closing?.dispose();
    // Close the Herdr worker workspace (bounded) and forget the session's
    // worker wiring; targets keep running until the workspace closes.
    setHerdrWorkerWorkspace(undefined);
    setHerdrWorkerSessionDirRoot(undefined);
    setHerdrWorkerSpecDirRoot(undefined);
    await disposeWorkerWorkspace();
  });

  // --- Tools -------------------------------------------------------------

  pi.registerTool({
    name: "subagent_spawn",
    label: "Spawn Subagent",
    description: `${SUBAGENT_SPAWN_TOOL_DESCRIPTION} Configured profiles: ${profileSummary}. Maximum concurrent runs: ${subagentConfig.maxConcurrent}.`,
    promptSnippet: SUBAGENT_SPAWN_PROMPT_SNIPPET,
    promptGuidelines: [
      ...SUBAGENT_SPAWN_PROMPT_GUIDELINES,
      `Prefer a configured profile when it matches the task. Available profiles: ${profileSummary}.`,
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.prompt,
      }),
      name: Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.name,
      }),
      profile: Type.Optional(
        Type.String({
          description: `${SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.profile} Available: ${profileSummary}.`,
        }),
      ),
      harness: Type.Optional(
        StringEnum(BACKEND_NAMES, {
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.harness,
        }),
      ),
      working_dir: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.workingDir,
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.model,
        }),
      ),
      reasoning_effort: Type.Optional(
        StringEnum(REASONING_EFFORTS, {
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.reasoningEffort,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const manager = await getManager();
      const config = configFor(ctx.cwd);
      const behavior = resolveProfileBehavior(
        params.profile ? config.profiles[params.profile] : undefined,
      );
      const resolved = resolveSpawnOptions(config, {
        profile: params.profile,
        harness: params.harness,
        model: params.model,
        reasoningEffort: params.reasoning_effort,
      });
      const harness = resolved.harness;

      const cwd = path.resolve(
        ctx.cwd,
        params.working_dir ?? behavior.cwd ?? ".",
      );
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`working_dir is not a directory: ${cwd}`);
      }

      const title = await generateTaskTitle({
        modelRegistry: ctx.modelRegistry,
        config: loadNamingConfig(),
        prompt: params.prompt,
        hint: params.name,
        fallback: params.name.trim().slice(0, 160) || "subagent",
        signal,
      });
      const systemPrompt = loadProfileSystemPrompt(getAgentDir(), behavior);
      const toolPolicy = toolPolicyFor(behavior);
      const nest =
        behavior.allowChildren.length > 0
          ? {
              allow: behavior.allowChildren,
              depth: 0,
              maxDepth: behavior.maxDepth,
            }
          : undefined;
      const parentBase = {
        parentCwd: ctx.cwd,
        projectTrusted: resolveChildProjectTrust({
          parentCwd: ctx.cwd,
          childCwd: cwd,
          parentTrusted: ctx.isProjectTrusted(),
        }),
        parentSessionId: ctx.sessionManager.getSessionId() ?? undefined,
        inheritedModel: ctx.model
          ? { provider: ctx.model.provider, id: ctx.model.id }
          : undefined,
        inheritedThinkingLevel: pi.getThinkingLevel(),
        modelRegistry: ctx.modelRegistry,
        config,
      };
      const snap = await runTool(
        getRuntime(),
        manager.spawn(harness, {
          prompt: buildChildPrompt({
            prompt: params.prompt,
            systemPrompt,
            contextMode: behavior.contextMode,
            parentCwd: ctx.cwd,
            parentSessionId: parentBase.parentSessionId,
          }),
          title,
          cwd,
          model: resolved.model,
          reasoningEffort: resolved.reasoningEffort,
          parent: {
            ...parentBase,
            toolPolicy,
            nest,
            spawnChild: nest ? makeNestedSpawn(parentBase) : undefined,
          },
        }),
        { signal, interruptMessage: "Subagent spawn aborted." },
      );

      const friendlyName = params.name.trim()
        ? registerSubagentName(subagentNames, params.name, snap.id)
        : undefined;

      return {
        content: [
          {
            type: "text",
            text: buildSubagentSpawnResult({
              id: snap.id,
              title: snap.title,
              harness,
              modelLabel: snap.meta.modelLabel ?? "?",
              cwd,
            }),
          },
        ],
        details: {
          id: snap.id,
          title: snap.title,
          name: friendlyName,
          cwd,
          profile: resolved.profile,
          harness,
          model: snap.meta.modelLabel,
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_send",
    label: "Send to Subagent",
    description: SUBAGENT_SEND_TOOL_DESCRIPTION,
    parameters: Type.Object({
      target: Type.String({
        description: SUBAGENT_SEND_PARAMETER_DESCRIPTIONS.target,
      }),
      message: Type.String({
        minLength: 1,
        description: SUBAGENT_SEND_PARAMETER_DESCRIPTIONS.message,
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const manager = await getManager();
      const id = resolveSubagentTarget(params.target, subagentNames);
      const snap = manager.view.get(id);
      if (!snap || !isModelVisible(snap)) {
        const known = manager.view
          .list()
          .filter(isModelVisible)
          .map((s) => s.id);
        throw new Error(
          `Unknown subagent target "${params.target}" (resolved to "${id}"). Known: ${known.join(", ") || "none"}.`,
        );
      }
      await runTool(getRuntime(), manager.send(id, params.message), {
        signal,
        interruptMessage: "Subagent send aborted.",
      });
      return {
        content: [
          {
            type: "text",
            text: buildSubagentSendResult({
              target: params.target,
              id,
              title: snap.title,
              message: params.message,
              status: snap.status,
            }),
          },
        ],
        details: { id, title: snap.title, message: params.message },
      };
    },
  });

  // A child pi TUI (Herdr worker) loads this extension too. Inside a child
  // (PI_SUBAGENT=1) expose only ask_question, which writes the sidecar the
  // parent worker polls to surface QuestionAsked.
  if (process.env.PI_SUBAGENT === "1" && process.env.PI_SUBAGENT_ASK_FILE) {
    const askFile = process.env.PI_SUBAGENT_ASK_FILE;
    pi.registerTool({
      name: "ask_question",
      label: "Ask Orchestrator",
      description:
        "Ask the orchestrator (the parent agent that spawned you) a single freeform question and stop. The answer arrives as your next user message. Prefer asking over guessing.",
      promptSnippet:
        "When requirements are ambiguous, ask the orchestrator via ask_question and stop for the answer.",
      promptGuidelines: [
        "Ask exactly one question per call.",
        "Prefer ask_question over guessing implementation details.",
        "After asking, stop and wait for the answer.",
      ],
      parameters: Type.Object({
        question: Type.String({
          minLength: 1,
          maxLength: 4000,
          description:
            "The question for the orchestrator. Include enough context to answer without re-reading the whole task.",
        }),
      }),
      async execute(_toolCallId, params) {
        const data = { questionId: randomUUID(), text: params.question };
        fs.writeFileSync(askFile, `${JSON.stringify(data)}\n`, "utf8");
        return {
          content: [
            {
              type: "text",
              text: "Question sent to the orchestrator. Stop working and wait — the answer arrives as your next user message.",
            },
          ],
          details: {},
        };
      },
    });
  }

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Subagents",
    description: SUBAGENT_WAIT_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        maxItems: 64,
        description: SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one subagent id.");
      const known = manager.view
        .list()
        .filter(isModelVisible)
        .map((snap) => snap.id);
      const unknown = ids.filter((id) => {
        const snap = manager.view.get(id);
        return !snap || !isModelVisible(snap);
      });
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      let returnedSnapshots: ReadonlyArray<SubagentSnapshot>;
      try {
        returnedSnapshots = await runTool(
          getRuntime(),
          manager.waitFor(ids, (pending) => {
            onUpdate?.({
              content: [
                { type: "text", text: `Waiting for ${pending.join(", ")}...` },
              ],
              details: { pending },
            });
          }),
          { signal, interruptMessage: "Wait aborted. Subagents keep running." },
        );
      } catch (error) {
        // Aborted collector: interest was released, so the settlement stays
        // deferred. Flush now so an aborted wait cannot strand results until
        // the next agent_settled/idle event.
        if (sessionContext?.isIdle()) flushResults();
        throw error;
      }

      // Settlement may have happened before this wait began. Remove only the
      // exact run generations this tool is returning; older undelivered runs
      // with the same logical id remain queued in FIFO order.
      resultDelivery.consumeResults(returnedSnapshots);

      const returnedById = new Map(
        returnedSnapshots.map((snap) => [snap.id, snap] as const),
      );
      const sections: string[] = [];
      let remainingBytes = WAIT_OUTPUT_MAX_BYTES;
      for (const id of ids) {
        const snap = returnedById.get(id);
        if (!snap) {
          sections.push(`## ${id}\n\n(no longer tracked)`);
          continue;
        }
        const verb = snap.status === "error" ? "failed" : "finished";
        let section = `## ${snap.id} "${snap.title}" ${verb}`;
        if (snap.errorText) section += `\nError: ${snap.errorText}`;
        const headerBytes = Buffer.byteLength(section, "utf8") + 2;
        const outputBudget = Math.max(
          512,
          Math.min(WAIT_PER_AGENT_MAX_BYTES, remainingBytes - headerBytes),
        );
        section += `\n\n${truncatedOutput(snap, outputBudget)}`;
        const sectionBytes = Buffer.byteLength(section, "utf8");
        if (sectionBytes > remainingBytes) {
          sections.push(
            `## ${snap.id} "${snap.title}"\n\n[omitted: total wait output limit reached]`,
          );
          break;
        }
        sections.push(section);
        remainingBytes -= sectionBytes;
      }

      const combined = sections.join("\n\n---\n\n");
      const bounded = truncateHead(combined, {
        maxBytes: WAIT_OUTPUT_MAX_BYTES - 128,
        maxLines: DEFAULT_MAX_LINES,
      });
      const text = bounded.truncated
        ? `${bounded.content}\n\n[wait output truncated at the total output limit]`
        : bounded.content;
      return {
        content: [{ type: "text", text }],
        details: {
          results: ids.map((id) => {
            const snap = returnedById.get(id);
            return { id, title: snap?.title, status: snap?.status };
          }),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel Subagents",
    description: SUBAGENT_CANCEL_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        description: SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one subagent id.");

      const known = manager.view
        .list()
        .filter(isModelVisible)
        .map((snap) => snap.id);
      const unknown = ids.filter((id) => {
        const snap = manager.view.get(id);
        return !snap || !isModelVisible(snap);
      });
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      let report: ReadonlyArray<CancelResult>;
      try {
        report = await runTool(getRuntime(), manager.cancel(ids), {
          signal,
          interruptMessage: "Subagent cancellation aborted.",
        });
      } catch (error) {
        // Aborted cancellation: interest was released and the terminal
        // settlements remain deferred. Flush so they are still delivered.
        if (sessionContext?.isIdle()) flushResults();
        throw error;
      }
      // Cancellation committed successfully; suppress only the exact terminal
      // generations it actually cancelled (captured as immutable clones by
      // the manager). Older queued runs with the same logical id are
      // unrelated and must still be delivered.
      resultDelivery.consumeResults(
        report
          .filter((entry) => entry.cancelled)
          .map((entry) => entry.snapshot)
          .filter((snap): snap is SubagentSnapshot => snap !== undefined),
      );

      const lines = report.map((entry) =>
        entry.cancelled
          ? `Cancelled ${entry.id} "${entry.title}".`
          : `${entry.id} "${entry.title}" was already ${entry.status}.`,
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          results: report.map((entry) => ({
            id: entry.id,
            title: entry.title,
            status: entry.status,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_check",
    label: "Check Subagent",
    description: SUBAGENT_CHECK_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        description: SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS.id,
      }),
    }),
    async execute(_toolCallId, params) {
      const manager = await getManager();
      const snap = manager.view.get(params.id);
      if (!snap || !isModelVisible(snap)) {
        const known = manager.view
          .list()
          .filter(isModelVisible)
          .map((s) => s.id);
        throw new Error(
          `Unknown subagent id "${params.id}". Known: ${known.join(", ") || "none"}.`,
        );
      }

      let text = `${describeSubagent(snap)}\nTurns: ${snap.turns}`;
      if (snap.errorText) text += `\nError: ${snap.errorText}`;

      const output = latestText(snap);
      if (output) {
        const preview = truncateHead(output, { maxBytes: 2048, maxLines: 20 });
        text += `\n\nLatest output:\n${preview.content}`;
        if (preview.truncated) text += "\n[...]";
      } else if (snap.status === "running") {
        text += "\n\n(no text output yet)";
      }

      return {
        content: [{ type: "text", text }],
        details: { id: snap.id, status: snap.status, turns: snap.turns },
      };
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List Subagents",
    description: SUBAGENT_LIST_TOOL_DESCRIPTION,
    parameters: Type.Object({}),
    async execute() {
      const manager = await getManager();
      const subs = manager.view.list().filter(isModelVisible);
      const text =
        subs.length === 0
          ? "No subagents."
          : subs.map((snap) => describeSubagent(snap)).join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          subagents: subs.map((snap) => ({
            id: snap.id,
            title: snap.title,
            harness: snap.backend,
            status: snap.status,
          })),
        },
      };
    },
  });

  // --- Result message rendering ------------------------------------------

  pi.registerMessageRenderer(
    "subagent-result",
    (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as {
        id?: string;
        title?: string;
        status?: string;
      };
      const failed = details.status === "error";
      const icon = failed ? theme.fg("error", "x") : theme.fg("success", "■");
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(`subagent ${details.id ?? "?"}`)) +
        theme.fg(
          "muted",
          ` · ${details.title ?? ""} · ${failed ? "failed" : "finished"}`,
        );

      const content =
        typeof message.content === "string" ? message.content : "";
      // Remove only the summary line. The following Error line (when present)
      // is part of the actual result and must remain visible.
      const body = content.split("\n").slice(1).join("\n").trim();

      if (expanded) {
        const md = new Markdown(`${body}`, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        return {
          render: (width: number) => [
            ...container.render(width),
            ...md.render(width),
          ],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }

      const previewLines = body.split("\n").slice(0, 8);
      let text = header;
      for (const line of previewLines)
        text += `\n${theme.fg("toolOutput", line)}`;
      if (body.split("\n").length > 8)
        text += `\n${theme.fg("dim", "... (ctrl+o to expand)")}`;
      return new Text(text, 0, 0);
    },
  );

  pi.registerEntryRenderer<BtwResultData>(
    "btw-result",
    (entry, { expanded }, theme) => {
      const data = entry.data;
      const failed = data?.status === "error";
      const icon = failed ? theme.fg("error", "x") : theme.fg("success", "■");
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(`by the way · ${data?.title ?? "?"}`)) +
        theme.fg(
          "muted",
          ` · ${btwStatusLabel(data?.status)} · ${data?.id ?? "?"}`,
        );
      const body = [
        data?.errorText ? `Error: ${data.errorText}` : "",
        data?.answer ?? "(no answer)",
      ]
        .filter(Boolean)
        .join("\n\n");

      if (expanded) {
        const md = new Markdown(body, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        return {
          render: (width: number) => [
            ...container.render(width),
            ...md.render(width),
          ],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }

      const lines = body.split("\n");
      let text = header;
      for (const line of lines.slice(0, 8))
        text += `\n${theme.fg("toolOutput", line)}`;
      if (lines.length > 8)
        text += `\n${theme.fg("dim", "... (ctrl+o to expand)")}`;
      return new Text(text, 0, 0);
    },
  );

  // --- Commands -----------------------------------------------------------

  const runByTheWay = async (rawArgs: string, ctx: ExtensionCommandContext) => {
    if (ctx.mode !== "tui") {
      if (ctx.hasUI)
        ctx.ui.notify("by the way is only available in the TUI", "error");
      return;
    }

    let prompt = rawArgs.trim();
    if (!prompt) {
      const input = await ctx.ui.input("by the way", "Ask a one-off question…");
      prompt = input?.trim() ?? "";
      if (!prompt) return;
    }

    const manager = await getManager();
    const title = await generateTaskTitle({
      modelRegistry: ctx.modelRegistry,
      config: loadNamingConfig(),
      prompt,
      fallback: deriveBtwTitle(prompt),
    });

    // Always route through the manager. The Pi backend will choose a native
    // Herdr worker pane when available and otherwise use its headless session,
    // while preserving concurrency, cancellation, settlement, and cleanup.
    let snap: SubagentSnapshot;
    try {
      snap = await runTool(
        getRuntime(),
        manager.spawn("pi", {
          origin: "btw",
          prompt,
          title,
          cwd: ctx.cwd,
          parent: {
            parentCwd: ctx.cwd,
            projectTrusted: ctx.isProjectTrusted(),
            parentSessionId: ctx.sessionManager.getSessionId() ?? undefined,
            inheritedModel: ctx.model
              ? { provider: ctx.model.provider, id: ctx.model.id }
              : undefined,
            inheritedThinkingLevel: pi.getThinkingLevel(),
            modelRegistry: ctx.modelRegistry,
          },
        }),
      );
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
      return;
    }

    if (snap.meta.herdrPaneId) {
      ctx.ui.notify(
        `by the way “${title}” opened in Herdr pane ${snap.meta.herdrPaneId}`,
        "info",
      );
      return;
    }

    await openSubagentTakeover(ctx, manager.view, snap.id, {
      badge: "by the way",
    });
  };

  pi.registerCommand("btw", {
    description:
      "Ask a one-off side question while the main agent keeps working",
    handler: runByTheWay,
  });

  pi.registerCommand("subagents", {
    description: "List, inspect, and take over subagents",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI)
          ctx.ui.notify(
            "Subagent takeover is only available in the TUI",
            "error",
          );
        return;
      }
      const manager = await getManager();
      if (manager.view.size() === 0) {
        ctx.ui.notify(
          "No subagents yet. The agent spawns them with subagent_spawn.",
          "info",
        );
        return;
      }
      await openSubagentPicker(ctx, manager.view);
    },
  });
}
