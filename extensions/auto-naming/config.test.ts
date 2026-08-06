import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_NAMING_CONFIG, parseNamingConfig } from "./src/config.ts";

test("uses the requested default title model", () => {
  assert.deepEqual(DEFAULT_NAMING_CONFIG, {
    enabled: true,
    provider: "opencode-go",
    model: "deepseek-v4-flash",
    reasoning: "off",
  });
});

test("accepts and trims a valid naming config", () => {
  assert.deepEqual(
    parseNamingConfig({
      provider: " example ",
      model: " model ",
      reasoning: "low",
    }),
    {
      enabled: true,
      provider: "example",
      model: "model",
      reasoning: "low",
    },
  );
});

test("falls back for malformed naming config", () => {
  assert.deepEqual(
    parseNamingConfig({ model: "missing provider" }),
    DEFAULT_NAMING_CONFIG,
  );
});
