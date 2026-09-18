import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createTranscriptLineCache } from "./transcript-cache.ts";

interface Input {
  items: readonly string[];
  revision: number;
  live?: string;
}

const themeA = { id: "A" } as unknown as Theme;
const themeB = { id: "B" } as unknown as Theme;

const themeId = (theme: Theme) => (theme as unknown as { id: string }).id;

/** Spec double that counts renders, so re-wrapping is observable. */
function makeCache(renders: { count: number }) {
  return createTranscriptLineCache<Input, string>({
    revision: (input) => input.revision,
    items: (input) => input.items,
    renderItem: (theme, item, width, out) => {
      renders.count++;
      out.push(`${item}@${width}:${themeId(theme)}`);
      out.push(""); // committed separator, like the transcript overlays
    },
    assemble: (committed, input) => {
      while (committed.length > 0 && committed[committed.length - 1] === "")
        committed.pop();
      if (input.live !== undefined) committed.push(`live:${input.live}`);
      return committed;
    },
  });
}

test("same revision, width and theme return the memoized frame", () => {
  const renders = { count: 0 };
  const cache = makeCache(renders);
  const first = cache.get({ items: ["a"], revision: 1 }, 40, themeA);
  const rendersAfterFirst = renders.count;

  // Same key, different items: the memo must win before the chunks are read.
  const second = cache.get(
    { items: ["completely", "different"], revision: 1 },
    40,
    themeA,
  );
  assert.strictEqual(second, first, "a hit returns the identical array");
  assert.equal(renders.count, rendersAfterFirst);
  assert.equal(cache.stats.items, 1);
  assert.equal(cache.stats.rebuilds, 0);
});

test("a revision bump re-assembles and appends only the new chunk", () => {
  const renders = { count: 0 };
  const cache = makeCache(renders);
  cache.get({ items: ["a"], revision: 1 }, 40, themeA);
  assert.equal(cache.stats.items, 1);

  const lines = cache.get({ items: ["a", "b"], revision: 2 }, 40, themeA);
  assert.equal(cache.stats.items, 2, "only the new chunk is rendered");
  assert.equal(cache.stats.rebuilds, 0);
  assert.deepEqual(lines, ["a@40:A", "", "b@40:A"]);
});

test("a changed chunk identity forces a full rebuild", () => {
  const renders = { count: 0 };
  const cache = makeCache(renders);
  cache.get({ items: ["a", "b"], revision: 1 }, 40, themeA);
  const items = cache.stats.items;
  const rebuilds = cache.stats.rebuilds;

  cache.get({ items: ["b"], revision: 2 }, 40, themeA);
  assert.equal(cache.stats.rebuilds, rebuilds + 1, "evicted head → rebuild");
  assert.ok(cache.stats.items > items);
});

test("a width change re-renders every chunk at the new width", () => {
  const renders = { count: 0 };
  const cache = makeCache(renders);
  cache.get({ items: ["a"], revision: 1 }, 40, themeA);
  const rebuilds = cache.stats.rebuilds;

  const lines = cache.get({ items: ["a"], revision: 1 }, 60, themeA);
  assert.equal(cache.stats.rebuilds, rebuilds + 1, "width change → rebuild");
  assert.deepEqual(lines, ["a@60:A"]);
});

test("a theme change rebuilds the committed prefix at the new theme", () => {
  const renders = { count: 0 };
  const cache = makeCache(renders);
  const first = cache.get({ items: ["a"], revision: 1 }, 40, themeA);

  const otherTheme = cache.get({ items: ["a"], revision: 1 }, 40, themeB);
  assert.notEqual(otherTheme, first, "a new frame array is returned");
  assert.deepEqual(otherTheme, ["a@40:B"]);
  assert.equal(cache.stats.items, 2, "the chunk re-rendered for the new theme");
});

test("the volatile tail is appended after the committed lines", () => {
  const renders = { count: 0 };
  const cache = makeCache(renders);
  const lines = cache.get(
    { items: ["a", "b"], revision: 1, live: "streaming" },
    40,
    themeA,
  );
  assert.deepEqual(lines, ["a@40:A", "", "b@40:A", "live:streaming"]);
  assert.equal(cache.stats.items, 2, "the tail is not a committed chunk");
});

test("invalidate drops the memo so the next frame re-renders", () => {
  const renders = { count: 0 };
  const cache = makeCache(renders);
  cache.get({ items: ["a"], revision: 1 }, 40, themeA);
  cache.invalidate();

  cache.get({ items: ["a"], revision: 1 }, 40, themeA);
  assert.equal(renders.count, 2);
});
