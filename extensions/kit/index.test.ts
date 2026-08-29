import assert from "node:assert/strict";
import { test } from "node:test";
import { kitViewportRows } from "./index.ts";

test("kit viewport reserves chrome on short terminals", () => {
  assert.equal(kitViewportRows(12, 20), 1);
  assert.equal(kitViewportRows(20, 20), 3);
});

test("kit viewport never exceeds the available actions", () => {
  assert.equal(kitViewportRows(80, 3), 3);
  assert.equal(kitViewportRows(80, 14), 14);
});
