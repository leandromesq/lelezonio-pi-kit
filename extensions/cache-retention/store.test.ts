import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRuleStore,
  parseLearnedState,
  parseRulesConfig,
} from "./src/store.ts";

test("parseRulesConfig keeps valid rules and reports the rest", () => {
  const parsed = parseRulesConfig({
    rules: [
      { provider: "opencode-go", model: "glm-*", stripRetention: true },
      {
        provider: "opencode-go",
        model: "glm-5.3-flash",
        replaceWithOptions: { ttl: "30m" },
        note: "temporary",
      },
      { provider: "", model: "glm-*", stripRetention: true },
      { provider: "opencode-go", model: "glm-*" },
      { provider: "opencode-go", model: "glm-*", stripRetention: "yes" },
      "nonsense",
    ],
  });
  assert.equal(parsed.rules.length, 2);
  assert.deepEqual(parsed.rules[0], {
    provider: "opencode-go",
    model: "glm-*",
    stripRetention: true,
  });
  assert.deepEqual(parsed.rules[1], {
    provider: "opencode-go",
    model: "glm-5.3-flash",
    replaceWithOptions: { ttl: "30m" },
    note: "temporary",
  });
  assert.equal(parsed.skipped.length, 4);
});

test("parseRulesConfig tolerates missing or malformed containers", () => {
  assert.deepEqual(parseRulesConfig(undefined), { rules: [], skipped: [] });
  assert.deepEqual(parseRulesConfig({}), { rules: [], skipped: [] });
  assert.deepEqual(parseRulesConfig({ rules: {} }), { rules: [], skipped: [] });
  assert.deepEqual(parseLearnedState(null), { rules: [], skipped: [] });
});

test("parseLearnedState preserves learnedAt", () => {
  const parsed = parseLearnedState({
    version: 1,
    rules: [
      {
        provider: "acme",
        model: "old-model",
        stripRetention: true,
        note: "rejected",
        learnedAt: 1_700_000_000_000,
      },
    ],
  });
  assert.equal(parsed.rules.length, 1);
  assert.equal(parsed.rules[0]?.learnedAt, 1_700_000_000_000);
});

test("learned rules apply to the next request and persist best-effort", async () => {
  let written: unknown;
  const store = createRuleStore({
    configPath: "/cfg.json",
    learnedPath: "/learned.json",
    readTextFile: async (path) => {
      if (path === "/cfg.json") {
        return JSON.stringify({
          rules: [
            { provider: "user-provider", model: "custom", stripKey: true },
          ],
        });
      }
      throw new Error("ENOENT");
    },
    writeJsonFile: async (_path, value) => {
      written = value;
    },
  });

  await store.ensureLoaded();
  assert.deepEqual(
    (await store.effectiveRules()).map((rule) => rule.provider),
    ["user-provider", "opencode-go"],
  );

  assert.equal(
    await store.learn({
      provider: "acme",
      model: "old-model",
      note: "not supported",
    }),
    true,
  );
  // In-memory immediately: the next request already carries the fix.
  const rules = await store.effectiveRules();
  assert.equal(rules[1]?.provider, "acme");
  assert.equal(rules[1]?.stripRetention, true);
  // Same rule twice is a no-op.
  assert.equal(
    await store.learn({ provider: "acme", model: "old-model" }),
    false,
  );
  assert.deepEqual(written, {
    version: 1,
    rules: [
      {
        provider: "acme",
        model: "old-model",
        stripRetention: true,
        note: "not supported",
        learnedAt: rules[1]?.learnedAt,
      },
    ],
  });
});

test("persisting merges rules learned by another process", async () => {
  let written: unknown;
  const store = createRuleStore({
    configPath: "/cfg.json",
    learnedPath: "/learned.json",
    readTextFile: async (path) => {
      if (path === "/learned.json") {
        return JSON.stringify({
          version: 1,
          rules: [
            { provider: "other", model: "peer-model", stripRetention: true },
          ],
        });
      }
      throw new Error("ENOENT");
    },
    writeJsonFile: async (_path, value) => {
      written = value;
    },
  });

  await store.learn({ provider: "acme", model: "old-model" });
  const rules = (written as { rules: { provider: string }[] }).rules;
  assert.deepEqual(rules.map((rule) => rule.provider).sort(), [
    "acme",
    "other",
  ]);
});

test("a failed write still keeps the rule active in memory", async () => {
  const store = createRuleStore({
    readTextFile: async () => {
      throw new Error("ENOENT");
    },
    writeJsonFile: async () => {
      throw new Error("disk full");
    },
  });
  await store.learn({ provider: "acme", model: "old-model" });
  const snapshot = store.snapshot();
  assert.equal(snapshot.learned.length, 1);
  assert.equal(snapshot.skipped.length, 0);
});
