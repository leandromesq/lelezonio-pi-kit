/**
 * Best-effort recovery of a persisted worker session after a parent restart.
 *
 * A worker session JSONL can be multi-megabyte, and a previous parent may have
 * dozens of children; reading 256 KiB of each at startup is a lot of I/O for a
 * summary that almost always lives in the last few hundred bytes. The scan is
 * therefore tail-first: a small read is enough when it already contains a
 * terminal assistant message, and only otherwise does it widen to the old cap.
 */

import * as fs from "node:fs";

/** First read: enough for a normal final assistant message. */
export const WORKER_TAIL_BYTES = 8 * 1024;
/** Fallback read, matching the pre-tail-first behavior. */
export const WORKER_FULL_TAIL_BYTES = 256 * 1024;

/** Read at most `maxBytes` from the end, dropping a partial first line. */
export function readFileTail(filePath: string, maxBytes: number): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    const tail = buffer.toString("utf8");
    // A tail read starting mid-file begins inside a line: drop that partial
    // first line (truncated mid-entry) — the rest is intact. A read from byte
    // zero starts on a line boundary and must keep its first record.
    if (start === 0) return tail;
    const newline = tail.indexOf("\n");
    return newline >= 0 ? tail.slice(newline + 1) : tail;
  } finally {
    fs.closeSync(fd);
  }
}

export interface WorkerSummary {
  finalText: string;
  errorText?: string;
  settledAt: number;
  /** A terminal assistant record was seen inside the scanned tail. */
  found: boolean;
  /** Bytes requested for the scan that produced this summary. */
  budgetBytes: number;
}

/** Parse the final assistant text/error from a persisted worker session JSONL. */
export function summaryFromSessionFile(
  filePath: string,
  maxBytes: number,
): WorkerSummary {
  let finalText = "";
  let errorText: string | undefined;
  let settledAt = 0;
  let found = false;
  try {
    for (const line of readFileTail(filePath, maxBytes).split("\n")) {
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const record = entry as {
        type?: string;
        timestamp?: number;
        message?: {
          role?: string;
          content?: Array<{ type?: string; text?: string }>;
          stopReason?: string;
          errorMessage?: string;
          timestamp?: number;
        };
      };
      if (record.type !== "message" || record.message?.role !== "assistant")
        continue;
      const text = (record.message.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n");
      if (text || record.message.stopReason === "error") found = true;
      if (text) finalText = text;
      if (record.message.stopReason === "error") {
        errorText = record.message.errorMessage ?? "Restored run failed";
      }
      const ts = record.timestamp ?? record.message.timestamp ?? 0;
      if (ts) settledAt = ts;
    }
  } catch {
    // unreadable session → skip adoption
  }
  return { finalText, errorText, settledAt, found, budgetBytes: maxBytes };
}

/**
 * Tail-first summary: the small read stands on its own when it already holds a
 * terminal assistant message; otherwise widen once to the full tail budget.
 */
export function readWorkerSummary(filePath: string): WorkerSummary {
  const small = summaryFromSessionFile(filePath, WORKER_TAIL_BYTES);
  if (small.found) return small;
  return summaryFromSessionFile(filePath, WORKER_FULL_TAIL_BYTES);
}
