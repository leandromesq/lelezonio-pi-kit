import assert from "node:assert/strict";
import test from "node:test";
import { parseSubagentsConfig, resolveSpawnOptions } from "./src/config.ts";

const config = parseSubagentsConfig({
  defaultHarness: "pi",
  maxConcurrent: 3,
  harnesses: {
    pi: { model: "opencode-go/kimi-k3", thinking: "max" },
    codex: { model: "gpt-5.6-sol", thinking: "high" },
  },
  profiles: {
    planner: {
      harness: "codex",
      model: "gpt-5.6-sol",
      thinking: "high",
    },
    coder: {
      harness: "pi",
      model: "opencode-go/deepseek-v4-pro",
      thinking: "max",
    },
  },
});

test("named profiles select their configured harness, model, and thinking", () => {
  assert.deepEqual(resolveSpawnOptions(config, { profile: "coder" }), {
    profile: "coder",
    harness: "pi",
    model: "opencode-go/deepseek-v4-pro",
    reasoningEffort: "max",
  });
});

test("explicit spawn options override a profile", () => {
  assert.deepEqual(
    resolveSpawnOptions(config, {
      profile: "planner",
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
    }),
    {
      profile: "planner",
      harness: "codex",
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
    },
  );
});

test("harness defaults apply when no profile is selected", () => {
  assert.deepEqual(resolveSpawnOptions(config, {}), {
    profile: undefined,
    harness: "pi",
    model: "opencode-go/kimi-k3",
    reasoningEffort: "max",
  });
});

test("unknown profiles fail with the available profile names", () => {
  assert.throws(
    () => resolveSpawnOptions(config, { profile: "reviewer" }),
    /Unknown subagent profile "reviewer".*planner, coder/,
  );
});

test("configuration rejects unsupported thinking and concurrency values", () => {
  assert.throws(
    () =>
      parseSubagentsConfig({
        profiles: { coder: { harness: "pi", thinking: "ultra" } },
      }),
    /thinking must be one of/,
  );
  assert.throws(
    () => parseSubagentsConfig({ maxConcurrent: 5 }),
    /integer from 1 to 4/,
  );
});
