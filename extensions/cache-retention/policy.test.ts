import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyCachePolicy,
  BUILT_IN_RULES,
  cacheTargetFrom,
  describeCacheEffect,
  matchesCacheRule,
  matchesModelPattern,
  matchingCacheRules,
  type CacheRule,
} from "./src/policy.ts";

const GLM = { provider: "opencode-go", model: "glm-5.3-flash" };
const DEEPSEEK = { provider: "opencode-go", model: "deepseek-v4.1-flash" };

test("matchesModelPattern supports exact ids and globs", () => {
  assert.equal(matchesModelPattern("glm-5.3-flash", "glm-5.3-flash"), true);
  assert.equal(matchesModelPattern("glm-5.3-flash", "GLM-5.3-Flash"), true);
  assert.equal(matchesModelPattern("glm-5.3-flash", "glm-5.3"), false);
  assert.equal(matchesModelPattern("glm-*", "glm-5.3-flash"), true);
  assert.equal(matchesModelPattern("*flash", "glm-5.3-flash"), true);
  assert.equal(matchesModelPattern("g*m-5.3", "glm-5.3"), true);
  assert.equal(matchesModelPattern("*", "anything"), true);
  // Regex metacharacters in ids are literal, not patterns.
  assert.equal(matchesModelPattern("gpt-5.6", "gpt-5x6"), false);
});

test("matchesCacheRule honors the provider scope", () => {
  const rule: CacheRule = { provider: "opencode-go", model: "glm-*" };
  assert.equal(matchesCacheRule(rule, GLM), true);
  assert.equal(
    matchesCacheRule(rule, { provider: "openai-codex", model: "glm-5.3" }),
    false,
  );
  assert.equal(matchesCacheRule({ provider: "*", model: "glm-*" }, GLM), true);
});

test("built-in rules strip retention for GLM on the Zen gateway", () => {
  const matches = matchingCacheRules(BUILT_IN_RULES, GLM);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.stripRetention, true);
});

test("built-in rules leave other Zen models untouched", () => {
  assert.deepEqual(matchingCacheRules(BUILT_IN_RULES, DEEPSEEK), []);
  assert.deepEqual(
    matchingCacheRules(BUILT_IN_RULES, {
      provider: "openai-codex",
      model: "gpt-5.6-luna",
    }),
    [],
  );
});

test("applyCachePolicy strips the rejected field and keeps the rest", () => {
  const payload = {
    model: "glm-5.3-flash",
    prompt_cache_key: "session",
    prompt_cache_retention: "24h",
    stream: true,
  };
  const result = applyCachePolicy(payload, BUILT_IN_RULES, GLM);
  assert.equal(result.changed, true);
  assert.deepEqual(result.payload, {
    model: "glm-5.3-flash",
    prompt_cache_key: "session",
    stream: true,
  });
  assert.deepEqual(result.applied, ["removed prompt_cache_retention"]);
  // The caller's payload object is never mutated in place.
  assert.equal(payload.prompt_cache_retention, "24h");
});

test("applyCachePolicy ignores unmatched models and non-object payloads", () => {
  const payload = {
    model: "deepseek-v4.1-flash",
    prompt_cache_retention: "24h",
  };
  assert.deepEqual(applyCachePolicy(payload, BUILT_IN_RULES, DEEPSEEK), {
    changed: false,
    payload,
    applied: [],
  });
  assert.equal(applyCachePolicy("text", BUILT_IN_RULES, GLM).changed, false);
  assert.equal(applyCachePolicy(null, BUILT_IN_RULES, GLM).changed, false);
});

test("applyCachePolicy is a no-op when the field is absent", () => {
  const payload = { model: "glm-5.3-flash", stream: true };
  const result = applyCachePolicy(payload, BUILT_IN_RULES, GLM);
  assert.equal(result.changed, false);
  assert.equal(result.payload, payload);
});

