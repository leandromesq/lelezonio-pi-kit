import assert from "node:assert/strict";
import test from "node:test";
import {
  fallbackTitle,
  generateTaskTitle,
  normalizeTitle,
  parseTitleResponse,
} from "./src/title-generator.ts";

test("parses a JSON title response, including fenced JSON", () => {
  assert.equal(
    parseTitleResponse('```json\n{"title":"Fix session naming"}\n```'),
    "Fix session naming",
  );
});

test("normalizes terminal output and bounds title length", () => {
  assert.equal(
    normalizeTitle("\u001b[31mtitle: `Fix   auth`\u001b[0m"),
    "Fix auth",
  );
  assert.equal(normalizeTitle("x".repeat(72)), "x".repeat(72));
  assert.equal(normalizeTitle("x".repeat(73)), `${"x".repeat(71)}…`);
});

test("falls back to the first meaningful task line", () => {
  assert.equal(
    fallbackTitle("\n### Add a workspace label\nMore details"),
    "Add a workspace label",
  );
  assert.equal(fallbackTitle("\n\t"), "coding task");
});

test("an explicit title bypasses model discovery and authentication", async () => {
  const modelRegistry = new Proxy(
    {},
    {
      get() {
        throw new Error("Naming must not access the model registry");
      },
    },
  ) as NonNullable<Parameters<typeof generateTaskTitle>[0]["modelRegistry"]>;
  assert.equal(
    await generateTaskTitle({
      modelRegistry,
      config: {
        enabled: true,
        provider: "test",
        model: "test",
        reasoning: "off",
      },
      prompt: "A long implementation task",
      hint: "  focused worker  ",
    }),
    "focused worker",
  );
});

test("an empty hint retains the safe fallback without a registry", async () => {
  assert.equal(
    await generateTaskTitle({
      config: {
        enabled: true,
        provider: "test",
        model: "test",
        reasoning: "off",
      },
      prompt: "Investigate lifecycle",
      hint: "  ",
    }),
    "Investigate lifecycle",
  );
});

test("rejects responses without a usable title", () => {
  assert.throws(() => parseTitleResponse('{"title":"   "}'));
  assert.throws(() => parseTitleResponse("not JSON"));
});
