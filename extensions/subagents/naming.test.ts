import assert from "node:assert/strict";
import test from "node:test";
import { registerSubagentName, resolveSubagentTarget } from "./src/naming.ts";
import {
  buildSubagentResultMessage,
  buildSubagentSendResult,
} from "./src/prompt.ts";

test("registerSubagentName suffixes collisions and keeps the same-id name", () => {
  const registry = new Map<string, string>();
  assert.equal(registerSubagentName(registry, "scout", "sa-1"), "scout");
  assert.equal(registerSubagentName(registry, "scout", "sa-2"), "scout-2");
  assert.equal(registerSubagentName(registry, "scout", "sa-3"), "scout-3");
  // Re-registering the same name for the same id is idempotent.
  assert.equal(registerSubagentName(registry, "scout", "sa-1"), "scout");
  assert.equal(registry.size, 3);
});

test("registerSubagentName falls back to a safe base and trims whitespace", () => {
  const registry = new Map<string, string>();
  assert.equal(registerSubagentName(registry, "   ", "sa-1"), "subagent");
  assert.equal(registerSubagentName(registry, "", "sa-2"), "subagent-2");
});

test("resolveSubagentTarget prefers a registered name, else treats it as an id", () => {
  const registry = new Map([["scout", "sa-1"]]);
  assert.equal(resolveSubagentTarget("scout", registry), "sa-1");
  assert.equal(resolveSubagentTarget("sa-2", registry), "sa-2");
  assert.equal(resolveSubagentTarget("unknown-name", registry), "unknown-name");
});

test("buildSubagentSendResult distinguishes steering from resuming", () => {
  const running = buildSubagentSendResult({
    target: "scout",
    id: "sa-1",
    title: "recon",
    message: "also check tests/",
    status: "running",
  });
  assert.match(running, /steered/);
  assert.match(running, /scout \(sa-1\)/);

  const resumed = buildSubagentSendResult({
    target: "sa-2",
    id: "sa-2",
    title: "worker",
    message: "continue",
    status: "done",
  });
  assert.match(resumed, /resumed/);
});

test("buildSubagentResultMessage surfaces a pending child question", () => {
  const text = buildSubagentResultMessage({
    id: "sa-1",
    title: "worker",
    status: "done",
    output: "work",
    question: "Which API should I use?",
  });
  assert.match(text, /Question for you: Which API should I use\?/);
  assert.match(text, /subagent_send/);
});
