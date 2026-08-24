import assert from "node:assert/strict";
import test from "node:test";
import {
  BTW_TITLE_MAX_LENGTH,
  btwStatusLabel,
  deriveBtwTitle,
  isModelVisible,
} from "./src/by-the-way.ts";
import { herdrEnvironment } from "./src/btw-herdr.ts";

test("deriveBtwTitle uses the first non-empty line and bounds the title", () => {
  assert.equal(
    deriveBtwTitle("\n   Why   does this work?   \nignore me"),
    "Why does this work?",
  );
  assert.equal(deriveBtwTitle(" \n\t"), "by the way");

  const title = deriveBtwTitle("x".repeat(BTW_TITLE_MAX_LENGTH + 10));
  assert.equal(title.length, BTW_TITLE_MAX_LENGTH);
  assert.equal(title, `${"x".repeat(BTW_TITLE_MAX_LENGTH - 1)}…`);

  const emojiTitle = deriveBtwTitle(
    `${"x".repeat(BTW_TITLE_MAX_LENGTH - 2)}😀 more`,
  );
  assert.equal(emojiTitle, `${"x".repeat(BTW_TITLE_MAX_LENGTH - 2)}😀…`);
});

test("btwStatusLabel maps entry statuses to transcript labels", () => {
  assert.equal(btwStatusLabel("error"), "failed");
  assert.equal(btwStatusLabel("running"), "running");
  assert.equal(btwStatusLabel("done"), "answered");
  assert.equal(btwStatusLabel(undefined), "answered");
});

test("only model-origin snapshots are visible to model-facing tools", () => {
  assert.equal(isModelVisible({ origin: "model" }), true);
  assert.equal(isModelVisible({ origin: "btw" }), false);
});

test("herdrEnvironment gates on Herdr env vars", () => {
  const saved = {
    HERDR_ENV: process.env.HERDR_ENV,
    HERDR_PANE_ID: process.env.HERDR_PANE_ID,
    HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
  };
  try {
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_SOCKET_PATH;
    assert.equal(herdrEnvironment(), false);
    process.env.HERDR_ENV = "1";
    assert.equal(herdrEnvironment(), false);
    process.env.HERDR_PANE_ID = "w1:p1";
    assert.equal(herdrEnvironment(), false);
    process.env.HERDR_SOCKET_PATH = "herdr.sock";
    assert.equal(herdrEnvironment(), true);
    process.env.HERDR_ENV = "0";
    assert.equal(herdrEnvironment(), false);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
