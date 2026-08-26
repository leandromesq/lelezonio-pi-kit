/**
 * Domain model for subagents.
 *
 * Everything downstream of a backend (manager, tools, UI) speaks only these
 * types. Backends translate their native streams (pi session events and
 * Codex app-server JSON-RPC notifications) into the normalized
 * `SubagentEvent` union.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Data } from "effect";

export const BACKEND_NAMES = ["pi", "codex"] as const;
export type BackendName = (typeof BACKEND_NAMES)[number];

/** Who initiated the session. User asides stay out of model-facing tooling. */
export type SubagentOrigin = "model" | "btw";

/**
 * Shared reasoning-effort scale (pi's thinking levels). Each backend maps a
 * value to its nearest native equivalent: pi uses it directly and codex
 * translates to its reasoning-effort slugs. Omitted = backend default
 * (pi inherits the parent level).
 */
export const REASONING_EFFORTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type SubagentStatus = "running" | "done" | "error";

/** Tool-surface policy for a child, derived from its profile. */
export interface ChildToolPolicy {
  /** Explicit pi tool allowlist (builtin names). When present, everything
   * else is excluded. */
  readonly tools?: readonly string[];
  /** Read-only child: no write/edit/bash, codex sandbox forced read-only. */
  readonly readOnly?: boolean;
}

/** Nesting capability: which profiles a child may spawn, and at what depth. */
export interface NestContext {
  readonly allow: readonly string[];
  /** Depth of the CURRENT session (top-level spawn = 0). */
  readonly depth: number;
  /** Maximum depth; children may spawn only while depth+1 <= maxDepth. */
  readonly maxDepth: number;
}

export interface SpawnChildResult {
  readonly id: string;
  readonly text: string;
  readonly error?: string;
}

export type SpawnChildFn = (options: {
  readonly profile: string;
  readonly task: string;
  readonly name?: string;
  readonly nest: NestContext;
}) => Promise<SpawnChildResult>;

/** Parent-session context resolved by the tool layer and passed opaquely. */
export interface ParentContext {
  readonly parentCwd: string;
  readonly projectTrusted: boolean;
  /** Parent pi session id — collision-safe prefix for Herdr agent names. */
  readonly parentSessionId?: string;
  /** Parent pi model, for the pi backend's "inherit" default. */
  readonly inheritedModel?: { readonly provider: string; readonly id: string };
  readonly inheritedThinkingLevel?: string;
  /** Parent model registry; required by the pi backend to resolve models. */
  readonly modelRegistry?: ModelRegistry;
  /** Profile-derived tool policy applied to the child. */
  readonly toolPolicy?: ChildToolPolicy;
  /** Nesting context when the child may spawn its own subagents. */
  readonly nest?: NestContext;
  /** Local spawn callback for nested children (headless only, see pi.ts). */
  readonly spawnChild?: SpawnChildFn;
}

export interface SpawnTask {
  /** Omitted for normal tool-driven spawns. */
  readonly origin?: SubagentOrigin;
  /**
   * Logical subagent id ("sa-3" / "btw-1") allocated by the manager BEFORE
   * the backend spawn so Herdr pane titles and technical agent names can be
   * derived deterministically. Backends must not allocate their own.
   */
  readonly logicalId?: string;
  /** Resolved subagent profile name, when the spawn used a configured
   * profile. Displayed in pane titles; also carried for identity. */
  readonly profile?: string;
  readonly prompt: string;
  readonly title: string;
  readonly cwd: string;
  /**
   * Generic model hint, interpreted per backend:
   * pi: "provider/model-id" or bare model id; codex: model slug.
   * Omitted = backend default / inherit.
   */
  readonly model?: string;
  /** Shared effort scale; each backend maps it to its native equivalent. */
  readonly reasoningEffort?: ReasoningEffort;
  readonly parent: ParentContext;
}

/**
 * The pane/agent-visible title: `[<logicalId> · <profile|backend>] <title>`.
 * Used by the manager snapshot and the Herdr worker pane identically so the
 * pane label always matches the dashboard row.
 */
export function subagentDisplayTitle(
  backend: BackendName,
  task: Pick<SpawnTask, "title" | "logicalId" | "profile">,
): string {
  const tag = task.profile ?? backend;
  return `[${task.logicalId} · ${tag}] ${task.title}`;
}

export interface SubagentMeta {
  readonly backend: BackendName;
  /** Display label, e.g. "openai-codex/gpt-5.6-sol" or "gpt-5-codex". */
  readonly modelLabel?: string;
  /** Context window capacity for utilization display, when known. */
  readonly contextWindow?: number;
  /** Pi session file or Codex rollout path. */
  readonly sessionFilePath?: string;
  /** Native Pi session id or Codex conversation id. */
  readonly nativeSessionId?: string;
  /** Herdr worker pane hosting this subagent (when spawned inside Herdr). */
  readonly herdrPaneId?: string;
  /** Technical Herdr agent name (collision-safe parent prefix + logical id). */
  readonly herdrAgentName?: string;
  /** True once the user took the pane over (pane survives settle/close). */
  readonly takenOver?: boolean;
}

// --- Transcript ------------------------------------------------------------

export type TranscriptPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "thinking";
      readonly text: string;
      readonly redacted?: boolean;
    }
  | {
      readonly type: "toolCall";
      readonly toolId: string;
      readonly name: string;
      readonly argsPreview?: string;
    };

