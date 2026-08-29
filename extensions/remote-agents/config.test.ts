import assert from "node:assert/strict";
import test from "node:test";
import { parseRemoteAgentsConfig } from "./src/config.ts";

test("remote roots are explicit and normalized", () => {
  const config = parseRemoteAgentsConfig({
    host: "macmini",
    projectsRoot: "/Users/remote/Projects/",
    worktreesRoot: "/Users/remote/Worktrees/",
  });
  assert.equal(config.projectsRoot, "/Users/remote/Projects");
  assert.equal(config.worktreesRoot, "/Users/remote/Worktrees");
  assert.equal(config.openRemoteUiOnSpawn, true);
  assert.equal(config.terminalExecutable, "kitty");
});

test("remote UI launch settings are validated", () => {
  assert.throws(
    () => parseRemoteAgentsConfig({ openRemoteUiOnSpawn: "yes" }),
    /must be a boolean/,
  );
  assert.throws(
    () => parseRemoteAgentsConfig({ terminalExecutable: " " }),
    /must not be empty/,
  );
});

test("remote roots must be absolute", () => {
  assert.throws(
    () => parseRemoteAgentsConfig({ projectsRoot: "Projects" }),
    /absolute remote path/,
  );
});
