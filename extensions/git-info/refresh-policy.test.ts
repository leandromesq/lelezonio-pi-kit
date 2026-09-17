import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldRefreshAfterTool,
  shouldTrackGit,
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
