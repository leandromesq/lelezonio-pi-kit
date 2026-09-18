import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { RemoteAgentSnapshot } from "./src/domain.ts";
import { RemoteJobStore } from "./src/persistence.ts";

function snapshot(id: string, updatedAt: number): RemoteAgentSnapshot {
  return {
    id,
    name: `pi-remote-${id}`,
    title: id,
    host: "macmini",
    localCwd: "C:/project",
    remoteCwd: "/Users/test/project",
    status: "done",
    createdAt: updatedAt,
    updatedAt,
    transcript: "",
    transcriptVersion: 0,
    generation: 1,
  };
}

interface RawRegistry {
  jobs: Array<{ id: string }>;
  tombstones?: Array<{ id: string; deletedAt: number }>;
}

function readRegistry(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as RawRegistry;
}

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "remote-agents-test-"));
}

test("remote job registry round-trips metadata without transcript cache", () => {
  const directory = temporaryDirectory();
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

test("remote job registry skips the write when the state is unchanged", async () => {
  const directory = temporaryDirectory();
  const filePath = path.join(directory, "jobs.json");
  try {
    const store = new RemoteJobStore(filePath);
    store.save([snapshot("ra-unchanged", 1)]);
    await store.flush();
    const written = fs.readFileSync(filePath, "utf8");
    const writtenAt = fs.statSync(filePath).mtimeMs;

    store.save([snapshot("ra-unchanged", 1)]);
    await store.flush();

    assert.equal(fs.readFileSync(filePath, "utf8"), written);
    assert.equal(fs.statSync(filePath).mtimeMs, writtenAt);
    // Skipping the write also skips the inter-process lock.
    assert.equal(fs.existsSync(`${filePath}.lock`), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("remote job registry reports what a session must reconcile", () => {
  const directory = temporaryDirectory();
  const filePath = path.join(directory, "jobs.json");
  try {
    const store = new RemoteJobStore(filePath);
    store.flushSync();
    assert.equal(store.hasTrackedJobs(), false);
    assert.equal(fs.existsSync(filePath), false);

    store.save([snapshot("ra-seeded", 1)]);
    store.flushSync();
    assert.equal(store.hasTrackedJobs(), true);

    // A tombstoned job is not something a session has to reconcile.
    store.remove(["ra-seeded"]);
    store.flushSync();
    assert.equal(store.hasTrackedJobs(), false);

    // Unreadable state must never be reported as "nothing to do".
    fs.writeFileSync(filePath, "{ not json");
    assert.equal(store.hasTrackedJobs(), true);
    assert.equal(
      fs.existsSync(filePath),
      true,
      "the pre-flight check must not quarantine the registry",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("remote job registry prunes tombstones once they age out", () => {
  const directory = temporaryDirectory();
  const filePath = path.join(directory, "jobs.json");
  try {
    let now = 1_000_000;
    const store = new RemoteJobStore(filePath, {
      tombstoneMaxAgeMs: 1_000,
      now: () => now,
    });
    store.save([snapshot("ra-gone", now)]);
    store.remove(["ra-gone"]);
    store.flushSync();
    // A recent tombstone is retained and keeps the removed job hidden.
    assert.deepEqual(store.load(), []);
    assert.deepEqual(readRegistry(filePath).tombstones, [
      { id: "ra-gone", deletedAt: now },
    ]);

    // Aging out drops the tombstone even when the jobs did not change, so the
    // registry cannot grow forever.
    now += 5_000;
    store.save([]);
    store.flushSync();
    assert.equal(readRegistry(filePath).tombstones, undefined);

    // The aged-out id can be tracked again.
    store.save([snapshot("ra-returned", now)]);
    store.flushSync();
    assert.deepEqual(
      store.load().map((job) => job.id),
      ["ra-returned"],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("remote job registry caps retained tombstones", () => {
  const directory = temporaryDirectory();
  const filePath = path.join(directory, "jobs.json");
  try {
    let now = 2_000_000;
    const store = new RemoteJobStore(filePath, {
      tombstoneLimit: 2,
      now: () => now,
    });
    for (const id of ["ra-one", "ra-two", "ra-three"]) {
      store.save([snapshot(id, now)]);
      store.remove([id]);
      now += 1;
    }
    store.flushSync();
    assert.deepEqual(
      readRegistry(filePath).tombstones?.map((item) => item.id),
      ["ra-two", "ra-three"],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
