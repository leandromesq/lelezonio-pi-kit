/**
 * Header capture and rendering policy.
 *
 * All request/response headers are captured into the network ring buffer,
 * because `browser_network`'s `includeHeaders` lets a caller surface
 * arbitrary header names on demand. To keep that buffer bounded in memory,
 * the captured maps are themselves bounded: at most MAX_HEADER_FIELDS
 * entries per request, and each value truncated to MAX_HEADER_VALUE chars.
 *
 * Rendering (filterHeaders) is the opposite direction: it keeps only the
 * names the caller opted into (the curated auth/debug set, plus anything
 * requested via includeHeaders). This keeps the default tool output terse.
 */

import { truncate } from "./buffer.ts";

/** Curated set of headers surfaced by default when verbose mode is on. */
export const KEEP_HEADERS = new Set([
  "authorization",
  "apikey",
  "content-type",
  "x-client-info",
  "accept-profile",
  "content-profile",
  "prefer",
  "location",
  "www-authenticate",
  "retry-after",
]);

/** Maximum header fields stored per captured request. */
export const MAX_HEADER_FIELDS = 64;
/** Maximum length of a stored header value. */
export const MAX_HEADER_VALUE = 512;

/**
 * Bounded capture: keep at most MAX_HEADER_FIELDS fields, truncate any value
 * longer than MAX_HEADER_VALUE. Order is preserved; longer maps lose their
 * tail fields (header iteration order is stable in practice for a single
 * request's map).
 */
export function boundHeaders(
  h: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  let count = 0;
  for (const [k, v] of Object.entries(h)) {
    if (count >= MAX_HEADER_FIELDS) break;
    out[k] = truncate(v, MAX_HEADER_VALUE);
    count++;
  }
  return out;
}

/** Keep only the header fields whose lowercase name is in `allow`. */
export function filterHeaders(
  h: Record<string, string>,
  allow: ReadonlySet<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (allow.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/**
 * Resolve the effective allow-list for one browser_network call:
 * the curated default set plus any caller-requested names (lowercased).
 */
export function allowListFor(
  includeHeaders: readonly string[] | undefined,
): Set<string> {
  const allow = new Set(KEEP_HEADERS);
  for (const name of includeHeaders ?? []) allow.add(name.toLowerCase());
  return allow;
}
