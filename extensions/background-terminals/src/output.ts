/**
 * OutputBuffer — bounded in-memory capture of one process stream.
 *
 * Newest output is always retained; when the retained size exceeds the cap,
 * whole chunks are evicted from the head and counted in `truncatedBytes`.
 * A single chunk larger than the cap itself is trimmed to its tail (on a
 * UTF-8 boundary) so retention is strictly bounded even for one giant write.
 * An optional spill callback receives every chunk (in order, before any
 * eviction) so the caller can keep a complete on-disk copy.
 *
 * Plain TS by design: this is push-based accumulation driven by node stream
 * 'data' callbacks, not stream transformation.
 */

import type { OutputView } from "./domain.ts";

export class OutputBuffer {
  private chunks: string[] = [];
  /** Bytes currently retained across `chunks`. */
  private retainedBytes = 0;
  /** Characters currently retained across `chunks` (mirrors `retainedBytes`). */
  private retainedChars = 0;
  /** Cached join of `chunks`; invalidated on push so 1Hz UI ticks are cheap. */
  private cachedText: string | undefined = "";
  /** Bumped on every push; lets the UI cache derived line layouts. */
  version = 0;
  totalBytes = 0;
  truncatedBytes = 0;
  /**
   * Characters dropped from the head of the retained view. The incremental
   * line cache uses this to know exactly how much of its built lines were
   * evicted, without re-scanning the whole buffer.
   */
  truncatedChars = 0;
  spillPath?: string;

  private readonly maxRetainedBytes: number;
  private readonly spill?: (chunk: string) => unknown;

  constructor(maxRetainedBytes: number, spill?: (chunk: string) => unknown) {
    this.maxRetainedBytes = maxRetainedBytes;
    this.spill = spill;
  }

  push(chunk: string) {
    if (chunk.length === 0) return true;
    let bytes = Buffer.byteLength(chunk, "utf8");
    this.totalBytes += bytes;
    const spillAccepted = this.spill?.(chunk) !== false;
    if (bytes > this.maxRetainedBytes) {
      // A single pathological chunk larger than the whole cap: everything
      // retained so far precedes it in the stream, so evict all of it, then
      // keep only the chunk's tail (cut on a UTF-8 code point boundary).
      // Retention stays strictly bounded even for one giant write, and the
      // retained view stays contiguous (no hole in the middle).
      this.truncatedBytes += this.retainedBytes;
      this.truncatedChars += this.retainedChars;
      this.chunks = [];
      this.retainedBytes = 0;
      this.retainedChars = 0;
      const raw = Buffer.from(chunk, "utf8");
      let start = raw.length - this.maxRetainedBytes;
      while (start < raw.length && (raw[start] & 0xc0) === 0x80) start++;
      this.truncatedBytes += start;
      const trimmed = raw.subarray(start).toString("utf8");
      // `start` is on a UTF-8 code point boundary, so the dropped prefix has
      // exactly this many decoded characters.
      this.truncatedChars += chunk.length - trimmed.length;
      chunk = trimmed;
      bytes = raw.length - start;
    }
    this.chunks.push(chunk);
    this.retainedBytes += bytes;
    this.retainedChars += chunk.length;
    while (
      this.retainedBytes > this.maxRetainedBytes &&
      this.chunks.length > 1
    ) {
      const evicted = this.chunks.shift();
      if (evicted === undefined) break;
      const evictedBytes = Buffer.byteLength(evicted, "utf8");
      this.retainedBytes -= evictedBytes;
      this.retainedChars -= evicted.length;
      this.truncatedBytes += evictedBytes;
      this.truncatedChars += evicted.length;
    }
    this.cachedText = undefined;
    this.version++;
    return spillAccepted;
  }

  view(): OutputView {
    this.cachedText ??= this.chunks.join("");
    return {
      text: this.cachedText,
      totalBytes: this.totalBytes,
      truncatedBytes: this.truncatedBytes,
      truncatedChars: this.truncatedChars,
      spillPath: this.spillPath,
    };
  }
}
