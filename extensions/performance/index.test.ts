import assert from "node:assert/strict";
import { test } from "node:test";
import { percentile } from "./index.ts";

test("percentile handles empty and unsorted samples", () => {
  assert.equal(percentile([], 0.95), null);
  assert.equal(percentile([30, 10, 20], 0.5), 20);
  assert.equal(percentile([30, 10, 20], 0.95), 30);
});

test("percentile clamps quantiles", () => {
  assert.equal(percentile([10, 20], -1), 10);
  assert.equal(percentile([10, 20], 2), 20);
});
