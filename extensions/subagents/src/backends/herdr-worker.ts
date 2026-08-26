/**
 * Herdr-native subagent workers — the deep backend behind spawning Pi and
 * Codex subagents as *real interactive TUIs* in the shared "Pi Workers"
 * workspace's Subagents tab.
 *
 * How it works:
 * - The parent (this extension) opens a worker pane in the shared workspace
 *   (`openWorker` → explicit `pane run`, never `agent start`, which fails for
 *   npm shims on Windows) and launches the agent's TUI through the
 *   zero-dependency launcher (`extensions/shared/worker-launcher.mjs`): the
 *   pane runs ONLY `node <launcher> <spec.json>`, and the spec file carries
 *   the worker's RAW argv (spaces/unicode/quotes byte-exact — quoted argv
 *   through PowerShell Start-Process mangles `--name '[spike · pi] native'`
 *   into positional prompt fragments). Pi gets a generated session UUID + a
 *   private per-session dir; Codex is launched with no prompt at all.
 * - The initial prompt is submitted with the LOW-LEVEL pane transport
 *   `pane send-text <pane> <text>` then `pane send-keys <pane> enter`
 *   (never `agent prompt`, which fails for manually reported explicit-node
 *   Pi agents with `agent_not_ready: no longer pane foreground process`), a
 *   unique run marker prepended for Codex so the rollout that gets created
 *   can be matched uniquely (marker text + cwd from session_meta — never
 *   newest-mtime-only).
 * - The parent tails the native session file — Pi's deterministic session
 *   JSONL in its persistent session dir, Codex's discovered rollout JSONL —
 *   and translates lines into the existing normalized SubagentEvents.
 *   Completion is driven by the FILE only: Pi requires a NEW assistant
 *   message with stopReason stop/error/aborted after the prompt; Codex
 *   requires task_complete (turn_aborted → interrupted). Herdr idle alone
 *   never settles a run; a "worker exited" liveness probe (agent gone) is
 *   the only idle-independent failure fallback.
 * - send() steers an active run through the same send-text transport (Pi
 *   queues its own follow-ups; Codex follow-ups are queued locally and
 *   drained at settle) or, on a settled run, reopens a pane resuming the
 *   exact native session with the FULL launch policy — pi `--session`
 *   + model + thinking + exclusions + trust; codex `resume` + cwd + model
 *   + reasoning effort + sandbox + approval — prompts, and monitors the
 *   next run.
 * - takeOver() marks the session taken over (never interrupting), focuses
 *   the live pane, or — when settled with the pane closed — reopens and
 *   resumes the exact session and focuses it.
 * - Scope close stops the watchers, cleans the transient launcher specs,
 *   and closes the pane unless the user took it over; the persistent pi
 *   session dir is NEVER deleted here (sessions stay resumable; the
 *   workspace dispose at session shutdown closes what is left).
 *
 * Everything here is plain Node + Effect; the CLI/workspace surface is the
 * injectable `HerdrWorkerDeps` seam, so parsers/launchers/lifecycle are
 * unit-testable without a live Herdr server or TUI.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Cause, Effect, Scope } from "effect";
import { Effect as Eff, Queue, Stream } from "effect";
import type {
  WorkerPaneHandle,
  WorkerWorkspaceController,
} from "../../../shared/herdr-workspace.ts";
import { shellQuote } from "../../../shared/herdr-workspace.ts";
import type { SubagentSession } from "../backend.ts";
import type {
  ReasoningEffort,
  RunOutcome,
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
  TranscriptPart,
} from "../domain.ts";
import { SendError, SpawnError, subagentDisplayTitle } from "../domain.ts";

// --- Injectables ----------------------------------------------------------------

export interface HerdrWorkerDeps {
  /** The shared worker workspace controller (undefined outside Herdr). */
  readonly workspace: () => WorkerWorkspaceController | undefined;
  /** Absolute path to `extensions/shared/worker-launcher.mjs` (the pane runs
   * only `node <launcher> <spec.json>`). */
  readonly launcherPath: () => string;
  /** Root for the transient per-launch JSON spec files (cleaned after
   * launch + at scope close). */
  readonly specDirRoot: () => string;
  /** Absolute path to the pi CLI bundle (node entrypoint). */
  readonly piCliPath: () => Promise<string | undefined>;
  /** Absolute path to `@openai/codex/bin/codex.js` (node entrypoint). */
  readonly codexCliPath: () => Promise<string | undefined>;
  /** Root for persistent per-agent pi session dirs — never deleted on scope
   * close/prune; sessions stay discoverable and resumable. */
  readonly sessionDirRoot: () => string;
  /** Codex home directory containing `sessions/` and `rollouts/`. */
  readonly codexHome: () => string;
  /** File-polling interval (tailers + codex rollout discovery). */
  readonly pollIntervalMs: number;
  /** Interrupt fallback: local settle if the parser misses the abort. */
  readonly interruptFallbackMs: number;
  /** Liveness probe gap while a run produces no new file lines. Undefined →
   * never probe (tests) — production always probes. */
  readonly livenessProbeEveryMs: number | undefined;
  /** Clock + sleep seams (tests). */
  readonly clock?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const sleepReal = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The extension seeds the workspace + session-dir/spec-dir roots on session
 * start. */
let workerWorkspaceController: WorkerWorkspaceController | undefined;
let sessionDirRootOverride: string | undefined;
let specDirRootOverride: string | undefined;
let depsOverride: HerdrWorkerDeps | undefined;

/** The zero-dependency launcher next to this extension's shared module. */
const DEFAULT_LAUNCHER_PATH = fileURLToPath(
  new URL("../../../shared/worker-launcher.mjs", import.meta.url),
);

function defaultCodexHome(): string {
  return process.env.CODEX_HOME?.trim()
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
}

/** The active deps bundle. Extensions seed workspace()/sessionDirRoot. */
export function herdrWorkerDeps(): HerdrWorkerDeps {
  if (depsOverride) return depsOverride;
  return {
    workspace: () => workerWorkspaceController,
    launcherPath: () => DEFAULT_LAUNCHER_PATH,
    specDirRoot: () =>
      specDirRootOverride ??
      path.join(os.homedir(), ".pi", "agent", "tmp", "worker-specs"),
    piCliPath: resolvePiCliPath,
    codexCliPath: resolveCodexCliPath,
    sessionDirRoot: () =>
      sessionDirRootOverride ??
      path.join(os.homedir(), ".pi", "agent", "sessions", "workers", "session"),
    codexHome: defaultCodexHome,
    pollIntervalMs: 300,
    interruptFallbackMs: 2_500,
    livenessProbeEveryMs: 30_000,
  };
}

/** Extensions seed the shared worker workspace (same singleton terminals use). */
export function setHerdrWorkerWorkspace(
  controller: WorkerWorkspaceController | undefined,
): void {
  workerWorkspaceController = controller;
}

/** Extensions seed the private pi session dir root under the agent dir.
 * Sessions persist here and are never deleted on scope close/prune. */
export function setHerdrWorkerSessionDirRoot(root: string | undefined): void {
  sessionDirRootOverride = root;
}

/** Extensions seed the transient launcher-spec dir (cleaned after launch). */
export function setHerdrWorkerSpecDirRoot(root: string | undefined): void {
  specDirRootOverride = root;
}

/** Test seam: replace the whole deps bundle. */
export function setHerdrWorkerDepsForTests(deps: HerdrWorkerDeps): void {
  depsOverride = deps;
}

export function resetHerdrWorkerDepsForTests(): void {
  depsOverride = undefined;
  workerWorkspaceController = undefined;
  sessionDirRootOverride = undefined;
  specDirRootOverride = undefined;
}

// --- Entrypoint resolution --------------------------------------------------------

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Lazy — never imported at module scope so unit tests stay pi-free. */
async function resolvePiCliPath(): Promise<string | undefined> {
  try {
    const { getPackageDir } = await import("@earendil-works/pi-coding-agent");
    for (const rel of ["dist/bundle/cli.js", "dist/cli.js"]) {
      const candidate = path.join(getPackageDir(), rel);
      if (isFile(candidate)) return candidate;
    }
  } catch {
    // Package lookup can fail when the extension runs outside pi.
  }
  return undefined;
}

/** Resolve the real codex.js entrypoint without relying on npm shims.
 * Pi may itself resolve from this config's local node_modules while Codex is
 * installed globally, so search both the Pi package root and conventional
 * global/PATH roots. */