export type TranscriptItem =
  | { readonly kind: "user"; readonly text: string }
  | {
      readonly kind: "assistant";
      readonly parts: ReadonlyArray<TranscriptPart>;
    }
  | {
      readonly kind: "toolResult";
      readonly toolId: string;
      readonly name: string;
      readonly isError: boolean;
      readonly outputPreview?: string;
    };

export interface LiveToolState {
  readonly toolId: string;
  readonly name: string;
  readonly argsPreview?: string;
  readonly outputPreview?: string;
  readonly done?: boolean;
  readonly isError?: boolean;
}

export interface QueuedMessage {
  readonly text: string;
  readonly kind: "steer" | "follow-up";
}

// --- Events ------------------------------------------------------------------

export type RunOutcome =
  | { readonly _tag: "Completed"; readonly finalText: string }
  | {
      readonly _tag: "Failed";
      readonly errorText: string;
      readonly partialText?: string;
    }
  | { readonly _tag: "Interrupted"; readonly partialText?: string };

/**
 * Normalized activity stream. Previews (`argsPreview`, `outputPreview`) are
 * pre-flattened single-line strings because the UI only ever renders one
 * sanitized line, which keeps three different native tool-result shapes out
 * of the interface.
 */
export type SubagentEvent =
  // lifecycle (a session can run multiple turns via send())
  | { readonly _tag: "RunStarted" }
  | { readonly _tag: "RunSettled"; readonly outcome: RunOutcome }
  // transcript building blocks
  | { readonly _tag: "UserMessage"; readonly text: string }
  | {
      readonly _tag: "AssistantDelta";
      readonly kind: "text" | "thinking";
      readonly delta: string;
    }
  | {
      readonly _tag: "AssistantMessage";
      readonly parts: ReadonlyArray<TranscriptPart>;
    }
  | {
      readonly _tag: "ToolStart";
      readonly toolId: string;
      readonly name: string;
      readonly argsPreview?: string;
    }
  | {
      readonly _tag: "ToolUpdate";
      readonly toolId: string;
      readonly outputPreview?: string;
    }
  | {
      readonly _tag: "ToolEnd";
      readonly toolId: string;
      readonly name: string;
      readonly isError: boolean;
      readonly outputPreview?: string;
    }
  // bookkeeping
  | {
      readonly _tag: "QuestionAsked";
      readonly questionId: string;
      readonly text: string;
    }
  | {
      readonly _tag: "QueueChanged";
      readonly queued: ReadonlyArray<QueuedMessage>;
    }
  | {
      readonly _tag: "UsageChanged";
      readonly tokens?: number;
      readonly contextWindow?: number;
    }
  | { readonly _tag: "MetaChanged"; readonly meta: Partial<SubagentMeta> }
  /** Non-fatal diagnostics. Fatal failures arrive as a RunSettled outcome. */
  | { readonly _tag: "BackendError"; readonly message: string };

// --- Snapshot ---------------------------------------------------------------

/**
 * The manager folds `SubagentEvent`s into one snapshot per subagent. This is
 * everything the tools, footer status, and both TUI views read.
 */
export interface SubagentSnapshot {
  readonly id: string;
  readonly origin: SubagentOrigin;
  readonly backend: BackendName;
  readonly title: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly status: SubagentStatus;
  /** Monotonic run generation within this resumable logical session. */
  readonly run: number;
  readonly createdAt: number;
  /** Wall-clock of the last activity event (stall detection). */
  readonly lastEventAt: number;
  readonly settledAt?: number;
  readonly errorText?: string;
  readonly meta: SubagentMeta;
  readonly usage: { readonly tokens?: number; readonly contextWindow?: number };
  readonly transcript: ReadonlyArray<TranscriptItem>;
  /** Streaming assistant buffers, cleared when the finalized message lands. */
  readonly liveAssistant?: { readonly text: string; readonly thinking: string };
  readonly liveTools: ReadonlyArray<LiveToolState>;
  readonly queued: ReadonlyArray<QueuedMessage>;
  /** Final text of the most recent completed run (v1 `finalOutput`). */
  readonly finalText: string;
  /** Count of finalized assistant messages (for subagent_check). */
  readonly turns: number;
  /** Pending child→parent clarification, unanswered. Cleared on next run. */
  readonly question?: { readonly id: string; readonly text: string };
}

/** Final text, or the live streaming buffer while a run is active (v1 `latestOutput`). */
export function latestText(snap: SubagentSnapshot) {
  const live = snap.liveAssistant?.text.trim();
  if (live) return live;
  return snap.finalText;
}

export function formatElapsed(snap: SubagentSnapshot) {
  const end = snap.settledAt ?? Date.now();
  const totalSeconds = Math.max(0, Math.round((end - snap.createdAt) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m${seconds.toString().padStart(2, "0")}s`
    : `${seconds}s`;
}

// --- Errors -------------------------------------------------------------------

export class SpawnError extends Data.TaggedError("SpawnError")<{
  readonly message: string;
}> {}

export class BackendUnavailableError extends Data.TaggedError(
  "BackendUnavailableError",
)<{
  readonly message: string;
}> {}

export class ConcurrencyLimitError extends Data.TaggedError(
  "ConcurrencyLimitError",
)<{
  readonly message: string;
}> {}

export class SendError extends Data.TaggedError("SendError")<{
  readonly message: string;
}> {}
