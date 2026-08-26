/**
 * Pure helpers that translate a resolved profile into the concrete child
 * launch behavior: tool policy, system-prompt/context framing, and nesting
 * checks. Kept free of effects so every rule is unit-testable.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ContextMode } from "./config.ts";
import type { ChildToolPolicy, NestContext } from "./domain.ts";

/** Builtin pi tool names available in a child session. */
export const PI_BUILTIN_TOOLS = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
] as const;

/** Default surface for read-only profiles. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

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

/** Tools that must be EXCLUDED (e.g. via `--exclude-tools`) given a policy.
 * An explicit allowlist flips the model: everything built-in not listed is
 * excluded. readOnly without an allowlist excludes the writing trio. */
export function extraExcludedTools(
  policy: ChildToolPolicy | undefined,
): readonly string[] {
  if (!policy) return [];
  const tools = policy.tools;
  if (tools) {
    return PI_BUILTIN_TOOLS.filter((tool) => !tools.includes(tool));
  }
  if (policy.readOnly) return ["write", "edit", "bash"];
  return [];
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