async function resolveCodexCliPath(): Promise<string | undefined> {
  const roots: string[] = [];
  try {
    const { getPackageDir } = await import("@earendil-works/pi-coding-agent");
    roots.push(path.resolve(getPackageDir(), "..", ".."));
  } catch {
    // Continue with environment/PATH roots.
  }
  if (process.env.APPDATA)
    roots.push(path.join(process.env.APPDATA, "npm", "node_modules"));
  if (process.env.npm_config_prefix) {
    roots.push(
      path.join(process.env.npm_config_prefix, "node_modules"),
      path.join(process.env.npm_config_prefix, "lib", "node_modules"),
    );
  }
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (entry) roots.push(path.join(entry, "node_modules"));
  }
  roots.push("/usr/local/lib/node_modules", "/usr/lib/node_modules");
  for (const root of new Set(roots)) {
    const candidate = path.join(root, "@openai", "codex", "bin", "codex.js");
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

// --- Launch commands --------------------------------------------------------------

const CHILD_EXCLUDED_TOOL_NAMES = [
  "subagent_spawn",
  "subagent_wait",
  "subagent_cancel",
  "subagent_check",
  "subagent_list",
  "workflow",
  "ask_user",
] as const;

/** Quote one token of a `pane run` command line for the pane's shell
 * (pwsh on Windows, POSIX sh elsewhere). The launcher minimizes what needs
 * quoting — the pane runs only `node <launcher> <spec.json>` — but those
 * paths may contain spaces (or, rarely, apostrophes), and the quote rule is
 * platform-specific: pwsh doubles embedded single quotes, POSIX sh
 * closes-escapes-reopens them. Plain safe tokens stay bare so tests read
 * like the real command line. */
export function quotePaneArg(
  token: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!token) return "''";
  if (/^[A-Za-z0-9_\-./\\:=]+$/.test(token)) return token;
  return shellQuote(token, platform);
}

/**
 * Write the transient launcher spec for a worker launch and resolve the
 * exact pane command: `node <launcher> <spec>`, each token platform-quoted.
 * The spec carries the RAW argv (never shell-quoted — the launcher spawns
 * it verbatim), the worker's cwd, and `PI_SUBAGENT=1` so child extension
 * work (e.g. run summaries) that is inappropriate for a subagent disables
 * itself. The launcher deletes the spec after reading it; the session's
 * finalizer deletes leftovers.
 */
export function writeWorkerLaunchSpec(
  specDir: string,
  specName: string,
  /** Absolute path to `extensions/shared/worker-launcher.mjs`. */
  launcherPath: string,
  nodePath: string,
  argv: ReadonlyArray<string>,
  cwd: string,
  extraEnv: Readonly<Record<string, string>> = {},
): { readonly specPath: string; readonly paneLaunch: ReadonlyArray<string> } {
  fs.mkdirSync(specDir, { recursive: true });
  const specPath = path.join(specDir, `${specName}.json`);
  const [commandPath, ...commandArgs] = argv;
  if (!commandPath) throw new Error("worker launch argv must not be empty");
  const spec = {
    command: commandPath,
    args: commandArgs,
    cwd,
    env: { PI_SUBAGENT: "1", ...extraEnv },
  };
  const tempPath = `${specPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(spec)}\n`, "utf8");
  fs.renameSync(tempPath, specPath);
  const command = [
    quotePaneArg(nodePath),
    quotePaneArg(launcherPath),
    quotePaneArg(specPath),
  ];
  return {
    specPath,
    // PowerShell requires the call operator when the executable token is a
    // quoted path (for example C:\Program Files\nodejs\node.exe). Without
    // it the path is parsed as a string expression and the launcher never
    // starts. POSIX shells execute a quoted command path directly.
    paneLaunch: process.platform === "win32" ? ["&", ...command] : command,
  };
}

/** Best-effort removal of a stale launcher spec (scope-close backstop). */
export function cleanupWorkerLaunchSpec(specPath: string): void {
  try {
    fs.unlinkSync(specPath);
  } catch {
    // Already gone (the launcher self-cleans) or never existed.
  }
}

/** Collision-safe technical Herdr agent name: parent session prefix + logical
 * id, fitting the `[a-z][a-z0-9_-]{0,31}` agent-name grammar. */
export function technicalAgentName(
  parentSessionId: string,
  logicalId: string,
): string {
  const prefix = parentSessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  const id = logicalId.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
  return `p-${prefix || "sess"}-${id}`.slice(0, 32);
}

export interface WorkerLaunchPlan {
  readonly argv: ReadonlyArray<string>;
  readonly sessionDir?: string;
  readonly sessionId?: string;
  readonly marker?: string;
}

function trustFlag(projectTrusted: boolean): string {
  return projectTrusted ? "--approve" : "--no-approve";
}

/** Uniquely identify a subagent run inside a Codex rollout file. */
export function codexRunMarker(logicalId: string): string {
  return `herdrsub_${logicalId.replace(/[^a-zA-Z0-9_-]/g, "-")}_${crypto
    .randomBytes(3)
    .toString("hex")}`;
}

/** The user prompt with the run marker prepended (Codex rollout matching). */
export function codexPromptText(marker: string, prompt: string): string {
  return `${marker} ${prompt}`;
}

/** Shared effort scale → codex CLI reasoning-effort slug. */
export function codexEffortSlug(
  effort: ReasoningEffort | undefined,
): "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  switch (effort) {
    case "off":
    case "minimal":
      return "minimal";
    case "low":
    case "medium":
    case "high":
      return effort;
    case "xhigh":
    case "max":
      return "xhigh";
    case undefined:
      return undefined;
  }
}

/** The full pi TUI launch policy, shared by fresh launches and resumes so a
 * resumed session runs with EXACTLY the same model, thinking level, tool
 * exclusions, trust decision, and name as the original. Returns RAW argv
 * (the launcher spec carries it verbatim; nothing here is shell-quoted). */
function piLaunchArgs(
  task: SpawnTask,
  options: {
    readonly nodePath: string;
    readonly piCliPath: string;
    readonly sessionDir: string;
  },
  pin: { readonly sessionId?: string; readonly sessionFilePath?: string },
): string[] {
  const argv: string[] = [
    options.nodePath,
    options.piCliPath,
    "--session-dir",
    options.sessionDir,
  ];
  if (pin.sessionId) argv.push("--session-id", pin.sessionId);
  if (pin.sessionFilePath) argv.push("--session", pin.sessionFilePath);
  argv.push("--name", subagentDisplayTitle("pi", task));
  if (task.model) argv.push("--model", task.model);
  const thinking = (task.reasoningEffort ??
    task.parent.inheritedThinkingLevel) as ReasoningEffort | undefined;
  if (thinking) argv.push("--thinking", thinking);
  argv.push(trustFlag(task.parent.projectTrusted));
  if (CHILD_EXCLUDED_TOOL_NAMES.length > 0)
    argv.push("--exclude-tools", CHILD_EXCLUDED_TOOL_NAMES.join(","));
  return argv;
}

/**
 * Pi worker launch: a real pi TUI in the pane, pointed at a private session
 * dir with a deterministic session id. No prompt: the initial prompt goes
 * through `pane send-text` + Enter after the TUI boots (the session file is
 * only created at first prompt, hence the private dir + id).
 */
export function piWorkerLaunch(
  task: SpawnTask,
  options: {
    readonly nodePath: string;
    readonly piCliPath: string;
    readonly sessionDir: string;
    readonly sessionId: string;
  },
): WorkerLaunchPlan {
  return {
    argv: piLaunchArgs(task, options, { sessionId: options.sessionId }),
    sessionDir: options.sessionDir,
    sessionId: options.sessionId,
  };
}

/** Resume an existing pi session in a fresh pane (`--session <path>`) with
 * the FULL original launch policy (model, thinking, exclusions, trust,
 * name). Raw argv for the launcher spec. */
export function piResumeLaunch(
  task: SpawnTask,
  options: {
    readonly nodePath: string;
    readonly piCliPath: string;
    readonly sessionDir: string;
    readonly sessionFilePath: string;
  },
): ReadonlyArray<string> {
  return piLaunchArgs(task, options, {
    sessionFilePath: options.sessionFilePath,
  });
}

