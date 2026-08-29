import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { sliceViewport, viewportRows, wrapViewportText } from "./viewport.ts";

test("viewportRows reserves chrome and handles unknown dimensions", () => {
  assert.equal(viewportRows(24, 10, 4), 14);
  assert.equal(viewportRows(8, 10, 4), 4);
  assert.equal(viewportRows(0, 10, 4), 20);
});

test("sliceViewport clamps offsets and reports overflow", () => {
  assert.deepEqual(sliceViewport([1, 2, 3, 4, 5], 99, 2), {
    items: [4, 5],
    offset: 3,
    above: 3,
    below: 0,
    maxOffset: 3,
  });
});

test("wrapViewportText preserves blank paragraphs and width", () => {
  const lines = wrapViewportText("one two three\n\nfour", 7);
  assert.ok(lines.includes(""));
  assert.ok(lines.every((line) => visibleWidth(line) <= 7));
});
