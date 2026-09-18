/**
 * Render-cache primitive of `docs/ui-conventions.md` section 8: a
 * history → lines transform memoized by (revision, width, theme). Extracted
 * from the subagents and remote-agents transcript overlays, which had grown
 * two near-identical caches.
 *
 * The cache owns the memo and the append-only committed prefix: committed
 * chunks are compared by identity, so a frame that only grew re-renders just
 * the new suffix instead of the whole history. The prefix itself is keyed by
 * (width, theme) — a resize or a theme change rebuilds it. Everything
 * surface-specific — what a chunk is, how it renders, and how the volatile
 * tail is finished — stays with the caller, because a snapshot transcript and
 * a raw text blob genuinely draw those lines differently.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";

/** Diagnostics for tests: how much work the cache did, not what it retained. */
export interface TranscriptLineCacheStats {
  /** Committed chunks rendered (a full rebuild counts every chunk). */
  items: number;
  /** Full rebuilds caused by a width change or a head eviction. */
  rebuilds: number;
}

export interface TranscriptLineCacheSpec<Input, Item> {
  /** Monotonic revision of `input`; any change drops the memo. */
  revision(input: Input): number;
  /** Committed chunks, compared by identity against the previous frame. */
  items(input: Input): readonly Item[];
  /** Render one committed chunk into `out`, blank separators included. */
  renderItem(theme: Theme, item: Item, width: number, out: string[]): void;
  /**
   * Turn the copied committed prefix into the frame the caller memoizes:
   * trim trailing separators here and append the volatile tail (if any).
   */
  assemble(
    committed: string[],
    input: Input,
    width: number,
    theme: Theme,
  ): string[];
}

export interface TranscriptLineCache<Input> {
  /** Wrapped lines for `input` at `width`, recomputed only when something changed. */
  get(input: Input, width: number, theme: Theme): string[];
  /** Drop every memoized entry (resize, theme change, explicit invalidation). */
  invalidate(): void;
  /** Diagnostics for tests: how much work the cache did, not what it retained. */
  readonly stats: TranscriptLineCacheStats;
}

/**
 * Per-view cache: memoizes the assembled frame by (revision, width, theme)
 * and keeps the committed chunks' lines append-only, so a live delta costs
 * O(new chunks + tail), not O(history).
 */
export function createTranscriptLineCache<Input, Item>(
  spec: TranscriptLineCacheSpec<Input, Item>,
): TranscriptLineCache<Input> {
  const stats: TranscriptLineCacheStats = { items: 0, rebuilds: 0 };
  let memoRevision = Number.NaN;
  let memoWidth = -1;
  let memoTheme: Theme | undefined;
  let result: string[] = [];

  let committedWidth = -1;
  let committedTheme: Theme | undefined;
  let committedItems: readonly Item[] = [];
  /** Committed chunks' lines, separators included and trailing blank present. */
  let committedLines: string[] = [];

  const committedFor = (input: Input, width: number, theme: Theme) => {
    const items = spec.items(input);
    let reuse =
      width === committedWidth &&
      theme === committedTheme &&
      committedItems.length <= items.length;
    if (reuse) {
      for (let i = 0; i < committedItems.length; i++) {
        if (committedItems[i] !== items[i]) {
          reuse = false;
          break;
        }
      }
    }
    if (!reuse) {
      // The first build is a build, not a rebuild.
      if (committedWidth !== -1) stats.rebuilds++;
      committedWidth = width;
      committedTheme = theme;
      committedItems = [];
      committedLines = [];
    }
    for (let i = committedItems.length; i < items.length; i++) {
      spec.renderItem(theme, items[i], width, committedLines);
      stats.items++;
    }
    committedItems = items.slice();
    return committedLines;
  };

  return {
    get(input, width, theme) {
      const revision = spec.revision(input);
      if (
        memoRevision === revision &&
        memoWidth === width &&
        memoTheme === theme
      ) {
        return result;
      }
      // Copy so the cached committed prefix is never mutated by the assembly.
      const out = committedFor(input, width, theme).slice();
      result = spec.assemble(out, input, width, theme);
      memoRevision = revision;
      memoWidth = width;
      memoTheme = theme;
      return result;
    },
    invalidate() {
      memoRevision = Number.NaN;
      memoWidth = -1;
      memoTheme = undefined;
      committedWidth = -1;
      committedTheme = undefined;
      committedItems = [];
      committedLines = [];
      result = [];
    },
    stats,
  };
}