/**
 * Codex worker launch: the interactive TUI via the explicit node entrypoint
 * (which spawns the native exe attached). Model/sandbox/approval mirror the
 * headless app-server subagents: full workspace access, no approval dialogs.
 * Raw argv for the launcher spec. */
export function codexWorkerLaunch(
  task: SpawnTask,
  options: {
    readonly nodePath: string;
    readonly codexCliPath: string;
    readonly prompt?: string;
  },
): WorkerLaunchPlan {
  const argv = [
    options.nodePath,
    options.codexCliPath,
    "--cd",
    task.cwd,
    "-s",
    "danger-full-access",
    "-a",
    "never",
    ...(task.model ? ["-m", task.model] : []),
  ];
  const effort = codexEffortSlug(task.reasoningEffort);
  if (effort) argv.push("-c", `model_reasoning_effort=\"${effort}\"`);
  if (options.prompt) argv.push(options.prompt);
  return { argv };
}

/** Resume an existing codex session in a fresh pane (`resume <id>`) with the
 * FULL launch policy preserved: cwd, model, reasoning effort, sandbox, and
 * approval. Raw argv for the launcher spec. */
export function codexResumeLaunch(
  task: SpawnTask,
  options: {
    readonly nodePath: string;
    readonly codexCliPath: string;
    readonly sessionId: string;
    readonly prompt?: string;
  },
): ReadonlyArray<string> {
  const argv = [
    options.nodePath,
    options.codexCliPath,
    "resume",
    options.sessionId,
    "--cd",
    task.cwd,
    "-s",
    "danger-full-access",
    "-a",
    "never",
    ...(task.model ? ["-m", task.model] : []),
  ];
  const effort = codexEffortSlug(task.reasoningEffort);
  if (effort) argv.push("-c", `model_reasoning_effort=\"${effort}\"`);
  if (options.prompt) argv.push(options.prompt);
  return argv;
}

// --- Pi session JSONL parsing -------------------------------------------------------

export interface PiSessionFileState {
  sessionId?: string;
  modelLabel?: string;
  usageTokens?: number;
  /** Terminal assistant signal: a run completes only on one of these. */
  terminalStop?: "stop" | "length" | "error" | "aborted";
  errorMessage?: string;
  finalText?: string;
}

export interface PiParseOutput {
  readonly events: SubagentEvent[];
  readonly state: PiSessionFileState;
}

/**
 * Stateful translator for one pi session JSONL file. Tracks tool calls across
 * lines (toolResult lines reference assistant toolCall ids) and dedupes
 * messages by their entry id (compaction rewrites must not double-emit).
 */
export class PiSessionFileReader {
  private seenIds = new Set<string>();
  /** assistant toolCall id (the part before "|" in toolCallId) → tool */
  private tools = new Map<string, { name: string; args?: string }>();
  state: PiSessionFileState = {};

  /** Reset run-bound state: the next stopReason belongs to the NEXT run. */
  resetRun(): void {
    this.state = {
      sessionId: this.state.sessionId,
      modelLabel: this.state.modelLabel,
    };
    this.tools.clear();
  }

  consume(raw: string): PiParseOutput {
    if (!raw.trim()) return { events: [], state: this.state };
    let entry: unknown;
    try {
      entry = JSON.parse(raw);
    } catch {
      return {
        events: [
          {
            _tag: "BackendError",
            message: `Invalid pi session line: ${raw.slice(0, 256)}`,
          },
        ],
        state: this.state,
      };
    }
    const record = entry as Record<string, unknown>;
    const type = record.type;
    const events: SubagentEvent[] = [];

    if (type === "session") {
      const id = record.id;
      if (typeof id === "string") this.state.sessionId = id;
      return { events, state: this.state };
    }
    if (type === "model_change") {
      const provider = record.provider;
      const id = record.modelId;
      if (typeof provider === "string" && typeof id === "string") {
        this.state.modelLabel = `${provider}/${id}`;
        events.push({
          _tag: "MetaChanged",
          meta: { modelLabel: this.state.modelLabel },
        });
      }
      return { events, state: this.state };
    }
    if (type !== "message" || typeof record.id !== "string") {
      return { events, state: this.state };
    }
    if (this.seenIds.has(record.id)) return { events, state: this.state };
    this.seenIds.add(record.id);

    const message = record.message as
      | {
          role?: string;
          content?: unknown;
          toolCallId?: unknown;
          toolName?: unknown;
          isError?: unknown;
        }
      | undefined;
    const role = message?.role;
    if (role === "user") {
      const text = userTextOf(message?.content);
      if (text.trim()) events.push({ _tag: "UserMessage", text });
      return { events, state: this.state };
    }
    if (role === "assistant") {
      const parts = assistantPartsOf(message?.content);
      const toolCallParts = parts.filter(
        (part): part is Extract<TranscriptPart, { type: "toolCall" }> =>
          part.type === "toolCall",
      );
      for (const part of toolCallParts) {
        this.tools.set(part.toolId, {
          name: part.name,
          args: part.argsPreview,
        });
        events.push({
          _tag: "ToolStart",
          toolId: part.toolId,
          name: part.name,
          argsPreview: part.argsPreview,
        });
      }
      events.push({ _tag: "AssistantMessage", parts });
      // Usage lives on the assistant MESSAGE (entry.message.usage), not the
      // entry top level. Compute totalTokens from the native field, falling
      // back to the component sum (input/output/cacheRead/cacheWrite). A
      // legacy top-level `usage` is also honored so old session files parse.
      const messageUsage = (message as { usage?: unknown } | undefined)?.usage;
      const legacyUsage = (record as { usage?: unknown }).usage;
      const usage = (messageUsage ?? legacyUsage) as
        | {
            totalTokens?: number;
            input?: number;
            output?: number;
            cacheRead?: number;
            cacheWrite?: number;
          }
        | undefined;
      let totalTokens =
        typeof usage?.totalTokens === "number" ? usage.totalTokens : undefined;
      if (typeof totalTokens !== "number" && usage) {
        totalTokens =
          (usage.input ?? 0) +
          (usage.output ?? 0) +
          (usage.cacheRead ?? 0) +
          (usage.cacheWrite ?? 0);
      }
      if (typeof totalTokens === "number" && totalTokens > 0) {
        this.state.usageTokens = totalTokens;
        events.push({ _tag: "UsageChanged", tokens: totalTokens });
      }
      // Like usage, stopReason belongs to entry.message in current Pi
      // session JSONL. Keep the entry-level fallback for older files.
      const stop =
        (message as { stopReason?: unknown } | undefined)?.stopReason ??
        record.stopReason;
      if (
        stop === "stop" ||
        stop === "length" ||
        stop === "error" ||
        stop === "aborted"
      ) {
        const text = parts
          .filter((part) => part.type === "text")
          .map((part) => (part as { text: string }).text)
          .join("\n")
          .trim();
        this.state.terminalStop = stop;
        this.state.finalText = text;
        this.state.errorMessage =
          stop === "error"
            ? typeof (message as { errorMessage?: unknown }).errorMessage ===
              "string"
              ? (message as { errorMessage: string }).errorMessage ||
                "Run failed"
              : typeof record.errorMessage === "string"
                ? record.errorMessage || "Run failed"
                : "Run failed"
            : undefined;
      }
      return { events, state: this.state };
    }
    if (role === "toolResult" && message) {
      const fullId =
        typeof message.toolCallId === "string" ? message.toolCallId : undefined;
      const callId = fullId?.split("|")[0];
      const tool = callId ? this.tools.get(callId) : undefined;
      const name =
        typeof message.toolName === "string" ? message.toolName : undefined;
      const text = firstLine(
        userTextOf(message?.content) ||
          (message?.content ? JSON.stringify(message.content) : ""),
      );
      events.push({
        _tag: "ToolEnd",
        toolId: callId ?? `tr-${record.id}`,
        name: name ?? tool?.name ?? "tool",
        isError: message?.isError === true,
        outputPreview: text,
      });
      if (callId) this.tools.delete(callId);
      return { events, state: this.state };
    }
    return { events, state: this.state };
  }
}

function userTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

function assistantPartsOf(content: unknown): TranscriptPart[] {
  if (!Array.isArray(content)) return [];
  const parts: TranscriptPart[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      parts.push({ type: "text", text: record.text });
    } else if (
      record.type === "thinking" &&
      typeof record.thinking === "string"
    ) {
      parts.push({
        type: "thinking",
        text: record.redacted === true ? "" : record.thinking,
        redacted: record.redacted === true,
      });
    } else if (record.type === "toolCall") {
      parts.push({
        type: "toolCall",
        toolId: typeof record.id === "string" ? record.id : "call",
        name: typeof record.name === "string" ? record.name : "tool",
        argsPreview: safeJson(record.arguments),
      });
    }
  }
  return parts;
}

