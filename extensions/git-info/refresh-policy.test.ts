import assert from "node:assert/strict";
import test from "node:test";
import {
  isSubagentProcess,
  POLL_INTERVAL_MS,
  pollIntervalMs,
  shouldRefreshAfterTool,
  shouldRefreshOnInput,
  shouldTrackGit,
  SUBAGENT_POLL_INTERVAL_MS,
} from "./src/refresh-policy.ts";

test("display-only Git polling is disabled for headless children", () => {
  assert.equal(shouldTrackGit("tui"), true);
  for (const mode of ["print", "json", "rpc"])
    assert.equal(shouldTrackGit(mode), false);
});

test("read-only inspection tools do not request Git refreshes", () => {
  for (const name of [
    "read",
    "grep",
    "find",
    "ls",
    "rg",
    "fd",
    "bg_status",
    "subagent_check",
    "web_fetch",
  ]) {
    assert.equal(shouldRefreshAfterTool(name), false, name);
  }
});

test("mutating, execution, completion and unknown tools still refresh", () => {
  for (const name of [
    "edit",
    "write",
    "bash",
    "powershell",
    "bg_start",
    "subagent_wait",
    "custom_mutation",
  ]) {
    assert.equal(shouldRefreshAfterTool(name), true, name);
  }
});

test("only PI_SUBAGENT=1 marks a process as a subagent child", () => {
  assert.equal(isSubagentProcess({ PI_SUBAGENT: "1" }), true);
  assert.equal(isSubagentProcess({}), false);
  assert.equal(isSubagentProcess({ PI_SUBAGENT: "" }), false);
  assert.equal(isSubagentProcess({ PI_SUBAGENT: "0" }), false);
  // The launcher writes the string "1"; anything else stays in parent mode.
  assert.equal(isSubagentProcess({ PI_SUBAGENT: "true" }), false);
});

test("a subagent child never refreshes from tool mutations", () => {
  for (const name of [
    "edit",
    "write",
    "bash",
    "powershell",
    "custom_mutation",
  ]) {
    assert.equal(shouldRefreshAfterTool(name, true), false, name);
  }
  // Read-only tools stay non-refreshing in parent mode (unchanged behavior).
  assert.equal(shouldRefreshAfterTool("edit", false), true);
  assert.equal(shouldRefreshAfterTool("read", false), false);
});

test("a subagent child never refreshes from input", () => {
  assert.equal(shouldRefreshOnInput(true), false);
  assert.equal(shouldRefreshOnInput(false), true);
});

test("a subagent child polls, but slower than the parent", () => {
  assert.equal(pollIntervalMs(false), POLL_INTERVAL_MS);
  assert.equal(pollIntervalMs(true), SUBAGENT_POLL_INTERVAL_MS);
  assert.ok(pollIntervalMs(true) > pollIntervalMs(false));
});
