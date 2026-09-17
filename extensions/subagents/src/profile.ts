/**
 * Pure helpers that translate a resolved profile into the concrete child
 * launch behavior: tool policy, system-prompt/context framing, and nesting
 * checks. Kept free of effects so every rule is unit-testable.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ContextMode } from "./config.ts";
import type { ChildToolPolicy, NestContext } from "./domain.ts";

/** Default surface for read-only profiles. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

/**
 * Orchestration tools disabled on every child surface unless a profile's
 * explicit allowlist names them (`subagent_spawn` is additionally kept for a
 * genuinely nesting-capable child — see `childToolLoadout`). `ask_question`
 * is deliberately absent: every child, narrowed or not, keeps the ability to
 * ask the orchestrator.
 */
export const CHILD_ORCHESTRATION_TOOLS = [
  "subagent_spawn",
  "subagent_send",
  "subagent_wait",
  "subagent_cancel",
  "subagent_check",
  "subagent_list",
  "workflow",
  "ask_user",
] as const;

/** Ask-the-orchestrator tool kept in every child, allowlist or default. */
export const CHILD_ASK_TOOL = "ask_question";

/** Nesting bridge kept only for genuinely nesting-capable children. */
export const CHILD_NESTED_SPAWN_TOOL = "subagent_spawn";

/** Derive the child tool policy from a profile's behavior. */
export function toolPolicyFor(behavior: {
  readonly tools?: readonly string[];
  readonly readOnly?: boolean;
}): ChildToolPolicy {
  if (behavior.readOnly) {
    return {
      tools: behavior.tools ?? READ_ONLY_TOOLS,
      readOnly: true,
    };
  }
  return behavior.tools ? { tools: behavior.tools } : {};
}

/** Resolved child tool surface for one profile. */
export interface ChildToolLoadout {
  /** Explicit allowlist. When present, every tool not named is disabled —
   * built-in, extension-registered, or SDK custom. `undefined` keeps the
   * normal default surface minus `exclude`. */
  readonly tools?: readonly string[];
  /** Names disabled after the allowlist/default surface is applied. */
  readonly exclude: readonly string[];
}

/**
 * Resolve the concrete child tool surface. A narrowed profile (read-only or
 * explicit `tools`) always produces a REAL allowlist, so a built-in or
 * extension tool that is not named (PowerShell, bg_start, remote_*…) cannot
 * leak in through an incomplete exclusion universe. The default (unnarrowed)
 * surface stays denylist-based so a normal coder keeps every tool it needs.
 *
 * `nestedSpawn` grants the nesting bridge only when the caller genuinely
 * provides a nested-spawn callback and an allowlist of child profiles.
 */
export function childToolLoadout(
  policy: ChildToolPolicy | undefined,
  options: { readonly nestedSpawn?: boolean } = {},
): ChildToolLoadout {
  const nested: readonly string[] = options.nestedSpawn
    ? [CHILD_NESTED_SPAWN_TOOL]
    : [];
  const allowlist =
    policy?.tools ?? (policy?.readOnly ? READ_ONLY_TOOLS : undefined);
  if (allowlist) {
    return {
      tools: [...new Set([...allowlist, CHILD_ASK_TOOL, ...nested])],
      exclude: [],
    };
  }
  return {
    exclude: CHILD_ORCHESTRATION_TOOLS.filter((tool) => !nested.includes(tool)),
  };
}

/** Resolve the effective system-prompt text for a profile: either the inline
 * `systemPrompt` or the contents of `promptFile` (relative to the agent dir,
 * or absolute). Missing file is an error — fail closed. */
export function loadProfileSystemPrompt(
  agentDir: string,
  behavior: {
    readonly systemPrompt?: string;
    readonly promptFile?: string;
  },
): string | undefined {
  if (behavior.systemPrompt !== undefined) return behavior.systemPrompt;
  if (behavior.promptFile === undefined) return undefined;
  const resolved = path.isAbsolute(behavior.promptFile)
    ? behavior.promptFile
    : path.join(agentDir, behavior.promptFile);
  try {
    return fs.readFileSync(resolved, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not load prompt file ${resolved}: ${message}`);
  }
}

/** Frame the child prompt: optional summary context, then the injected
 * system prompt, then the task. All profiles prepend above the task. */
export function buildChildPrompt(options: {
  prompt: string;
  systemPrompt?: string;
  contextMode: ContextMode;
  parentCwd: string;
  parentSessionId?: string;
}): string {
  let text = options.prompt;
  if (options.contextMode === "summary") {
    text =
      `[parent context]\nparent session: ${options.parentSessionId ?? "?"} ` +
      `in ${options.parentCwd}\n\n${text}`;
  }
  if (options.systemPrompt) {
    text = `[system prompt]\n${options.systemPrompt}\n\n${text}`;
  }
  return text;
}

/** May a session at `nest.depth` spawn profile `profile`? Allowlist AND depth
 * budget taken from the CURRENT session's nest context. */
export function nestingAllowed(nest: NestContext, profile: string): boolean {
  return nest.allow.includes(profile) && nest.depth + 1 <= nest.maxDepth;
}