function metaEvent(meta: Partial<SubagentMeta>): SubagentEvent {
  return { _tag: "MetaChanged", meta };
}

// --- Codex rollout parsing -----------------------------------------------------------

export interface CodexParseOutput {
  readonly events: SubagentEvent[];
  sessionId?: string;
  modelLabel?: string;
  /** task_started / task_complete / turn_aborted with their turn ids. */
  taskStarted?: string;
  taskComplete?: {
    readonly turnId: string;
    readonly lastAgentMessage?: string;
  };
  turnAborted?: string;
  usageTokens?: number;
  contextWindow?: number;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function firstLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value.split("\n").find((candidate) => candidate.trim());
  return line?.trim().slice(0, PREVIEW_MAX_LENGTH);
}

const PREVIEW_MAX_LENGTH = 1_024;
const SAFE_JSON_MAX_LENGTH = 4_096;

function safeJson(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value);
    return text === undefined || text === "{}"
      ? undefined
      : text.slice(0, SAFE_JSON_MAX_LENGTH);
  } catch {
    return undefined;
  }
}

export function stripCodexMarker(text: string, marker: string): string {
  if (!marker) return text;
  const trimmed = text.trimStart();
  if (trimmed.startsWith(marker))
    return trimmed.slice(marker.length).trimStart();
  return text;
}

interface CodexTool {
  readonly id: string;
  name: string;
  argsPreview?: string;
  isError: boolean;
}

/**
 * Stateful translator for one Codex rollout file. Tracks open tools
 * (function_call/custom_tool_call start, *_output completes), strips run
 * markers from user messages, and surfaces task lifecycle events.
 */
export class CodexRolloutReader {
  private tools = new Map<string, CodexTool>();
  private markerSeen = false;
  state: {
    sessionId?: string;
    sessionCwd?: string;
    modelLabel?: string;
    lastFinalText: string;
    marker: string;
  } = { marker: "", lastFinalText: "" };

  constructor(marker: string) {
    this.state.marker = marker;
  }

  /** A new run submits a fresh marker; user messages are stripped of it. */
  updateMarker(marker: string): void {
    this.state.marker = marker;
    this.markerSeen = false;
  }

  /** Bind replay to our marked user turn. Codex writes injected AGENTS and
   * environment context as earlier role=user items in the same rollout; they
   * are runtime context, not subagent transcript messages. */
  private acceptUserText(text: string): string | undefined {
    if (!this.state.marker) return text;
    if (text.includes(this.state.marker)) {
      this.markerSeen = true;
      return stripCodexMarker(text, this.state.marker);
    }
    return this.markerSeen ? text : undefined;
  }

  consume(raw: string): CodexParseOutput {
    if (!raw.trim()) return { events: [] };
    let entry: unknown;
    try {
      entry = JSON.parse(raw);
    } catch {
      return {
        events: [
          {
            _tag: "BackendError",
            message: `Invalid codex rollout line: ${raw.slice(0, 256)}`,
          },
        ],
      };
    }
    return this.consumeParsed(entry);
  }

  consumeParsed(entry: unknown): CodexParseOutput {
    const top = recordOf(entry);
    if (!top) return { events: [] };
    const type = stringOf(top.type);
    const payload = recordOf(top.payload) ?? {};
    const output: CodexParseOutput = { events: [] };

    if (type === "session_meta") {
      output.sessionId = stringOf(payload.id);
      return output;
    }
    if (type === "turn_context") {
      const model = stringOf(payload.model);
      if (model) {
        this.state.modelLabel = model;
        output.modelLabel = model;
      }
      return output;
    }

    const payloadType = stringOf(payload.type) ?? "";
    if (type === "event_msg") {
      if (payloadType === "user_message") {
        const text = this.acceptUserText(stringOf(payload.message) ?? "");
        if (text !== undefined)
          output.events.push({ _tag: "UserMessage", text });
        return output;
      }
      if (!this.markerSeen) return output;
      switch (payloadType) {
        case "task_started": {
          const turnId = stringOf(payload.turn_id);
          if (turnId) output.taskStarted = turnId;
          return output;
        }
        case "task_complete": {
          output.taskComplete = {
            turnId: stringOf(payload.turn_id) ?? "",
            lastAgentMessage: stringOf(payload.last_agent_message),
          };
          this.flushTools(output);
          return output;
        }
        case "turn_aborted": {
          output.turnAborted = stringOf(payload.turn_id) ?? "";
          this.flushTools(output);
          return output;
        }
        case "agent_message": {
          this.pushAgentText(
            output,
            stringOf(payload.message) ?? "",
            stringOf(payload.phase),
          );
          return output;
        }
        case "token_count": {
          const info = recordOf(payload.info);
          const last = recordOf(info?.last_token_usage);
          const total = numberValue(last?.total_tokens);
          const window = numberValue(info?.model_context_window);
          if (total !== undefined || window !== undefined)
            output.events.push({
              _tag: "UsageChanged",
              tokens: total,
              contextWindow: window,
            });
          return output;
        }
        default:
          return output;
      }
    }
    if (type === "response_item") {
      return this.consumeResponseItem(payload, output);
    }
    return output;
  }

  private pushAgentText(
    output: CodexParseOutput,
    text: string,
    phase?: string,
  ) {
    if (text.trim()) {
      output.events.push({
        _tag: "AssistantMessage",
        parts: [{ type: "text", text }],
      });
      if (phase === "final_answer") this.state.lastFinalText = text;
    }
  }

