/**
 * Bounded in-memory buffers.
 *
 * Every capture path in the extension funnels through these helpers so a
 * misbehaving page can never grow the extension's memory without limit:
 * - the ring buffers themselves cap entry counts,
 * - per-entry text fields are truncated (console text, URLs),
 * - raw header maps are bounded in field count and value length (headers.ts).
 */

/** Maximum number of entries held in either ring buffer. */
export const MAX_BUFFER_ENTRIES = 1000;
/** Maximum captured console/pageerror text length (chars). */
export const MAX_CONSOLE_TEXT = 2000;
/** Maximum captured request/URL length (chars). */
export const MAX_URL = 1024;

const TRUNCATED_SUFFIX = "\u2026[truncated]";

/** Cut `s` to at most `max` chars, appending an explicit truncation marker. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const suffix = TRUNCATED_SUFFIX;
  if (max <= suffix.length) return s.slice(0, max);
  return s.slice(0, max - suffix.length) + suffix;
}

/** Truncate a console/pageerror message before buffering. */
export function boundConsoleText(s: string): string {
  return truncate(s, MAX_CONSOLE_TEXT);
}

/** Truncate a captured URL before buffering. */
export function boundUrl(s: string): string {
  return truncate(s, MAX_URL);
}

/**
 * Append to a ring buffer, evicting the oldest entries once the cap is hit.
 * O(n) splice on eviction, but eviction is rare (only past the cap) and the
 * cap is small (1000).
 */
export function boundPush<T>(buf: T[], entry: T): void {
  buf.push(entry);
  if (buf.length > MAX_BUFFER_ENTRIES) {
    buf.splice(0, buf.length - MAX_BUFFER_ENTRIES);
  }
}

/** Newest `limit` entries, oldest first (the ring buffer is time-ordered). */
export function drainLast<T>(buf: readonly T[], limit: number): T[] {
  return buf.slice(-limit);
}
