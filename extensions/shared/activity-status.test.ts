import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatActivityStatus, isEmptyActivity } from "./activity-status.ts";

type Theme = ExtensionContext["ui"]["theme"];

/** Theme double: colors become `[role]text` so assertions read the real roles. */
const theme = {
  fg: (color: string, text: string) => `[${color}]${text}`,
} as unknown as Theme;

/** The theme double splits the command from the dim suffix. */
const toView = (command: string) => new RegExp(`${command}.*to view`);

test("every label resolves to its own command", () => {
  const counts = { running: 1, done: 0, failed: 0 };
  assert.match(
    formatActivityStatus(theme, "subagents", counts),
    toView("/subagents"),
  );
  assert.match(
    formatActivityStatus(theme, "workflows", counts),
    toView("/workflows"),
  );
  assert.match(
    formatActivityStatus(theme, "remote", counts),
    toView("/remotes"),
  );
});

test("count order is stable across surfaces", () => {
  const line = formatActivityStatus(theme, "subagents", {
    running: 2,
    stalled: 1,
    done: 3,
    failed: 1,
    questions: 1,
    offline: 1,
  });
  const order = ["running", "stalled", "done", "failed", "ask", "offline"].map(
    (word) => line.indexOf(word),
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    "expected running < stalled < done < failed < ask < offline",
  );
  assert.equal(line.startsWith("[muted]subagents:"), true);
});

test("zero counts are omitted and running is warning everywhere", () => {
  const line = formatActivityStatus(theme, "workflows", {
    running: 2,
    done: 0,
    failed: 0,
  });
  assert.equal(line.includes("done"), false);
  assert.equal(line.includes("failed"), false);
  assert.equal(line.includes("[warning]■ 2 running"), true);
  assert.equal(line.includes("[accent]/workflows"), true);
});

test("a blocked remote agent is reported as an ask, not a second running count", () => {
  const line = formatActivityStatus(theme, "remote", {
    running: 1,
    done: 0,
    failed: 0,
    questions: 2,
    offline: 1,
  });
  assert.equal(line.includes("[warning]? 2 ask"), true);
  assert.equal(line.includes("[warning]■ 1 offline"), true);
});

test("isEmptyActivity only fires when nothing is left to report", () => {
  assert.equal(isEmptyActivity({ running: 0, done: 0, failed: 0 }), true);
  assert.equal(
    isEmptyActivity({ running: 0, done: 0, failed: 0, offline: 1 }),
    false,
  );
  assert.equal(isEmptyActivity({ running: 1, done: 0, failed: 0 }), false);
});