  private consumeResponseItem(
    payload: Record<string, unknown>,
    output: CodexParseOutput,
  ): CodexParseOutput {
    const payloadType = stringOf(payload.type) ?? "";
    if (payloadType !== "message" && !this.markerSeen) return output;
    switch (payloadType) {
      case "message": {
        const role = stringOf(payload.role);
        const text = responseText(payload.content);
        if (role === "user" && text) {
          const accepted = this.acceptUserText(text);
          if (accepted !== undefined)
            output.events.push({ _tag: "UserMessage", text: accepted });
        } else if (role === "assistant" && text && this.markerSeen) {
          this.pushAgentText(output, text, stringOf(payload.phase));
        }
        return output;
      }
      case "agent_message": {
        if (!this.markerSeen) return output;
        const text = responseText(payload.content) ?? stringOf(payload.message);
        this.pushAgentText(output, text ?? "", stringOf(payload.phase));
        return output;
      }
      case "reasoning": {
        if (!this.markerSeen) return output;
        const text = [
          ...strings(payload.summary),
          ...strings(payload.content),
        ].join("\n");
        if (text) {
          output.events.push({
            _tag: "AssistantMessage",
            parts: [{ type: "thinking", text }],
          });
        }
        return output;
      }
      case "function_call":
      case "custom_tool_call": {
        if (!this.markerSeen) return output;
        const id = stringOf(payload.call_id) ?? stringOf(payload.id) ?? "call";
        const name = stringOf(payload.name) ?? "tool";
        const preview =
          shellCommandOf(payload.arguments) ??
          firstLine(payload.input) ??
          safeJson(payload.input) ??
          safeJson(payload.arguments);
        this.tools.set(id, { id, name, argsPreview: preview, isError: false });
        output.events.push({
          _tag: "ToolStart",
          toolId: id,
          name: name === "shell_command" ? "shell" : name,
          argsPreview: preview,
        });
        return output;
      }
      case "function_call_output":
      case "custom_tool_call_output": {
        const id = stringOf(payload.call_id) ?? "call";
        const tool = this.tools.get(id);
        if (!tool) {
          output.events.push({
            _tag: "ToolEnd",
            toolId: id,
            name: "tool",
            isError: false,
            outputPreview:
              firstLine(payload.output) ?? firstLine(payload.result),
          });
          return output;
        }
        const exitCode = numberValue(payload.exit_code);
        const failed =
          tool.isError ||
          payload.status === "error" ||
          stringOf(payload.status) === "failed" ||
          (exitCode !== undefined && exitCode !== 0);
        output.events.push({
          _tag: "ToolEnd",
          toolId: tool.id,
          name: tool.name === "shell_command" ? "shell" : tool.name,
          isError: failed,
          outputPreview:
            firstLine(payload.output) ??
            firstLine(payload.result) ??
            tool.argsPreview,
        });
        this.tools.delete(tool.id);
        return output;
      }
      case "file_change": {
        const id = `patch-${this.tools.size}`;
        const paths = records(recordOf(payload.changes)?.changes)
          .map((change) => stringOf(change.path))
          .filter((value): value is string => value !== undefined);
        const preview = paths.join(", ").slice(0, PREVIEW_MAX_LENGTH);
        const failed =
          payload.status === "error" || stringOf(payload.status) === "failed";
        output.events.push({
          _tag: "ToolStart",
          toolId: id,
          name: "apply_patch",
          argsPreview: preview || undefined,
        });
        output.events.push({
          _tag: "ToolEnd",
          toolId: id,
          name: "apply_patch",
          isError: failed,
          outputPreview: preview || undefined,
        });
        return output;
      }
      case "web_search":
      case "safe_web_search": {
        const id = `search-${this.tools.size}`;
        const query = firstLine(payload.query) ?? firstLine(payload.prompt);
        output.events.push({
          _tag: "ToolStart",
          toolId: id,
          name: "web_search",
          argsPreview: query,
        });
        output.events.push({
          _tag: "ToolEnd",
          toolId: id,
          name: "web_search",
          isError: false,
          outputPreview: query,
        });
        return output;
      }
      case "command_execution": {
        const id = `shell-${this.tools.size}`;
        const command = firstLine(payload.command);
        const exitCode = numberValue(payload.exit_code);
        const failed =
          payload.status === "error" ||
          stringOf(payload.status) === "failed" ||
          (exitCode !== undefined && exitCode !== 0);
        const tool: CodexTool = {
          id,
          name: "shell",
          argsPreview: command,
          isError: failed,
        };
        this.tools.set(id, tool);
        output.events.push({
          _tag: "ToolStart",
          toolId: id,
          name: "shell",
          argsPreview: command,
        });
        output.events.push({
          _tag: "ToolEnd",
          toolId: id,
          name: "shell",
          isError: failed,
          outputPreview: firstLine(payload.output) ?? command,
        });
        this.tools.delete(id);
        return output;
      }
      case "mcp_tool_call": {
        const id = stringOf(payload.call_id) ?? `mcp-${this.tools.size}`;
        const server = stringOf(payload.server);
        const name = stringOf(payload.tool) ?? "tool";
        this.tools.set(id, {
          id,
          name: server ? `${server}/${name}` : name,
          argsPreview: firstLine(safeJson(payload.arguments)),
          isError: false,
        });
        output.events.push({
          _tag: "ToolStart",
          toolId: id,
          name: server ? `${server}/${name}` : name,
          argsPreview: firstLine(safeJson(payload.arguments)),
        });
        return output;
      }
      case "mcp_tool_call_output": {
        const id = stringOf(payload.call_id) ?? "call";
        const tool = this.tools.get(id);
        const failed =
          payload.status === "error" || stringOf(payload.status) === "failed";
        output.events.push({
          _tag: "ToolEnd",
          toolId: id,
          name: tool?.name ?? "tool",
          isError: failed,
          outputPreview: firstLine(payload.output) ?? firstLine(payload.result),
        });
        this.tools.delete(id);
        return output;
      }
      default:
        return output;
    }
  }

  /** Emit ToolEnd for tools still open at task end (no corresponding output). */
  private flushTools(output: CodexParseOutput) {
    for (const tool of this.tools.values()) {
      output.events.push({
        _tag: "ToolEnd",
        toolId: tool.id,
        name: tool.name === "shell_command" ? "shell" : tool.name,
        isError: false,
        outputPreview: undefined,
      });
    }
    this.tools.clear();
  }
}

function responseText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((part) => {
      const record = recordOf(part);
      const type = stringOf(record?.type);
      if (type === "output_text" || type === "input_text") {
        return stringOf(record?.text) ?? "";
      }
      return "";
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join("\n").trim() : undefined;
}

function records(value: unknown) {
  return Array.isArray(value)
    ? value
        .map(recordOf)
        .filter((item): item is Record<string, unknown> => item !== undefined)
    : [];
}

/** The shell command inside a JSON-string (or object) `arguments` field. */
function shellCommandOf(value: unknown): string | undefined {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  const record = recordOf(value);
  if (!record) return undefined;
  const command = record.command ?? record.cmd;
  return firstLine(typeof command === "string" ? command : undefined);
}

function strings(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

// --- File tailer ---------------------------------------------------------------------

export interface JsonlTailerOptions {
  readonly path: string;
  /** Start from byte 0 (replay existing content) or from the current EOF. */
  readonly fromStart?: boolean;
  readonly pollIntervalMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly onLine: (line: string) => void;
  readonly onStall?: (idleMs: number) => void;
}

/**
 * Poll-based JSONL tailer. Anchors at EOF (or 0), handles append-only files,
 * and resets the cursor when a file is rewritten (compaction) so the caller
 * re-reads from the top (parsers dedupe by entry id). Calls onStall on every
 * poll where no new bytes arrived.
 */
export class JsonlTailer {
  private stopped = false;
  private cursor = 0;
  private pending = "";
  private seenFirstAnchored = false;
  private lastActivityAt = 0;
  private running = false;
  private readonly options: JsonlTailerOptions;

  constructor(options: JsonlTailerOptions) {
    this.options = options;
    this.lastActivityAt = Date.now();
  }

  start(): void {
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      await this.options.sleep(this.options.pollIntervalMs);
      return this.tick();
    }
    this.running = true;
    try {
      let size = 0;
      try {
        size = fs.statSync(this.options.path).size;
      } catch {
        size = 0;
      }
      if (!this.seenFirstAnchored && !this.options.fromStart) {
        // First read: anchor at the current end before consuming anything.
        this.cursor = size;
        this.seenFirstAnchored = true;
      } else if (size < this.cursor) {
        // Rewritten/rotated: re-read from the top; parsers dedupe.
        this.cursor = 0;
        this.pending = "";
      }
      if (size > this.cursor) {
        this.drain(size);
      } else {
        this.options.onStall?.(Date.now() - this.lastActivityAt);
      }
    } finally {
      this.running = false;
    }
    if (!this.stopped) {
      await this.options.sleep(this.options.pollIntervalMs);
      return this.tick();
    }
  }

  private drain(size: number) {
    const fd = fs.openSync(this.options.path, "r");
    try {
      const length = size - this.cursor;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, this.cursor);
      this.pending += buffer.toString("utf8");
      this.cursor = size;
      this.lastActivityAt = Date.now();
      let newline: number;
      while ((newline = this.pending.indexOf("\n")) >= 0) {
        const line = this.pending.slice(0, newline).replace(/\r$/, "");
        this.pending = this.pending.slice(newline + 1);
        this.options.onLine(line);
      }
    } finally {
      fs.closeSync(fd);
    }
  }
}

// --- Codex rollout discovery ----------------------------------------------------------

export interface CodexRolloutCandidate {
  readonly path: string;
  readonly mtimeMs: number;
}

/** Recursively list rollout JSONL candidates under a codex root. */
export function findCodexRolloutFiles(root: string): CodexRolloutCandidate[] {
  const out: CodexRolloutCandidate[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".jsonl") &&
        entry.name !== "session_index.jsonl"
      ) {
        try {
          const stat = fs.statSync(full);
          out.push({ path: full, mtimeMs: stat.mtimeMs });
        } catch {
          // Ignore files that vanished mid-scan.
        }
      }
    }
  };
  walk(root);
  return out;
}

/** Match a rollout to our run: session cwd + the unique marker anywhere. */
export function rolloutMatches(
  path: string,
  cwd: string,
  marker: string,
  sessionId?: string,
): boolean {
  let content: string;
  try {
    content = fs.readFileSync(path, "utf8");
  } catch {
    return false;
  }
  if (!content.includes(marker)) return false;
  if (sessionId && !content.includes(`"id":"${sessionId}"`)) return false;
  if (!cwd) return true;
  const escaped = cwd.replace(/\\/g, "\\\\");
  return (
    content.includes(`"cwd":"${cwd}"`) || content.includes(`"cwd":"${escaped}"`)
  );
}

