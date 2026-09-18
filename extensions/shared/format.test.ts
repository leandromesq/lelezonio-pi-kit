import assert from "node:assert/strict";
import { test } from "node:test";
import { formatElapsed, formatTokens } from "./format.ts";

test("formatElapsed renders seconds, padded minutes and hours", () => {
  const start = 1_000_000;
  assert.equal(formatElapsed(start, start), "0s");
  assert.equal(formatElapsed(start, start + 7_400), "7s");
  assert.equal(formatElapsed(start, start + 127_000), "2m07s");
  assert.equal(formatElapsed(start, start + 3_600_000), "1h00m");
  assert.equal(formatElapsed(start, start + 4_380_000), "1h13m");
});

test("formatElapsed clamps negative ranges and treats non-finite end as open", () => {
  const start = 2_000_000;
  assert.equal(formatElapsed(start, start - 5_000), "0s");
  // Non-finite `finishedAt` means "still running": fall back to now, which for
  // this ancient start is an hours-scale duration.
  assert.match(formatElapsed(start, Number.NaN), /^\d+h\d{2}m$/);
});

test("formatTokens keeps the shared compact scale", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1500), "1.5k");
  assert.equal(formatTokens(9999), "10.0k");
  assert.equal(formatTokens(12_000), "12k");
  assert.equal(formatTokens(126_400), "126k");
  assert.equal(formatTokens(1_000_000), "1.0M");
  assert.equal(formatTokens(1_500_000), "1.5M");
});

test("formatTokens is defensive about non-finite input", () => {
  assert.equal(formatTokens(Number.NaN), "?");
  assert.equal(formatTokens(Number.POSITIVE_INFINITY), "?");
  assert.equal(formatTokens(-5), "0");
});
