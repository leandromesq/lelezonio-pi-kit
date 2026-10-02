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
  jobs: Array<{ id: string; ownerSessionId?: string }>;
  tombstones?: Array<{ id: string; deletedAt: number }>;
  deliveryLeases?: Record<
    string,
    { sessionId: string; generation: number; expiresAt: number }
  >;
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

test("a legacy job without an owner survives registry rewrites", () => {
  const directory = temporaryDirectory();
  const filePath = path.join(directory, "jobs.json");
  try {
    const store = new RemoteJobStore(filePath);
    store.save([snapshot("ra-legacy", 1)]);
    store.flushSync();
    // A later write (another job, a lease) must preserve the unowned entry and
    // must not invent an owner for it: adoption is an explicit, separate act.
    store.save([snapshot("ra-legacy", 1), snapshot("ra-new", 2)]);
    store.flushSync();
    const legacy = store.load().find((job) => job.id === "ra-legacy");
    assert.ok(legacy, "the legacy job is preserved");
    assert.equal(legacy.ownerSessionId, undefined);
    assert.deepEqual(
      readRegistry(filePath).jobs.map((job) => job.id),
      ["ra-legacy", "ra-new"],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("remote delivery claims are atomic across stores and sessions", async () => {
  const directory = temporaryDirectory();
  const filePath = path.join(directory, "jobs.json");
  try {
    const now = 10_000;
    const storeA = new RemoteJobStore(filePath, { now: () => now });
    const storeB = new RemoteJobStore(filePath, { now: () => now });
    storeA.save([{ ...snapshot("ra-claim", 1), ownerSessionId: "session-1" }]);
    await storeA.flush();

    // Two managers for the SAME session (a resumed session overlapping its old
    // process) must not both win: the claimant token differentiates them.
    assert.equal(
      await storeA.claimDelivery(
        "ra-claim",
        "completion",
        "session-1",
        "token-a",
        1,
        1_000,
      ),
      true,
    );
    assert.equal(
      await storeB.claimDelivery(
        "ra-claim",
        "completion",
        "session-1",
        "token-b",
        1,
        1_000,
      ),
      false,
    );
    // The same claimant may retry its own claim.
    assert.equal(
      await storeA.claimDelivery(
        "ra-claim",
        "completion",
        "session-1",
        "token-a",
        1,
        1_000,
      ),
      true,
    );
    // Ownership is checked at claim time: a different session cannot claim.
    assert.equal(
      await storeB.claimDelivery(
        "ra-claim",
        "completion",
        "session-2",
        "token-c",
        1,
        1_000,
      ),
      false,
    );
    // A wholesale save from the losing store must not clobber the lease.
    storeB.save([{ ...snapshot("ra-claim", 2), ownerSessionId: "session-1" }]);
    await storeB.flush();
    assert.equal(
      await storeB.claimDelivery(
        "ra-claim",
        "completion",
        "session-1",
        "token-d",
        1,
        1_000,
      ),
      false,
    );

    // The wrong token cannot settle; the right one records the delivery.
    await storeB.settleDelivery(
      "ra-claim",
      "completion",
      "session-1",
      "token-b",
      1,
    );
    assert.equal(
      storeA.load().find((job) => job.id === "ra-claim")?.completionDeliveredTo,
      undefined,
    );
    await storeA.settleDelivery(
      "ra-claim",
      "completion",
      "session-1",
      "token-a",
      1,
    );
    const settled = storeB.load().find((job) => job.id === "ra-claim");
    assert.equal(settled?.completionDelivered, true);
    assert.equal(settled?.completionDeliveredTo, "session-1");
    // A settled delivery is permanent: no later claim can re-deliver it.
    assert.equal(
      await storeB.claimDelivery(
        "ra-claim",
        "completion",
        "session-1",
        "token-e",
        1,
        1_000,
      ),
      false,
    );
    assert.equal(readRegistry(filePath).deliveryLeases, undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a stale wholesale save cannot clear a delivered result", async () => {
  const directory = temporaryDirectory();
  const filePath = path.join(directory, "jobs.json");
  try {
    const now = 20_000;
    const owner = new RemoteJobStore(filePath, { now: () => now });
    owner.save([{ ...snapshot("ra-stale", 1), ownerSessionId: "session-1" }]);
    await owner.flush();
    assert.equal(
      await owner.claimDelivery(
        "ra-stale",
        "completion",
        "session-1",
        "t1",
        1,
        1_000,
      ),
      true,
    );
    await owner.settleDelivery("ra-stale", "completion", "session-1", "t1", 1);

    // A second manager loaded the job before the delivery and later writes a
    // NEWER timestamp without the delivery/ownership fields.
    const stale = new RemoteJobStore(filePath, { now: () => now + 5_000 });
    stale.save([
      {
        ...snapshot("ra-stale", 9_999),
        ownerSessionId: undefined,
        generation: 1,
      },
    ]);
    await stale.flush();

    const job = owner.load().find((item) => item.id === "ra-stale");
    assert.equal(job?.completionDelivered, true);
    assert.equal(job?.completionDeliveredTo, "session-1");
    assert.equal(job?.ownerSessionId, "session-1");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("settle and release validate the claimant token and generation", async () => {
  const directory = temporaryDirectory();
  const filePath = path.join(directory, "jobs.json");
  try {
    const now = 30_000;
    const store = new RemoteJobStore(filePath, { now: () => now });
    store.save([
      { ...snapshot("ra-gen", 1), ownerSessionId: "session-1", generation: 1 },
    ]);
    await store.flush();
    assert.equal(
      await store.claimDelivery(
        "ra-gen",
        "completion",
        "session-1",
        "t1",
        1,
        1_000,
      ),
      true,
    );

    // A follow-up send supersedes the run and its generation.
    store.save([
      {
        ...snapshot("ra-gen", 2),
        ownerSessionId: "session-1",
        generation: 2,
        completionDelivered: false,
      },
    ]);
    await store.flush();

    // The old generation cannot settle the new run.
    await store.settleDelivery("ra-gen", "completion", "session-1", "t1", 1);
    assert.equal(
      store.load().find((job) => job.id === "ra-gen")?.completionDeliveredTo,
      undefined,
    );

    // A fresh claim of the new run wins, and the old token cannot release it.
    assert.equal(
      await store.claimDelivery(
        "ra-gen",
        "completion",
        "session-1",
        "t2",
        2,
        1_000,
      ),
      true,
    );
    await store.releaseDelivery("ra-gen", "completion", "session-1", "t1");
    assert.equal(
      await store.claimDelivery(
        "ra-gen",
        "completion",
        "session-1",
        "t3",
        2,
        1_000,
      ),
      false,
    );

    // The new claimant settles the new run.
    await store.settleDelivery("ra-gen", "completion", "session-1", "t2", 2);
    const settled = store.load().find((job) => job.id === "ra-gen");
    assert.equal(settled?.completionDelivered, true);
    assert.equal(settled?.completionDeliveredTo, "session-1");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy adoption is atomic across stores", async () => {
  const directory = temporaryDirectory();
  const filePath = path.join(directory, "jobs.json");
  try {
    const storeA = new RemoteJobStore(filePath);
    const storeB = new RemoteJobStore(filePath);
    storeA.save([snapshot("ra-legacy", 1)]);
    await storeA.flush();

    assert.equal(await storeA.adopt("ra-legacy", "session-a"), true);
    // The second adopter loses and observes the winner's ownership.
    assert.equal(await storeB.adopt("ra-legacy", "session-b"), false);
    assert.equal(
      storeB.load().find((job) => job.id === "ra-legacy")?.ownerSessionId,
      "session-a",
    );
    // The winner's adoption is idempotent.
    assert.equal(await storeB.adopt("ra-legacy", "session-a"), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an abandoned delivery lease expires and can be released early", async () => {
  const directory = temporaryDirectory();
  const filePath = path.join(directory, "jobs.json");
  try {
    let now = 50_000;
    const store = new RemoteJobStore(filePath, { now: () => now });
    store.save([{ ...snapshot("ra-lease", 1), ownerSessionId: "session-1" }]);
    await store.flush();

    assert.equal(
      await store.claimDelivery(
        "ra-lease",
        "blocked",
        "session-1",
        "t1",
        1,
        500,
      ),
      true,
    );
    assert.equal(
      await store.claimDelivery(
        "ra-lease",
        "blocked",
        "session-1",
        "t2",
        1,
        500,
      ),
      false,
    );

    // A failed delivery releases its lease so a retry is immediate.
    await store.releaseDelivery("ra-lease", "blocked", "session-1", "t1");
    assert.equal(
      await store.claimDelivery(
        "ra-lease",
        "blocked",
        "session-1",
        "t2",
        1,
        500,
      ),
      true,
    );
    await store.releaseDelivery("ra-lease", "blocked", "session-1", "t2");

    // A crashed holder's lease expires on its own, without a release.
    assert.equal(
      await store.claimDelivery(
        "ra-lease",
        "blocked",
        "session-1",
        "t1",
        1,
        500,
      ),
      true,
    );
    now += 501;
    assert.equal(
      await store.claimDelivery(
        "ra-lease",
        "blocked",
        "session-1",
        "t2",
        1,
        500,
      ),
      true,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