/** Best candidate among files matching cwd+marker: newest mtime. */
export function selectCodexRollout(
  candidates: ReadonlyArray<CodexRolloutCandidate>,
  cwd: string,
  marker: string,
  sessionId?: string,
): string | undefined {
  const matched = candidates.filter((candidate) =>
    rolloutMatches(candidate.path, cwd, marker, sessionId),
  );
  matched.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matched[0]?.path;
}

// --- The session ------------------------------------------------------------------------

export type WorkerKind = "pi" | "codex";

const WORKER_AGENT_STATES = ["idle", "working", "blocked", "unknown"] as const;
type WorkerAgentState = (typeof WORKER_AGENT_STATES)[number];

interface WorkerState {
  closed: boolean;
  pane?: WorkerPaneHandle;
  takenOver: boolean;
  runActive: boolean;
  runStarted: boolean;
  runError?: string;
  lastAssistantText: string;
  nativeSessionId?: string;
  sessionFilePath?: string;
  interruptRequested: boolean;
  interruptedFallback?: ReturnType<typeof setTimeout>;
  livenessClock: number;
  pendingCodex: string[];
  meta: SubagentMeta;
  marker?: string;
}

const boundedError = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 4096);

function clearInterruptFallback(state: WorkerState) {
  if (state.interruptedFallback) clearTimeout(state.interruptedFallback);
  state.interruptedFallback = undefined;
}

function emitOutcome(
  emit: (event: SubagentEvent) => void,
  state: WorkerState,
  outcome: RunOutcome,
) {
  state.runActive = false;
  state.runStarted = false;
  state.runError = undefined;
  state.interruptRequested = false;
  clearInterruptFallback(state);
  emit({ _tag: "RunSettled", outcome });
}

/**
 * Try to spawn the subagent as a Herdr-native TUI worker. Resolves undefined
 * (never throws for availability reasons) when Herdr is unavailable, the
 * entrypoints are missing, or the pane cannot be opened — callers keep their
 * in-process fallback backend.
 */
export function trySpawnHerdrWorker(
  kind: WorkerKind,
  task: SpawnTask,
): Effect.Effect<SubagentSession | undefined, SpawnError, Scope.Scope> {
  return Eff.suspend(() => {
    const deps = herdrWorkerDeps();
    if (!deps.workspace()?.available()) return Eff.succeed(undefined);
    return makeHerdrWorkerSession(kind, task, deps).pipe(
      Eff.orElseSucceed(() => undefined),
    );
  });
}

