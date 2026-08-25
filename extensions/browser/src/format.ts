/**
 * Text rendering for the observation buffers.
 *
 * Kept as pure functions so the exact output the LLM sees is unit-testable
 * without a browser: given captured entries and the caller's options, produce
 * the bounded text payload for browser_console / browser_network.
 */

import type { ConsoleEntry, NetEntry } from "./types.ts";

/** Render buffered console/pageerror entries: one line each, oldest first. */
export function renderConsoleText(entries: readonly ConsoleEntry[]): string {
  const lines = entries.map((e) => {
    const when = new Date(e.ts).toISOString();
    const where = e.location ? `  @ ${e.location}` : "";
    return `[${when}] ${e.type}: ${e.text}${where}`;
  });
  return lines.join("\n") || "(empty)";
}

/** Options controlling browser_network output width. */
export interface NetworkRenderOptions {
  /** Inline curated (plus caller-requested) headers on each row. */
  showHeaders: boolean;
  /** Effective header allow-list (lowercased). */
  allow: ReadonlySet<string>;
}

/**
 * Render buffered network entries. Default output is one terse line per
 * request: `<status|ERR> <method> <url>`. With showHeaders, curated
 * request headers (`→`) and response headers (`←`) are inlined under the row.
 */
export function renderNetworkText(
  entries: readonly NetEntry[],
  options: NetworkRenderOptions,
): string {
  const lines: string[] = [];
  for (const e of entries) {
    const status = e.status ?? "ERR";
    const failure = e.failure ? `  (${e.failure})` : "";
    lines.push(`${status} ${e.method} ${e.url}${failure}`);
    if (options.showHeaders) {
      for (const [k, v] of Object.entries(e.requestHeaders ?? {})) {
        if (options.allow.has(k.toLowerCase()))
          lines.push(`  \u2192 ${k}: ${v}`);
      }
      for (const [k, v] of Object.entries(e.responseHeaders ?? {})) {
        if (options.allow.has(k.toLowerCase()))
          lines.push(`  \u2190 ${k}: ${v}`);
      }
    }
  }
  return lines.join("\n") || "(empty)";
}