test("a configured rule can replace retention with prompt_cache_options", () => {
  const rules: CacheRule[] = [
    {
      provider: "opencode-go",
      model: "glm-5.3-flash",
      replaceWithOptions: { ttl: "30m" },
    },
  ];
  const result = applyCachePolicy(
    { model: "glm-5.3-flash", prompt_cache_retention: "24h" },
    rules,
    GLM,
  );
  assert.deepEqual(result.payload, {
    model: "glm-5.3-flash",
    prompt_cache_options: { ttl: "30m" },
  });
  assert.deepEqual(result.applied, [
    "removed prompt_cache_retention",
    'prompt_cache_options {"ttl":"30m"}',
  ]);
});

test("a learned strip wins over a configured replacement", () => {
  // Otherwise a config rule would keep re-breaking a model that already
  // answered 400 to exactly this parameter.
  const rules: CacheRule[] = [
    {
      provider: "opencode-go",
      model: "glm-5.3-flash",
      replaceWithOptions: { ttl: "30m" },
    },
    { provider: "opencode-go", model: "glm-5.3-flash", stripOptions: true },
  ];
  const result = applyCachePolicy(
    {
      model: "glm-5.3-flash",
      prompt_cache_retention: "24h",
      prompt_cache_options: { mode: "explicit" },
    },
    rules,
    GLM,
  );
  assert.deepEqual(result.payload, { model: "glm-5.3-flash" });
  assert.deepEqual(result.applied, [
    "removed prompt_cache_retention",
    "removed prompt_cache_options",
  ]);
});

test("replaceWithOptions objects merge in rule order", () => {
  const rules: CacheRule[] = [
    {
      provider: "*",
      model: "glm-*",
      replaceWithOptions: { mode: "explicit", ttl: "5m" },
    },
    {
      provider: "opencode-go",
      model: "glm-5.3-flash",
      replaceWithOptions: { ttl: "30m" },
    },
  ];
  const result = applyCachePolicy({ model: "glm-5.3-flash" }, rules, GLM);
  assert.deepEqual(result.payload, {
    model: "glm-5.3-flash",
    prompt_cache_options: { mode: "explicit", ttl: "30m" },
  });
});

test("stripKey removes only the cache key", () => {
  const rules: CacheRule[] = [
    { provider: "opencode-go", model: "glm-*", stripKey: true },
  ];
  const result = applyCachePolicy(
    {
      model: "glm-5.3-flash",
      prompt_cache_key: "session",
      prompt_cache_retention: "24h",
    },
    rules,
    GLM,
  );
  assert.deepEqual(result.payload, {
    model: "glm-5.3-flash",
    prompt_cache_retention: "24h",
  });
  assert.deepEqual(result.applied, ["removed prompt_cache_key"]);
});

test("describeCacheEffect reports the net effect for diagnostics", () => {
  assert.deepEqual(describeCacheEffect(BUILT_IN_RULES, GLM), [
    "removed prompt_cache_retention",
  ]);
  assert.deepEqual(describeCacheEffect(BUILT_IN_RULES, DEEPSEEK), []);
  assert.deepEqual(
    describeCacheEffect(
      [{ provider: "*", model: "*", stripKey: true }],
      DEEPSEEK,
    ),
    ["removed prompt_cache_key"],
  );
});

test("cacheTargetFrom prefers the payload model and falls back to the session", () => {
  assert.deepEqual(
    cacheTargetFrom(
      { model: "glm-5.3-flash" },
      { provider: "opencode-go", model: "other" },
    ),
    { provider: "opencode-go", model: "glm-5.3-flash" },
  );
  assert.deepEqual(
    cacheTargetFrom({}, { provider: "opencode-go", model: "glm-5.3" }),
    { provider: "opencode-go", model: "glm-5.3" },
  );
  assert.deepEqual(cacheTargetFrom(undefined, {}), { provider: "", model: "" });
});
