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

export function shouldRefreshAfterTool(toolName: string): boolean {
  return !READ_ONLY_TOOLS.has(toolName);
}

/** Git status is display-only; headless children have no consumer. */
export function shouldTrackGit(mode: string): boolean {
  return mode === "tui";
}
