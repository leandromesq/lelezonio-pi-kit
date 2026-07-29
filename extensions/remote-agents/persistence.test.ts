import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { RemoteAgentSnapshot } from "./src/domain.ts";
import { RemoteJobStore } from "./src/persistence.ts";

test("remote job registry round-trips metadata without transcript cache", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "remote-agents-test-"),
  );
  try {
    const store = new RemoteJobStore(path.join(directory, "jobs.json"));
    const snapshot: RemoteAgentSnapshot = {
      id: "ra-test",
      name: "pi-remote-ra-test",
      title: "test",
      host: "macmini",
      localCwd: "C:/project",
      remoteCwd: "/Users/test/project",
      status: "working",
      createdAt: 1,
      updatedAt: 1,
      transcript: "hello",
      transcriptVersion: 1,
      generation: 1,
    };
    store.save([snapshot]);
    assert.deepEqual(store.load(), [
      { ...snapshot, transcript: "", transcriptVersion: 0 },
    ]);
    store.remove([snapshot.id]);
    store.save([snapshot]);
    assert.deepEqual(store.load(), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
