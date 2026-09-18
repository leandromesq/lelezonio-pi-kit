import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTranscriptCache } from "./src/ui/transcript.ts";

type Theme = ExtensionContext["ui"]["theme"];

const themeA = {} as Theme;
const themeB = {} as Theme;

test("same revision, width and theme return the memoized lines", () => {
  const cache = createTranscriptCache();
  const first = cache.get("alpha beta gamma", 1, 40, themeA);
  const second = cache.get("a totally different transcript", 1, 40, themeA);
  // Same key, different text: the cache must not re-wrap. The identity of the
  // returned array is the observable proof that no work happened.
  assert.equal(second, first);
  assert.deepEqual(second, ["alpha beta gamma"]);
});

test("a bumped transcript revision re-wraps", () => {
  const cache = createTranscriptCache();
  cache.get("one", 1, 40, themeA);
  const bumped = cache.get("two", 2, 40, themeA);
  assert.deepEqual(bumped, ["two"]);
});

test("a width change re-wraps at the new width", () => {
  const cache = createTranscriptCache();
  const wide = cache.get("aaaa bbbb cccc", 1, 40, themeA);
  const narrow = cache.get("aaaa bbbb cccc", 1, 10, themeA);
  assert.notEqual(narrow, wide);
  assert.ok(narrow.length > wide.length, "expected the narrow wrap to grow");
});

test("a theme change and invalidate() both drop the memo", () => {
  const cache = createTranscriptCache();
  const first = cache.get("one\n\ntwo", 1, 40, themeA);
  const otherTheme = cache.get("one\n\ntwo", 1, 40, themeB);
  assert.notEqual(otherTheme, first);
  assert.deepEqual(otherTheme, first);

  cache.invalidate();
  const afterInvalidate = cache.get("one\n\ntwo", 1, 40, themeA);
  assert.notEqual(afterInvalidate, first);
  assert.deepEqual(afterInvalidate, first);
});
