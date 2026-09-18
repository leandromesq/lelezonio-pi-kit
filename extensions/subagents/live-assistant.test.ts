import assert from "node:assert/strict";
import test from "node:test";
import {
  createLiveAssistantBuffer,
  LIVE_ASSISTANT_MAX_LENGTH,
} from "./src/live-assistant.ts";

test("many deltas are never joined until a reader asks", () => {
  const buffer = createLiveAssistantBuffer();
  for (let i = 0; i < 5000; i++) buffer.append("text", `t${i} `);

  assert.equal(buffer.stats().textJoins, 0, "append must not rebuild the text");
  const text = buffer.view.text;
  assert.equal(buffer.stats().textJoins, 1);
  assert.equal(buffer.view.text, text, "repeat reads reuse the joined string");
  assert.equal(buffer.stats().textJoins, 1);
});

test("text and thinking prune and materialize independently", () => {
  const buffer = createLiveAssistantBuffer();
  buffer.append("thinking", "a".repeat(LIVE_ASSISTANT_MAX_LENGTH + 5));

  assert.equal(buffer.view.text, "");
  assert.equal(buffer.stats().textJoins, 0);
  assert.equal(buffer.view.thinking.length, LIVE_ASSISTANT_MAX_LENGTH);
  assert.equal(buffer.stats().thinkingJoins, 1);
});

test("the retained live text is the last 128 KiB (same cut as v1)", () => {
  const buffer = createLiveAssistantBuffer();
  const chunk = "x".repeat(1000);
  const count = Math.ceil(LIVE_ASSISTANT_MAX_LENGTH / chunk.length) + 10;
  for (let i = 0; i < count; i++) buffer.append("text", chunk);

  const expected = chunk.repeat(count).slice(-LIVE_ASSISTANT_MAX_LENGTH);
  assert.equal(buffer.view.text.length, LIVE_ASSISTANT_MAX_LENGTH);
  assert.equal(buffer.view.text, expected);
});

test("a delta after a read re-materializes exactly once more", () => {
  const buffer = createLiveAssistantBuffer();
  buffer.append("text", "a");
  assert.equal(buffer.view.text, "a");
  buffer.append("text", "b");

  assert.equal(buffer.stats().textJoins, 1, "no join until the next read");
  assert.equal(buffer.view.text, "ab");
  assert.equal(buffer.stats().textJoins, 2);
});
