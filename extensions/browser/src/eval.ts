/**
 * browser_eval source handling.
 *
 * Playwright's `page.evaluate(string)` treats the string as an *expression*,
 * so a user-supplied `() => foo` would evaluate to a function *value* instead
 * of calling it. The robust approach (same as the upstream extension) is to
 * ask the page itself: evaluate the source once and, if the result is a
 * function, call it. That makes all three input forms behave as users expect:
 *
 *   - plain expression:   `localStorage.length`
 *   - function source:    `() => Object.keys(localStorage)`  (called once)
 *   - already-called IIFE `(() => 42)()`
 *
 * Two hardening tweaks over the naive inline wrapper:
 *   - the source is placed on its own line so a trailing `// comment` in the
 *     source cannot swallow the closing `);` of the assignment,
 *   - `typeof __v === "function"` uses the double-quoted string so the
 *     wrapper survives pages that redefine which quotes are "safe" (no-op).
 *
 * The returned value is serialized with a bounded, failure-tolerant
 * stringifier: circular structures and BigInts stringify, results that
 * JSON.stringify turns into `undefined` get a String() fallback, and output
 * is capped so an accidental `JSON.stringify(window)` can't flood the LLM's
 * context window.
 */

/** Cap on the rendered text of one browser_eval result. */
export const MAX_EVAL_TEXT = 50_000;

/**
 * Wrap arbitrary user source so it evaluates to a value (calling function
 * results exactly once). The source sits on its own line(s) between the
 * assignment's parens, so a trailing `// comment` in the source cannot
 * swallow the closing `);`.
 */
export function wrapEvalSource(src: string): string {
  return [
    "(() => {",
    "  const __v = (",
    src,
    "  );",
    '  return typeof __v === "function" ? __v() : __v;',
    "})()",
  ].join("\n");
}

function safeStringify(result: unknown): string | undefined {
  try {
    return JSON.stringify(result, null, 2) ?? undefined;
  } catch {
    // circular structures, BigInt, exotic objects...
    try {
      return String(result);
    } catch {
      return undefined;
    }
  }
}

/** Render a page.evaluate result to bounded text for tool content. */
export function stringifyEvalResult(result: unknown): string {
  const text = safeStringify(result) ?? String(result);
  return text.length > MAX_EVAL_TEXT
    ? `${text.slice(0, MAX_EVAL_TEXT)}\n\u2026[truncated]`
    : text;
}
