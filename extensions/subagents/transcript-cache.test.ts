import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentSnapshot, TranscriptItem } from "./src/domain.ts";
import { createTranscriptLineCache } from "./src/ui/transcript.ts";

type Theme = ExtensionContext["ui"]["theme"];

/** Theme double that counts `fg` calls, so re-wrapping is observable. */
function themeSpy() {
  const counts = { fg: 0 };
  const theme = {
    fg: (role: string, text: string) => {
      counts.fg++;
      return `[${role}]${text}`;
    },
    italic: (text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  return { theme, counts };
}

const userItem = (text: string): TranscriptItem => ({ kind: "user", text });

function snapshot(overrides: Partial<SubagentSnapshot>): SubagentSnapshot {
  return {
    id: "sa-1",
    origin: "model",
    backend: "pi",
    title: "test",
    prompt: "",
    cwd: "",
    status: "running",
    run: 1,
    createdAt: 0,
    lastEventAt: 0,
    meta: { backend: "pi" },
    usage: {},
    transcript: [],
    transcriptVersion: 0,
    liveTools: [],
    queued: [],
    finalText: "",
    turns: 0,
    ...overrides,
  };
}

test("same revision, width and theme reuses the previous lines", () => {
  const { theme, counts } = themeSpy();
  const cache = createTranscriptLineCache();
  const snap = snapshot({
    transcript: [userItem("hello world")],
    transcriptVersion: 1,
  });

  const first = cache.get(snap, 40, theme);
  const fgAfterFirst = counts.fg;
  assert.ok(first.length > 0);

  const second = cache.get(snap, 40, theme);
  assert.strictEqual(second, first, "a hit returns the identical array");
  assert.equal(counts.fg, fgAfterFirst, "a hit must not touch the theme");
  assert.equal(cache.stats.items, 1);
  assert.equal(cache.stats.rebuilds, 0);
});

test("a live-only revision appends the tail without re-wrapping the prefix", () => {
  const { theme, counts } = themeSpy();
  const cache = createTranscriptLineCache();
  const item = userItem("first");
  cache.get(snapshot({ transcript: [item], transcriptVersion: 1 }), 40, theme);
  const itemsAfterCommit = cache.stats.items;
  const fgAfterCommit = counts.fg;

  const lines = cache.get(
    snapshot({
      transcript: [item],
      transcriptVersion: 2,
      liveAssistant: { text: "streaming answer", thinking: "pondering" },
    }),
    40,
    theme,
  );

  assert.ok(lines.some((line) => line.includes("streaming answer")));
  assert.ok(lines.some((line) => line.includes("pondering")));
  assert.equal(cache.stats.items, itemsAfterCommit);
  assert.equal(cache.stats.rebuilds, 0);
  assert.ok(counts.fg > fgAfterCommit, "the live tail renders");
});

test("an appended item renders only the suffix", () => {
  const { theme } = themeSpy();
  const cache = createTranscriptLineCache();
  const a = userItem("a");
  const b = userItem("b");

  cache.get(snapshot({ transcript: [a], transcriptVersion: 1 }), 40, theme);
  assert.equal(cache.stats.items, 1);
  cache.get(snapshot({ transcript: [a, b], transcriptVersion: 2 }), 40, theme);
  assert.equal(cache.stats.items, 2, "only the new item is wrapped");
  assert.equal(cache.stats.rebuilds, 0);
});

test("a head eviction or width change forces a full rebuild", () => {
  const { theme } = themeSpy();
  const cache = createTranscriptLineCache();
  const a = userItem("a");
  const b = userItem("b");
  cache.get(snapshot({ transcript: [a, b], transcriptVersion: 1 }), 40, theme);
  const items = cache.stats.items;
  const rebuilds = cache.stats.rebuilds;

  cache.get(snapshot({ transcript: [b], transcriptVersion: 2 }), 40, theme);
  assert.equal(cache.stats.rebuilds, rebuilds + 1, "evicted head → rebuild");

  cache.get(snapshot({ transcript: [b], transcriptVersion: 3 }), 60, theme);
  assert.equal(cache.stats.rebuilds, rebuilds + 2, "width change → rebuild");
  assert.ok(cache.stats.items > items);
});

test("invalidate drops the memo so the next frame re-wraps", () => {
  const { theme, counts } = themeSpy();
  const cache = createTranscriptLineCache();
  const snap = snapshot({ transcript: [userItem("x")], transcriptVersion: 1 });

  cache.get(snap, 40, theme);
  cache.invalidate();
  const fg = counts.fg;
  cache.get(snap, 40, theme);
  assert.ok(counts.fg > fg);
});
