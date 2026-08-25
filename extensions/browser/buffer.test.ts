/**
 * Unit tests for the bounded buffer helpers (src/buffer.ts).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  boundPush,
  drainLast,
  MAX_BUFFER_ENTRIES,
  truncate,
} from "./src/buffer.ts";

test("truncate leaves short strings untouched", () => {
  assert.equal(truncate("short", 1000), "short");
  assert.equal(truncate("", 10), "");
});

test("truncate cuts long strings and marks the cut", () => {
  const long = "x".repeat(5000);
  const out = truncate(long, 100);
  assert.equal(out.length, 100);
  assert.ok(out.endsWith("\u2026[truncated]"));
  assert.ok(out.startsWith("x"));
});

test("truncate handles a max smaller than the marker", () => {
  const out = truncate("abcdef", 4);
  assert.equal(out, "abcd");
});

test("boundPush evicts the oldest entry past the cap", () => {
  const buf: number[] = [];
  for (let i = 0; i < MAX_BUFFER_ENTRIES + 1; i++) boundPush(buf, i);
  assert.equal(buf.length, MAX_BUFFER_ENTRIES);
  assert.equal(buf[0], 1); // entry 0 was evicted
  assert.equal(buf[buf.length - 1], MAX_BUFFER_ENTRIES);
});

test("drainLast returns the newest entries oldest-first", () => {
  const buf = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.deepEqual(drainLast(buf, 3), [8, 9, 10]);
  assert.deepEqual(drainLast(buf, 100), buf);
  assert.deepEqual(drainLast([], 5), []);
});
