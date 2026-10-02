import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SUMMARY_CONFIG, parseSummaryConfig } from "./src/config.ts";

test("summary config defaults to DeepSeek Flash, auto recaps, one tool call", () => {
  assert.deepEqual(parseSummaryConfig(undefined), DEFAULT_SUMMARY_CONFIG);
  assert.deepEqual(DEFAULT_SUMMARY_CONFIG, {
    provider: "opencode-go",
    model: "deepseek-v4-flash",
    reasoning: "off",
    mode: "auto",
    minToolCalls: 1,
  });
});

test("summary config accepts valid private overrides and rejects partial corruption", () => {
  assert.deepEqual(
    parseSummaryConfig({
      provider: " anthropic ",
      model: " claude-sonnet ",
      reasoning: "high",
      mode: "manual",
      minToolCalls: 3,
    }),
    {
      provider: "anthropic",
      model: "claude-sonnet",
      reasoning: "high",
      mode: "manual",
      minToolCalls: 3,
    },
  );

  assert.deepEqual(
    parseSummaryConfig({ provider: "", model: 42, reasoning: "turbo" }),
    DEFAULT_SUMMARY_CONFIG,
  );
  assert.deepEqual(
    parseSummaryConfig({
      provider: "anthropic",
      model: 42,
      reasoning: "high",
    }),
    DEFAULT_SUMMARY_CONFIG,
  );
});

test("summary config degrades optional mode fields individually", () => {
  // A config written before mode/minToolCalls existed keeps its model choice.
  assert.deepEqual(
    parseSummaryConfig({
      provider: "anthropic",
      model: "claude-sonnet",
      reasoning: "high",
    }),
    {
      provider: "anthropic",
      model: "claude-sonnet",
      reasoning: "high",
      mode: "auto",
      minToolCalls: 1,
    },
  );

  // Invalid mode/threshold fall back one field at a time, not wholesale.
  assert.deepEqual(
    parseSummaryConfig({
      provider: "anthropic",
      model: "claude-sonnet",
      reasoning: "high",
      mode: "turbo",
      minToolCalls: -1,
    }),
    {
      provider: "anthropic",
      model: "claude-sonnet",
      reasoning: "high",
      mode: "auto",
      minToolCalls: 1,
    },
  );
});
