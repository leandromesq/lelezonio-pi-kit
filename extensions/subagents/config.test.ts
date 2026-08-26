import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSubagentsConfig,
  resolveProfileBehavior,
  resolveSpawnOptions,
} from "./src/config.ts";

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

test("rich profile fields parse with defaults", () => {
  const rich = parseSubagentsConfig({
    profiles: {
      reviewer: {
        harness: "pi",
        readOnly: true,
        tools: ["read", "grep"],
        contextMode: "summary",
      },
      coder: {
        harness: "pi",
        allowChildren: ["reviewer"],
        maxDepth: 2,
        systemPrompt: "Be helpful.",
      },
      plain: { harness: "pi" },
    },
  });
  assert.deepEqual(resolveProfileBehavior(rich.profiles.reviewer), {
    systemPrompt: undefined,
    readOnly: true,
    tools: ["read", "grep"],
    allowChildren: [],
    maxDepth: 0,
    contextMode: "summary",
    cwd: undefined,
  });
  assert.deepEqual(resolveProfileBehavior(rich.profiles.coder), {
    systemPrompt: "Be helpful.",
    tools: undefined,
    allowChildren: ["reviewer"],
    maxDepth: 2,
    readOnly: false,
    contextMode: "standalone",
    cwd: undefined,
  });
  // allowChildren without maxDepth defaults to 1.
  assert.equal(
    resolveProfileBehavior(
      parseSubagentsConfig({
        profiles: {
          reviewer: { harness: "pi" },
          coder: { harness: "pi", allowChildren: ["reviewer"] },
        },
      }).profiles.coder,
    ).maxDepth,
    1,
  );
  assert.deepEqual(resolveProfileBehavior(undefined), {
    readOnly: false,
    allowChildren: [],
    maxDepth: 0,
    contextMode: "standalone",
    cwd: undefined,
  });
});

test("rich profile fields reject invalid combinations", () => {
  assert.throws(
    () =>
      parseSubagentsConfig({
        profiles: {
          coder: {
            harness: "pi",
            systemPrompt: "x",
            promptFile: "y.md",
          },
        },
      }),
    /must not set both systemPrompt and promptFile/,
  );
  assert.throws(
    () =>
      parseSubagentsConfig({
        profiles: {
          reviewer: { harness: "pi" },
          coder: { harness: "pi", allowChildren: ["reviewer"], maxDepth: 0 },
        },
      }),
    /maxDepth must be >= 1 when allowChildren is set/,
  );
  assert.throws(
    () =>
      parseSubagentsConfig({
        profiles: { coder: { harness: "pi", contextMode: "fork" } },
      }),
    /contextMode must be one of/,
  );
  assert.throws(
    () =>
      parseSubagentsConfig({
        profiles: {
          coder: { harness: "pi", allowChildren: ["ghost"] },
        },
      }),
    /references unknown profile "ghost"/,
  );
  assert.throws(
    () =>
      parseSubagentsConfig({
        profiles: { coder: { harness: "pi", tools: ["read", "read"] } },
      }),
    /must not contain duplicates/,
  );
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfigMerged } from "./src/config.ts";

test("loadConfigMerged overlays project .pi/subagents.json on top of global", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-proj-"));
  fs.mkdirSync(path.join(base, ".pi"), { recursive: true });
  fs.writeFileSync(
    path.join(base, ".pi", "subagents.json"),
    JSON.stringify({
      profiles: { reviewer: { harness: "codex", readOnly: true } },
    }),
  );
  const merged = loadConfigMerged(config, base);
  assert.equal(merged.profiles.reviewer.readOnly, true);
  assert.equal(merged.profiles.reviewer.harness, "codex");
  // Non-overridden profiles survive.
  assert.equal(merged.profiles.coder.harness, "pi");
  // No overlay file -> global config.
  const plain = loadConfigMerged(config, os.tmpdir());
  assert.equal(plain.profiles.reviewer, undefined);
  fs.rmSync(base, { recursive: true, force: true });
});
