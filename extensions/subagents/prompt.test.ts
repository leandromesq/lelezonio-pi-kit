/** The spawn result must stay unchanged on a normal spawn and announce the
 * in-process fallback (with its reason) when no Herdr worker pane was used. */

import assert from "node:assert/strict";
import test from "node:test";
import { buildSubagentSpawnResult } from "./src/prompt.ts";

const base = {
  id: "sa-3",
  title: "Refactor module",
  harness: "pi",
  modelLabel: "openai/gpt-5.4",
  cwd: "C:\\work\\proj",
};

test("spawn result has no fallback note when a Herdr pane was used", () => {
  const text = buildSubagentSpawnResult(base);
  assert.match(text, /^Spawned subagent sa-3 "Refactor module" \(pi:/);
  assert.doesNotMatch(text, /Note:/);
});

test("spawn result announces the in-process fallback and its reason", () => {
  const text = buildSubagentSpawnResult({
    ...base,
    fallbackReason: "herdr worker pane unavailable",
  });
  assert.match(text, /Note: it has no Herdr worker pane and runs in-process/);
  assert.match(text, /herdr worker pane unavailable/);
  // A blank reason must not produce an empty note.
  assert.doesNotMatch(
    buildSubagentSpawnResult({ ...base, fallbackReason: "  " }),
    /Note:/,
  );
});