export function makeHerdrWorkerSession(
  kind: WorkerKind,
  task: SpawnTask,
  deps: HerdrWorkerDeps,
): Effect.Effect<SubagentSession, SpawnError, Scope.Scope> {
  return Eff.gen(function* () {
    const workspace = deps.workspace();
    if (!workspace?.available()) {
      return yield* new SpawnError({
        message: "herdr worker workspace unavailable",
      });
    }
    const clock = deps.clock ?? Date.now;
    const sleepMs = deps.sleep ?? sleepReal;
    const pollIntervalMs = deps.pollIntervalMs;
    const agentName = technicalAgentName(
      task.parent.parentSessionId ?? "session",
      task.logicalId ?? "sa",
    );

    const nodePath = process.execPath;
    const piCli =
      kind === "pi" ? yield* Eff.promise(() => deps.piCliPath()) : undefined;
    const codexCli =
      kind === "codex"
        ? yield* Eff.promise(() => deps.codexCliPath())
        : undefined;
    if (kind === "pi" && !piCli)
      return yield* new SpawnError({ message: "pi CLI entrypoint not found" });
    if (kind === "codex" && !codexCli)
      return yield* new SpawnError({ message: "codex entrypoint not found" });

    const title = subagentDisplayTitle(kind, task);
    const sessionDir =
      kind === "pi"
        ? path.join(deps.sessionDirRoot(), task.logicalId ?? "sa")
        : undefined;
    const nativeSessionId = kind === "pi" ? crypto.randomUUID() : undefined;
    if (sessionDir) {
      try {
        fs.mkdirSync(sessionDir, { recursive: true });
      } catch (error) {
        return yield* new SpawnError({
          message: `could not create pi session dir: ${boundedError(error)}`,
        });
      }
    }

    const initialCodexMarker =
      kind === "codex" ? codexRunMarker(task.logicalId ?? "sa") : undefined;
    const launch =
      kind === "pi" && piCli && sessionDir && nativeSessionId
        ? piWorkerLaunch(task, {
            nodePath,
            piCliPath: piCli,
            sessionDir,
            sessionId: nativeSessionId,
          })
        : codexWorkerLaunch(task, {
            nodePath,
            codexCliPath: codexCli!,
            prompt: codexPromptText(initialCodexMarker!, task.prompt),
          });

    // The pane runs ONLY `node <launcher> <spec.json>`; the spec carries the
    // RAW argv (never shell-quoted). The launcher self-cleans after reading;
    // the finalizer below removes any leftovers (failed opens, races).
    const launcherPath = deps.launcherPath();
    const specDir = deps.specDirRoot();
    let launchSeq = 0;
    const writtenSpecs = new Set<string>();
    const launchSpec = (argv: ReadonlyArray<string>) => {
      const { specPath, paneLaunch } = writeWorkerLaunchSpec(
        specDir,
        `${agentName}-${++launchSeq}`,
        launcherPath,
        nodePath,
        argv,
        task.cwd,
      );
      writtenSpecs.add(specPath);
      return { specPath, paneLaunch };
    };
    const initialSpec = launchSpec(launch.argv);

    const events = yield* Queue.make<SubagentEvent, Cause.Done>();
    const emit = (event: SubagentEvent) => {
      Queue.offerUnsafe(events, event);
    };

    const state: WorkerState = {
      closed: false,
      takenOver: false,
      runActive: false,
      runStarted: false,
      lastAssistantText: "",
      interruptRequested: false,
      livenessClock: 0,
      pendingCodex: [],
      meta: { backend: kind },
      marker: initialCodexMarker,
    };

    const pane = yield* Eff.tryPromise(() =>
      workspace.openWorker({
        category: "subagents",
        title,
        cwd: task.cwd,
        launch: [...initialSpec.paneLaunch],
        agent: {
          label: kind,
          state: "working",
          sessionId: nativeSessionId ?? state.meta.nativeSessionId,
          name: agentName,
        },
      }),
    ).pipe(Eff.orElseSucceed(() => undefined));
    if (!pane) {
      cleanupWorkerLaunchSpec(initialSpec.specPath);
      writtenSpecs.delete(initialSpec.specPath);
      // The pi session dir is NOT deleted: sessions are persistent and stay
      // discoverable/resumable across this worker's life. A stale file from a
      // crashed parent can never hijack the watch (findPiSessionFile checks
      // our fresh session id).
      return yield* new SpawnError({
        message: "herdr worker pane unavailable",
      });
    }
    state.pane = pane;
    state.meta = {
      backend: kind,
      herdrPaneId: pane.paneId,
      herdrAgentName: agentName,
      ...(state.nativeSessionId
        ? { nativeSessionId: state.nativeSessionId }
        : {}),
    };
    emit(metaEvent(state.meta));

    // Native session-file readers are late-bound by discovery but declared
    // before run-state helpers because startRunState resets them.
    let activeTailer: JsonlTailer | undefined;
    let codexReader: CodexRolloutReader | undefined;
    let piReader: PiSessionFileReader | undefined;
    let paneOperation: Promise<unknown> = Promise.resolve();
    const withPaneOperation = <T>(operation: () => Promise<T>): Promise<T> => {
      const result = paneOperation.then(operation, operation);
      paneOperation = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };

    const report = (agentState: WorkerAgentState, message?: string) =>
      state.pane?.reportState(agentState, message).catch(() => {});

    /** Reopen the pane against the exact native session (resume). */
    const reopenPane = async (
      codexPrompt?: string,
    ): Promise<WorkerPaneHandle | undefined> => {
      const resumeLaunch =
        kind === "pi" && piCli && sessionDir && state.sessionFilePath
          ? piResumeLaunch(task, {
              nodePath,
              piCliPath: piCli,
              sessionDir,
              sessionFilePath: state.sessionFilePath,
            })
          : kind === "codex" && codexCli && state.nativeSessionId
            ? codexResumeLaunch(task, {
                nodePath,
                codexCliPath: codexCli,
                sessionId: state.nativeSessionId,
                prompt: codexPrompt,
              })
            : undefined;
      if (!resumeLaunch) return undefined;
      const resumeSpec = launchSpec(resumeLaunch);
      const reopened = await workspace
        .openWorker({
          category: "subagents",
          title,
          cwd: task.cwd,
          launch: [...resumeSpec.paneLaunch],
          agent: {
            label: kind,
            state: "idle",
            sessionId: state.nativeSessionId,
            name: agentName,
          },
        })
        .catch(() => undefined);
      if (!reopened) {
        // The pane never ran the launcher; drop the stale spec now (the
        // finalizer is the backstop for specs the launcher already consumed).
        cleanupWorkerLaunchSpec(resumeSpec.specPath);
        writtenSpecs.delete(resumeSpec.specPath);
      }
      if (reopened) {
        state.pane = reopened;
        state.meta = { ...state.meta, herdrPaneId: reopened.paneId };
        emit(metaEvent(state.meta));
      }
      return reopened;
    };

    /** Submit a prompt via the LOW-LEVEL transport (`pane send-text` + Enter),
     * retrying only while the fresh TUI boots (bounded by the deadline). */
    const submitPrompt = async (text: string): Promise<void> => {
      if (state.closed || !state.pane)
        throw new Error("subagent pane is closed");
      // WorkerPaneHandle owns the only safe retries: send-text retries only
      // before delivery, and Enter retries without retyping. Retrying the
      // whole pair here could duplicate text after a partial success.
      await state.pane.submitText(text);
    };

    /** Close the pane after a settled run unless the user took it over. */
    const settleClosePolicy = async () => {
      await withPaneOperation(async () => {
        if (state.takenOver || !state.pane || state.closed || state.runActive)
          return;
        const closing = state.pane;
        state.pane = undefined;
        await closing.close().catch(() => {});
      });
    };

    const drainCodexPending = () => {
      if (kind !== "codex" || state.pendingCodex.length === 0) return;
      void startRun(state.pendingCodex.shift()!);
    };

    // --- run lifecycle ---------------------------------------------------------

    const settleRun = (outcome: RunOutcome) => {
      if (!state.runActive) return;
      emitOutcome(emit, state, outcome);
      void report("idle");
      queueMicrotask(drainCodexPending);
      queueMicrotask(() => void settleClosePolicy());
    };

    // A run that produced no terminal signal but whose TUI exited is a real
    // failure — the honest fallback (never settled by Herdr idle alone).
    const probeLiveness = () => {
      if (!state.runActive || !state.pane) return;
      const pane = state.pane;
      const liveness = pane.isWorkerRunning
        ? pane.isWorkerRunning()
        : pane.getAgentState().then((agentState) => agentState !== undefined);
      void liveness
        .then((running) => {
          if (state.runActive && running === false) {
            settleRun({
              _tag: "Failed",
              errorText:
                "Subagent worker exited before producing a terminal message",
              partialText: state.lastAssistantText || undefined,
            });
          }
        })
        .catch(() => {});
    };

    const handleStall = () => {
      if (!state.runActive || state.closed) return;
      const every = deps.livenessProbeEveryMs;
      if (!every) return;
      if (clock() - state.livenessClock >= every) {
        state.livenessClock = clock();
        probeLiveness();
      }
    };

    // --- the run loop ------------------------------------------------------------

    /** Truthfully mark a new run active: reset per-run state (reader terminal
     * state, marker, clocks) BEFORE any async surface work, and EMIT
     * RunStarted immediately — a run that then fails (prompt submit or
     * resume reopen) settles as a real run (RunStarted → RunSettled) instead
     * of leaving the manager waiting on a dangling start. The readers' own
     * RunStarted guards skip (runStarted is already true). */
    const startRunState = (text: string, markerOverride?: string): string => {
      state.lastAssistantText = "";
      state.runError = undefined;
      state.runActive = true;
      state.runStarted = true;
      state.interruptRequested = false;
      clearInterruptFallback(state);
      state.livenessClock = clock();
      // The pi reader keeps per-run terminal state; the last stopReason of
      // the previous run must never settle the next one.
      piReader?.resetRun();
      if (kind === "codex") {
        state.marker = markerOverride ?? codexRunMarker(task.logicalId ?? "sa");
        codexReader?.updateMarker(state.marker);
      }
      emit({ _tag: "RunStarted" });
      return kind === "codex" && state.marker
        ? codexPromptText(state.marker, text)
        : text;
    };

    /** Submit the initial prompt of an already-active run and report working. */
    const submitRunPrompt = (promptText: string) => {
      void submitPrompt(promptText)
        .then(() => report("working"))
        .catch((error) => {
          if (state.closed || !state.runActive) return;
          state.runError = boundedError(error);
          if (state.pane) {
            void state.pane.close().catch(() => {});
            state.pane = undefined;
          }
          settleRun({
            _tag: "Failed",
            errorText: state.runError,
            partialText: state.lastAssistantText || undefined,
          });
        });
    };

    const beginRun = (text: string) => submitRunPrompt(startRunState(text));

    const startRun = (text: string) => {
      if (state.closed) return;
      if (state.runActive) {
        // Steer the active run through the TUI (pi queues its own
        // follow-ups); codex follow-ups queue locally and drain at settle.
        if (kind === "pi") {
          void state.pane?.submitText(text).catch(() => {});
        } else {
          state.pendingCodex.push(text);
        }
        return;
      }
      if (!state.pane) {
        // Settled + closed: resume the exact session in a fresh pane first.
        // Mark the run active NOW — the reopen can fail, and the failure
        // must settle truthfully. Before this fix a failed settled-resume
        // emitted RunStarted with runActive=false, settleRun() no-op'd, and
        // the run never emitted RunSettled (the manager waited forever).
        const promptText = startRunState(text);
        void withPaneOperation(async () => {
          if (state.closed) return;
          // A takeover may have reopened the pane while this send waited for
          // the operation lock. In that case type into the now-ready TUI.
          if (state.pane) {
            submitRunPrompt(promptText);
            return;
          }
          const reopened = await reopenPane(
            kind === "codex" ? promptText : undefined,
          );
          if (state.closed) return;
          if (!reopened) {
            settleRun({
              _tag: "Failed",
              errorText:
                "Could not resume the subagent session in a Herdr pane",
              partialText: state.lastAssistantText || undefined,
            });
            return;
          }
          if (kind === "codex") void report("working");
          else submitRunPrompt(promptText);
        })
          .then(() => undefined)
          .catch((error) => {
            if (state.closed || !state.runActive) return;
            settleRun({
              _tag: "Failed",
              errorText: `Could not resume the subagent session: ${boundedError(error)}`,
              partialText: state.lastAssistantText || undefined,
            });
          });
        return;
      }
      beginRun(text);
    };

    const runPiReader = (reader: PiSessionFileReader) => (line: string) => {
      const parsed = reader.consume(line);
      if (
        parsed.state.sessionId &&
        parsed.state.sessionId !== state.nativeSessionId
      ) {
        state.nativeSessionId = parsed.state.sessionId;
        state.meta = { ...state.meta, nativeSessionId: parsed.state.sessionId };
        emit(metaEvent({ nativeSessionId: parsed.state.sessionId }));
      }
      if (
        parsed.state.modelLabel &&
        parsed.state.modelLabel !== state.meta.modelLabel
      ) {
        // PiSessionFileReader already emits this MetaChanged event; keep the
        // session metadata in sync without duplicating it in the transcript.
        state.meta = { ...state.meta, modelLabel: parsed.state.modelLabel };
      }
      if (!state.runActive) return;
      if (!state.runStarted && parsed.events.length > 0) {
        state.runStarted = true;
        emit({ _tag: "RunStarted" });
      }
      for (const event of parsed.events) emit(event);
      const terminal = parsed.state.terminalStop;
      if (terminal) {
        state.lastAssistantText = parsed.state.finalText ?? "";
        if (terminal === "aborted") {
          settleRun({
            _tag: "Interrupted",
            partialText: parsed.state.finalText || undefined,
          });
        } else if (terminal === "error") {
          settleRun({
            _tag: "Failed",
            errorText: parsed.state.errorMessage ?? "Run failed",
            partialText: parsed.state.finalText || undefined,
          });
        } else {
          settleRun({
            _tag: "Completed",
            finalText: parsed.state.finalText ?? "",
          });
        }
      }
    };

    const runCodexReader = (reader: CodexRolloutReader) => (line: string) => {
      const parsed = reader.consume(line);
      if (parsed.sessionId && parsed.sessionId !== state.nativeSessionId) {
        state.nativeSessionId = parsed.sessionId;
        state.meta = { ...state.meta, nativeSessionId: parsed.sessionId };
        emit(metaEvent({ nativeSessionId: parsed.sessionId }));
      }
      if (parsed.modelLabel && parsed.modelLabel !== state.meta.modelLabel) {
        state.meta = { ...state.meta, modelLabel: parsed.modelLabel };
        emit(metaEvent({ modelLabel: parsed.modelLabel }));
      }
      if (!state.runActive) return;
      if (parsed.taskStarted && !state.runStarted) {
        state.runStarted = true;
        emit({ _tag: "RunStarted" });
      }
      for (const event of parsed.events) {
        if (event._tag === "AssistantMessage") {
          const text = event.parts
            .filter((part) => part.type === "text")
            .map((part) => (part as { text: string }).text)
            .join("\n");
          if (text) state.lastAssistantText = text;
        }
        emit(event);
      }
      if (parsed.taskComplete) {
        const finalText =
          parsed.taskComplete.lastAgentMessage ?? state.lastAssistantText ?? "";
        settleRun({ _tag: "Completed", finalText });
      } else if (parsed.turnAborted) {
        settleRun({
          _tag: "Interrupted",
          partialText: state.lastAssistantText || undefined,
        });
      }
    };

    // --- watcher bootstrap (per kind) -------------------------------------------

    // Register the initial run before discovery starts so a very fast session
    // file/rollout cannot be replayed while runActive=false and then deduped.
    // Codex's prompt is already in argv; Pi submits the returned text below.
    const initialPromptText = startRunState(task.prompt, initialCodexMarker);

    if (kind === "pi") {
      // Wait for the private session file (created at first prompt) then tail
      // it from byte 0: the file may already contain the full run by the time
      // discovery finds it (fast tiny prompts), and replay is safe — the
      // header produces no events, message ids dedupe, and the run's lines
      // are processed exactly once in order.
      const runPiDiscovery = async (): Promise<void> => {
        while (!state.closed && !activeTailer) {
          const filePath = findPiSessionFile(sessionDir!, nativeSessionId!);
          if (filePath) {
            state.sessionFilePath = filePath;
            state.meta = { ...state.meta, sessionFilePath: filePath };
            emit(metaEvent({ sessionFilePath: filePath }));
            const reader = new PiSessionFileReader();
            piReader = reader;
            const tailer = new JsonlTailer({
              path: filePath,
              fromStart: true,
              pollIntervalMs,
              sleep: sleepMs,
              onLine: runPiReader(reader),
              onStall: handleStall,
            });
            activeTailer = tailer;
            tailer.start();
            return;
          }
          handleStall();
          if (!state.runActive) return;
          await sleepMs(pollIntervalMs);
        }
      };
      void runPiDiscovery();
    } else {
      // Codex: discover the rollout (marker + cwd/session_meta match), then
      // replay it from byte 0 — the marker lives in the first user message,
      // so the initial run's full history is captured exactly once.
      const runCodexDiscovery = async (): Promise<void> => {
        while (!state.closed && !activeTailer) {
          const marker = state.marker;
          const bound = marker
            ? selectCodexRollout(
                [
                  path.join(deps.codexHome(), "sessions"),
                  path.join(deps.codexHome(), "rollouts"),
                ].flatMap((root) => findCodexRolloutFiles(root)),
                task.cwd,
                marker,
                state.nativeSessionId,
              )
            : undefined;
          if (!bound) {
            handleStall();
            if (!state.runActive) return;
            await sleepMs(pollIntervalMs);
            continue;
          }
          state.sessionFilePath = bound;
          state.meta = { ...state.meta, sessionFilePath: bound };
          emit(metaEvent({ sessionFilePath: bound }));
          const reader = new CodexRolloutReader(marker ?? "");
          codexReader = reader;
          const tailer = new JsonlTailer({
            path: bound,
            fromStart: true,
            pollIntervalMs,
            sleep: sleepMs,
            onLine: runCodexReader(reader),
            onStall: handleStall,
          });
          activeTailer = tailer;
          tailer.start();
          return;
        }
      };
      void runCodexDiscovery();
    }

    // --- interrupt / take over -------------------------------------------------------

    const interrupt = (): Promise<void> =>
      (async () => {
        if (state.closed || !state.runActive) return;
        state.interruptRequested = true;
        await state.pane?.sendKeys("ctrl+c").catch(() => undefined);
        clearInterruptFallback(state);
        state.interruptedFallback = setTimeout(() => {
          if (!state.closed && state.runActive) {
            settleRun({
              _tag: "Interrupted",
              partialText: state.lastAssistantText || undefined,
            });
          }
        }, deps.interruptFallbackMs);
      })();

    let takeoverInFlight: Promise<boolean> | undefined;
    const takeOver = (): Promise<boolean> => {
      if (takeoverInFlight) return takeoverInFlight;
      takeoverInFlight = withPaneOperation(async () => {
        if (state.closed) return false;
        if (!state.pane) {
          // Settled (pane closed by the settle policy): reopen + resume the
          // exact session, focus, keep the TUI open.
          const reopened = await reopenPane();
          if (!reopened) return false;
        }
        const pane = state.pane;
        if (!pane) return false;
        const wasTakenOver = state.takenOver;
        // Prevent a concurrent settle microtask from closing the pane while
        // focus is in flight. Publish metadata only after focus succeeds.
        state.takenOver = true;
        try {
          await pane.focus();
        } catch {
          if (!wasTakenOver) state.takenOver = false;
          if (state.pane === pane) state.pane = undefined;
          await pane.close().catch(() => {});
          return false;
        }
        if (!wasTakenOver) {
          state.meta = { ...state.meta, takenOver: true };
          emit(metaEvent({ takenOver: true }));
        }
        return true;
      }).finally(() => {
        takeoverInFlight = undefined;
      });
      return takeoverInFlight;
    };

    // --- scope close -------------------------------------------------------------

    yield* Eff.addFinalizer(() =>
      Eff.promise(async () => {
        state.closed = true;
        if (activeTailer) activeTailer.stop();
        clearInterruptFallback(state);
        if (state.runActive) {
          emitOutcome(emit, state, {
            _tag: "Interrupted",
            partialText: state.lastAssistantText || undefined,
          });
        }
        // Transient launcher specs are cleaned now (the launcher already
        // deleted the ones it consumed). The persistent pi session dir is
        // deliberately NOT touched — subagent sessions stay discoverable and
        // resumable after scope close and manager prune.
        for (const specPath of writtenSpecs) {
          cleanupWorkerLaunchSpec(specPath);
        }
        writtenSpecs.clear();
        if (state.pane && !state.takenOver) {
          await state.pane.close().catch(() => {});
          state.pane = undefined;
        }
        Queue.endUnsafe(events);
      }),
    );

    // --- send the initial prompt -------------------------------------------------

    if (kind === "codex") {
      // The first Codex prompt was passed as the TUI's positional argv so it
      // cannot race startup input or be submitted twice.
      void report("working");
    } else {
      submitRunPrompt(initialPromptText);
    }

    return {
      meta: Eff.sync(() => state.meta),
      events: Stream.fromQueue(events),
      send: (text) =>
        Eff.suspend((): Eff.Effect<void, SendError> => {
          if (state.closed) {
            return new SendError({ message: "Subagent session is closed." });
          }
          return Eff.sync(() => startRun(text));
        }),
      takeOver: Eff.promise(takeOver),
      interrupt: Eff.promise(interrupt),
    } satisfies SubagentSession;
  });
}

/** The private pi session file inside the per-agent session dir. Discovery is
 * deterministic: only a file whose content carries OUR session id is eligible
 * (the id pi creates from `--session-id`). A stale file from a crashed parent
 * session in the same dir never hijacks the watch. */
export function findPiSessionFile(
  sessionDir: string,
  sessionId: string,
): string | undefined {
  const candidates: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl"))
        candidates.push(full);
    }
  };
  walk(sessionDir);
  return candidates.find((candidate) => {
    try {
      const head = fs.readFileSync(candidate, "utf8").slice(0, 2_048);
      return head.includes(sessionId);
    } catch {
      return false;
    }
  });
}
