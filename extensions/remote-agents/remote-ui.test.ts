import assert from "node:assert/strict";
import test from "node:test";
import { defaultRemoteAgentsConfig } from "./src/config.ts";
import {
  environmentWithoutHerdr,
  openRemoteUi,
  remoteUiArguments,
} from "./src/remote-ui.ts";

test("remote UI opens Kitty as a detached Herdr remote client", () => {
  assert.deepEqual(remoteUiArguments("macmini", "Review API"), [
    "--detach",
    "--title",
    "Remote Herdr · Review API",
    "herdr",
    "--remote",
    "macmini",
  ]);
});

test("remote UI removes inherited Herdr context to avoid nested-client rejection", () => {
  assert.deepEqual(
    environmentWithoutHerdr({
      PATH: "/bin",
      HOME: "/home/user",
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      HERDR_WORKSPACE_ID: "w1",
    }),
    { PATH: "/bin", HOME: "/home/user" },
  );
});

test("remote UI can be disabled", async () => {
  const config = {
    ...defaultRemoteAgentsConfig(),
    openRemoteUiOnSpawn: false,
    terminalExecutable: "definitely-not-an-executable",
  };
  assert.equal(await openRemoteUi(config, "disabled"), false);
});
