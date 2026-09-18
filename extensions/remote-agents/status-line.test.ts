import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RemoteAgentSnapshot, RemoteAgentStatus } from "./src/domain.ts";
import { remoteActivityCounts, remoteActivityStatus } from "./src/ui/status.ts";

type Theme = ExtensionContext["ui"]["theme"];

/** Theme double: colors become `[role]text` so assertions read the real roles. */
const theme = {
  fg: (color: string, text: string) => `[${color}]${text}`,
} as unknown as Theme;

function job(status: RemoteAgentStatus, id = status): RemoteAgentSnapshot {
  return {
    id,
    name: id,
    title: id,
    host: "macmini",
    localCwd: "/local",
    remoteCwd: "/remote",
    status,
    createdAt: 1,
    updatedAt: 1,
    transcript: "",
    transcriptVersion: 0,
    generation: 1,
  };
}

test("remote counts keep the meaning of every bucket", () => {
  const counts = remoteActivityCounts([
    job("working"),
    job("starting"),
    job("blocked"),
    job("unreachable"),
    job("failed"),
    job("done"),
    job("cancelled"),
  ]);
  // A cancelled job stays in `done` (the settled catch-all it always was)
  // instead of silently disappearing from the line.
  assert.deepEqual(counts, {
    running: 2,
    done: 2,
    failed: 1,
    questions: 1,
    offline: 1,
  });
});

test("a blocked remote is an ask and an unreachable host is offline", () => {
  const line = remoteActivityStatus(theme, [
    job("blocked"),
    job("unreachable"),
  ]);
  assert.ok(line, "expected a status line");
  assert.equal(line.startsWith("[muted]remote:"), true);
  assert.match(line, /\[warning\]\? 1 ask/);
  assert.match(line, /\[warning\]■ 1 offline/);
  assert.match(line, /\[accent\]\/remotes.*to view/);
});

test("a settled remote keeps counting as done, never running", () => {
  const line = remoteActivityStatus(theme, [job("done"), job("failed")]);
  assert.ok(line, "expected a status line");
  assert.match(line, /\[success\]■ 1 done/);
  assert.match(line, /\[error\]■ 1 failed/);
  assert.equal(line.includes("running"), false);
});

test("nothing to report clears the status line instead of showing zeros", () => {
  assert.equal(remoteActivityStatus(theme, []), undefined);
});
