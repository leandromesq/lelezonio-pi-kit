/** Read-only inspections cannot change repository status. Unknown tools may. */
const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "rg",
  "fd",
  "web_search",
  "web_fetch",
  "web_crawl",
  "subagent_check",
  "subagent_list",
  "bg_status",
  "bg_list",
  "remote_check",
  "remote_list",
]);

/** Interactive footer cadence: fast enough to feel live next to the editor. */
export const POLL_INTERVAL_MS = 15_000;

/**
 * Subagent footer cadence. Children launched through the Herdr worker carry
 * `PI_SUBAGENT=1` in their env; they still own a visible footer pane, so the
 * poll keeps running there — just slow enough that a child coding at ~1
 * mutation/s does not pay hundreds of `git` spawns per minute for a pane
 * nobody watches continuously.
 */
export const SUBAGENT_POLL_INTERVAL_MS = 60_000;

/**
 * Detect a subagent child. Takes the env as an argument (instead of reading
 * `process.env` itself) so the gate stays pure and testable.
 */
export function isSubagentProcess(env: {
  PI_SUBAGENT?: string | undefined;
}): boolean {
  return env.PI_SUBAGENT === "1";
}

/**
 * Whether a finished tool call should trigger a Git refresh.
 *
 * A subagent child never refreshes per tool call: one refresh runs ~4-5
 * `git`/`gh` processes, and the children of a task usually mutate the same
 * repo, so per-mutation refreshes multiply into a spawn storm for a footer
 * that is rarely watched. The child footer stays coherent through the poll.
 */
export function shouldRefreshAfterTool(
  toolName: string,
  isSubagent = false,
): boolean {
  if (isSubagent) return false;
  return !READ_ONLY_TOOLS.has(toolName);
}

/**
 * Whether submitted input should trigger a Git refresh. Same rationale as
 * `shouldRefreshAfterTool`: in a child, the user is only opening the worker
 * pane, which does not change the working tree.
 */
export function shouldRefreshOnInput(isSubagent: boolean): boolean {
  return !isSubagent;
}

/** Poll cadence; a child polls slower than an interactive process. */
export function pollIntervalMs(isSubagent: boolean): number {
  return isSubagent ? SUBAGENT_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
}

/** Git status is display-only; headless children have no consumer. */
export function shouldTrackGit(mode: string): boolean {
  return mode === "tui";
}
