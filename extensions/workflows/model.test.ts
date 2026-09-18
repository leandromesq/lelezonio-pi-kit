import assert from "node:assert/strict";
import test from "node:test";
import { emptyUsage, formatUsage } from "./model.ts";

test("workflow usage numbers come from the shared token formatter", () => {
  assert.equal(
    formatUsage({ ...emptyUsage(), input: 1500, output: 126_000 }),
    "1.5k in · 126k out",
  );
});
