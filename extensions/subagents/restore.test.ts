import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  discoverWorkerSessions,
  readFileTail,
  readWorkerSummary,
  summaryFromSessionFile,
  WORKER_FULL_TAIL_BYTES,
  WORKER_TAIL_BYTES,
} from "./src/restore.ts";

async function withTempDir(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "subagents-restore-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withTempFile(
  lines: string[],
  run: (filePath: string) => Promise<void>,
) {
  await withTempDir(async (directory) => {
    const filePath = path.join(directory, "session.jsonl");
    await writeFile(filePath, `${lines.join("\n")}\n`);
    await run(filePath);
  });
}

const assistantRecord = (
  text: string,
  ts: number,
  stopReason?: string,
  errorMessage?: string,
) =>
  JSON.stringify({
    type: "message",
    timestamp: ts,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      ...(stopReason ? { stopReason } : {}),
      ...(errorMessage ? { errorMessage } : {}),
    },
  });

const filler = (bytes: number) =>
  JSON.stringify({ type: "tool", timestamp: 1, payload: "z".repeat(bytes) });

test("a terminal message inside the small tail avoids the wide read", async () => {
  await withTempFile(
    [filler(4000), assistantRecord("done!", 1234)],
    async (filePath) => {
      const summary = await readWorkerSummary(filePath);
      assert.equal(summary.found, true);
      assert.equal(summary.finalText, "done!");
      assert.equal(summary.settledAt, 1234);
      assert.equal(summary.budgetBytes, WORKER_TAIL_BYTES);
    },
  );
});

test("a terminal message older than the small tail widens to the full tail", async () => {
  await withTempFile(
    [assistantRecord("archived", 999), filler(20 * 1024), filler(20 * 1024)],
    async (filePath) => {
      assert.equal(
        (await summaryFromSessionFile(filePath, WORKER_TAIL_BYTES)).found,
        false,
      );
      const summary = await readWorkerSummary(filePath);
      assert.equal(summary.found, true);
      assert.equal(summary.finalText, "archived");
      assert.equal(summary.settledAt, 999);
      assert.equal(summary.budgetBytes, WORKER_FULL_TAIL_BYTES);
    },
  );
});

test("an error record restores its message", async () => {
  await withTempFile(
    [assistantRecord("", 5, "error", "boom")],
    async (filePath) => {
      const summary = await readWorkerSummary(filePath);
      assert.equal(summary.found, true);
      assert.equal(summary.errorText, "boom");
      assert.equal(summary.budgetBytes, WORKER_TAIL_BYTES);
    },
  );
});

test("readFileTail drops a partial first line", async () => {
  const first = JSON.stringify({ type: "x", pad: "a".repeat(200) });
  const second = assistantRecord("kept", 1);
  await withTempFile([first, second], async (filePath) => {
    assert.equal(
      await readFileTail(filePath, second.length + 10),
      `${second}\n`,
    );
  });
});

test("an unreadable file yields an empty summary instead of throwing", async () => {
  await withTempDir(async (directory) => {
    const missing = path.join(directory, "missing.jsonl");
    const summary = await readWorkerSummary(missing);
    assert.equal(summary.found, false);
    assert.equal(summary.finalText, "");
    assert.equal(summary.settledAt, 0);
  });
});

test("discoverWorkerSessions finds the newest JSONL per worker directory", async () => {
  await withTempDir(async (directory) => {
    const root = path.join(directory, "workers", "parent-session");
    await mkdir(path.join(root, "child-one"), { recursive: true });
    await mkdir(path.join(root, "child-two"), { recursive: true });
    // A directory with no session file is not restorable.
    await mkdir(path.join(root, "child-empty"), { recursive: true });
    // A stray file directly under the root is not a worker directory.
    await writeFile(path.join(root, "not-a-worker.jsonl"), "{}");

    await writeFile(path.join(root, "child-one", "2026-01-01_old.jsonl"), "{}");
    await writeFile(path.join(root, "child-one", "2026-01-02_new.jsonl"), "{}");
    await writeFile(path.join(root, "child-two", "only.jsonl"), "{}");

    const found = await discoverWorkerSessions(root);
    assert.deepEqual(found.map((entry) => entry.id).sort(), [
      "child-one",
      "child-two",
    ]);
    const one = found.find((entry) => entry.id === "child-one");
    assert.equal(
      one?.filePath,
      path.join(root, "child-one", "2026-01-02_new.jsonl"),
    );
  });
});

test("discoverWorkerSessions treats a missing root as no previous session", async () => {
  await withTempDir(async (directory) => {
    const found = await discoverWorkerSessions(
      path.join(directory, "does-not-exist"),
    );
    assert.deepEqual(found, []);
  });
});
