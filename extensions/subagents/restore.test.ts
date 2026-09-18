import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  readFileTail,
  readWorkerSummary,
  summaryFromSessionFile,
  WORKER_FULL_TAIL_BYTES,
  WORKER_TAIL_BYTES,
} from "./src/restore.ts";

function withTempFile(lines: string[], run: (filePath: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-restore-"));
  const filePath = path.join(dir, "session.jsonl");
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
  try {
    run(filePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

test("a terminal message inside the small tail avoids the wide read", () => {
  withTempFile([filler(4000), assistantRecord("done!", 1234)], (filePath) => {
    const summary = readWorkerSummary(filePath);
    assert.equal(summary.found, true);
    assert.equal(summary.finalText, "done!");
    assert.equal(summary.settledAt, 1234);
    assert.equal(summary.budgetBytes, WORKER_TAIL_BYTES);
  });
});

test("a terminal message older than the small tail widens to the full tail", () => {
  withTempFile(
    [assistantRecord("archived", 999), filler(20 * 1024), filler(20 * 1024)],
    (filePath) => {
      assert.equal(
        summaryFromSessionFile(filePath, WORKER_TAIL_BYTES).found,
        false,
      );
      const summary = readWorkerSummary(filePath);
      assert.equal(summary.found, true);
      assert.equal(summary.finalText, "archived");
      assert.equal(summary.settledAt, 999);
      assert.equal(summary.budgetBytes, WORKER_FULL_TAIL_BYTES);
    },
  );
});

test("an error record restores its message", () => {
  withTempFile([assistantRecord("", 5, "error", "boom")], (filePath) => {
    const summary = readWorkerSummary(filePath);
    assert.equal(summary.found, true);
    assert.equal(summary.errorText, "boom");
    assert.equal(summary.budgetBytes, WORKER_TAIL_BYTES);
  });
});

test("readFileTail drops a partial first line", () => {
  const first = JSON.stringify({ type: "x", pad: "a".repeat(200) });
  const second = assistantRecord("kept", 1);
  withTempFile([first, second], (filePath) => {
    assert.equal(readFileTail(filePath, second.length + 10), `${second}\n`);
  });
});

test("an unreadable file yields an empty summary instead of throwing", () => {
  const missing = path.join(
    os.tmpdir(),
    `subagents-missing-${Date.now()}.jsonl`,
  );
  const summary = readWorkerSummary(missing);
  assert.equal(summary.found, false);
  assert.equal(summary.finalText, "");
  assert.equal(summary.settledAt, 0);
});
