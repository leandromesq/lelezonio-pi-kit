/**
 * Single-entry render cache keyed by width.
 *
 * The ask-user overlay only re-renders on input (which invalidates) or on a
 * terminal resize (which changes `width`). Caching the built lines without the
 * width kept a stale layout after a resize, because pi only requests a render
 * on resize — it does not call `invalidate()`.
 */
export function createWidthKeyedLineCache() {
  let width: number | undefined;
  let lines: string[] | undefined;

  return {
    get(renderWidth: number, build: () => string[]): string[] {
      if (lines && width === renderWidth) return lines;
      lines = build();
      width = renderWidth;
      return lines;
    },
    invalidate(): void {
      lines = undefined;
    },
  };
}
