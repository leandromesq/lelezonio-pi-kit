/**
 * The default-off gate.
 *
 * The eight browser tools are registered but **inactive** by default: they
 * are removed from the active-tool set so their prompt snippets/guidelines
 * drop out of the system prompt and they are not callable, until the user
 * opts in per session with `/browser on`. The bit is persisted as a custom
 * session entry so `/reload` and pi restarts keep it on for the same
 * session; a fresh session (no entries) defaults to off.
 *
 * Everything in this module is pure/structural so the gate logic can be
 * unit-tested without a pi runtime.
 */

/** The eight tool names registered by this extension. */
export const BROWSER_TOOL_NAMES = [
  "browser_goto",
  "browser_eval",
  "browser_console",
  "browser_network",
  "browser_fill",
  "browser_click",
  "browser_screenshot",
  "browser_close",
] as const;

/** Custom-entry type used to persist the per-session enable bit. */
export const ENABLED_ENTRY_TYPE = "browser-enabled";

/**
 * Minimal structural view of a session custom entry, matching pi's
 * CustomEntry { type: "custom", customType, data } shape without importing
 * the pi package (keeps this module unit-testable standalone).
 */
export interface GateEntryLike {
  customType?: string;
  data?: unknown;
}

/**
 * Recompute the desired gate from a session's entries. The newest entry
 * wins; any entry without a boolean `on` payload leaves the previous value
 * unchanged, so unrelated/broken entries never flip the gate.
 *
 * Accepts plain objects (structural) so it works directly on pi's
 * `sessionManager.getEntries()` output without importing the pi package.
 */
export function computeEnabledFromEntries(
  entries: readonly unknown[],
): boolean {
  let want = false;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    if (!("customType" in entry) || !("data" in entry)) continue;
    const e = entry as GateEntryLike;
    if (e.customType !== ENABLED_ENTRY_TYPE) continue;
    const data = e.data as { on?: boolean } | undefined;
    if (data && typeof data.on === "boolean") want = data.on;
  }
  return want;
}

/**
 * Apply the gate to a copy of the currently active tool set: add or remove
 * this extension's tool names, preserving every other active tool.
 */
export function applyGate(
  activeTools: readonly string[],
  on: boolean,
): string[] {
  const active = new Set(activeTools);
  for (const name of BROWSER_TOOL_NAMES) {
    if (on) active.add(name);
    else active.delete(name);
  }
  return Array.from(active);
}

/** Argument parsing for the /browser command. */
export type BrowserCommand = "on" | "off" | "status";

export function parseBrowserCommand(args: string | undefined): BrowserCommand {
  const cmd = (args ?? "").trim().toLowerCase();
  if (cmd === "on" || cmd === "enable") return "on";
  if (cmd === "off" || cmd === "disable" || cmd === "close" || cmd === "kill") {
    return "off";
  }
  return "status";
}
