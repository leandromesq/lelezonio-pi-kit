/**
 * Output rendering for the /ps detail view: turns a captured stream's text
 * into sanitized, wrapped display lines. Sanitization happens here — at
 * render time, never at capture time — because raw ANSI/control characters
 * desync the TUI renderer and smear the overlay.
 */

import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../../../shared/terminal-text.ts";

/**
 * Output policy on the shared terminal-text stripping: expand tabs and drop
 * the remaining control chars. Terminal-expanded tabs (and stray escapes) make
 * lines wider than the width we declare to the TUI, which desyncs the
 * renderer.
 */
export function sanitizeText(text: string) {
  return sanitizeTerminalText(text, { tabWidth: 2 });
}

/**
 * Split, sanitize, and wrap one `\n`-delimited raw segment. Kept separate so
 * the incremental cache can reuse it both for freshly appended segments and
 * for the one segment straddling a head-truncation cut.
 */
function segmentLines(rawSegment: string, safeWidth: number): string[] {
  // Carriage-return progress lines (npm, cargo): keep only the final state.
  const segments = rawSegment.split("\r");
  const finalSegment = segments.at(-1) ?? "";
  const lastSegment =
    finalSegment || [...segments].reverse().find((segment) => segment) || "";
  const clean = sanitizeText(lastSegment);
  if (clean.length === 0) return [""];
  return wrapTextWithAnsi(clean, safeWidth);
}

/** Split, sanitize, and wrap a stream's text into display lines. */
export function buildOutputLines(text: string, width: number) {
  const safeWidth = Math.max(10, width);
  const rawSegments = text.split("\n");
  const out: string[] = [];
  for (const raw of rawSegments) out.push(...segmentLines(raw, safeWidth));
  // Drop one trailing empty line from a trailing "\n" so the tail pin sits
  // on the last real output line.
  if (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/** Diagnostics for tests: how much work the cache did, not what it retained. */
export interface OutputLineCacheStats {
  /** Raw segments sanitized+wrapped (a full rebuild counts every segment). */
  segments: number;
  /** Full rebuilds caused by a width change or an inconsistent buffer view. */
  rebuilds: number;
}

/** One committed `\n`-delimited segment: its stream-length and wrapped lines. */
interface LineRecord {
  /** Stream characters consumed by this segment, including its "\n". */
  chars: number;
  lines: string[];
}

/**
 * Cache of wrapped lines keyed by (buffer version, width). Chatty processes
 * bump the version per chunk, so a naive cache would re-sanitize and re-wrap
 * the whole retained buffer (up to megabytes) on every render. Instead this
 * cache is append-only: it remembers the wrapped lines of every *complete*
 * raw segment, then only processes the new suffix on each new version. When
 * the buffer evicts bytes from the head, the corresponding committed segments
 * are dropped (and the one segment the cut lands inside is re-wrapped from
 * the retained text, which is at most a single line). A small chunk therefore
 * costs O(chunk), not O(buffer).
 *
 * The trailing (unterminated) segment is re-wrapped each call on purpose: an
 * escape sequence or a `\r` progress line may still be mid-flight, and this
 * is also the natural fallback for a pathological no-newline firehose.
 *
 * `truncatedChars` is optional so existing callers/tests that never truncate
 * keep working; without it the cache falls back to a startsWith append check.
 */
export function createOutputLineCache() {
  const stats: OutputLineCacheStats = { segments: 0, rebuilds: 0 };

  // Absolute (stream coordinate) state. Offsets never shift when the head is
  // truncated, which keeps append bookkeeping independent of eviction.
  let records: LineRecord[] = [];
  let head = 0;
  let recordsStartAbs = 0;
  let recordsEndAbs = 0;
  let consumedAbs = 0;
  let lastNonEmpty = "";
  let current = "";
  let pendingChars = 0;

  // Memoized inputs/outputs, so repeated renders at the same buffer version
  // return the identical array (and do no work at all).
  let memoVersion = -1;
  let memoWidth = -1;
  let prevVersion = -1;
  let prevWidth = -1;
  let prevText = "";
  let prevTrunc = 0;
  let result: string[] = [];

  const reset = (trunc: number) => {
    records = [];
    head = 0;
    recordsStartAbs = trunc;
    recordsEndAbs = trunc;
    consumedAbs = trunc;
    lastNonEmpty = "";
    current = "";
    pendingChars = 0;
  };

  /** Consume the unprocessed suffix of `text` into committed records. */
  const consume = (text: string, trunc: number, safeWidth: number) => {
    let rest = text.slice(consumedAbs - trunc);
    while (rest.length > 0) {
      const nl = rest.indexOf("\n");
      const cr = rest.indexOf("\r");
      if (cr !== -1 && (nl === -1 || cr < nl)) {
        current += rest.slice(0, cr);
        pendingChars += cr;
        if (current.length > 0) lastNonEmpty = current;
        current = "";
        pendingChars += 1; // the "\r"
        rest = rest.slice(cr + 1);
        continue;
      }
      if (nl === -1) {
        current += rest;
        pendingChars += rest.length;
        break;
      }
      current += rest.slice(0, nl);
      pendingChars += nl;
      records.push({
        chars: pendingChars + 1,
        lines: segmentLines(current || lastNonEmpty, safeWidth),
      });
      stats.segments++;
      recordsEndAbs += pendingChars + 1;
      pendingChars = 0;
      lastNonEmpty = "";
      current = "";
      rest = rest.slice(nl + 1);
    }
    consumedAbs = trunc + text.length;
  };

  const assemble = (safeWidth: number) => {
    const lines: string[] = [];
    for (let i = head; i < records.length; i++) {
      for (const line of records[i].lines) lines.push(line);
    }
    for (const line of segmentLines(current || lastNonEmpty, safeWidth)) {
      lines.push(line);
    }
    stats.segments++;
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  };

  return {
    get(text: string, version: number, width: number, truncatedChars?: number) {
      // Same buffer version and width: hand back the exact same layout.
      if (version === memoVersion && width === memoWidth) return result;

      const safeWidth = Math.max(10, width);
      const trunc = truncatedChars ?? 0;
      const widthChanged = width !== prevWidth;
      const canExtend =
        prevVersion >= 0 &&
        version > prevVersion &&
        !widthChanged &&
        trunc >= prevTrunc &&
        consumedAbs <= trunc + text.length &&
        recordsEndAbs <= trunc + text.length &&
        (truncatedChars !== undefined || text.startsWith(prevText));

      if (!canExtend) {
        stats.rebuilds++;
        reset(trunc);
      } else {
        // Drop committed segments that fell entirely before the retained
        // window. A segment the cut lands inside is re-wrapped from `text`.
        while (
          head < records.length &&
          recordsStartAbs + records[head].chars <= trunc
        ) {
          recordsStartAbs += records[head].chars;
          head++;
        }
        if (head < records.length && recordsStartAbs < trunc) {
          const nl = text.indexOf("\n");
          if (nl === -1) {
            stats.rebuilds++;
            reset(trunc);
          } else {
            records[head] = {
              chars: nl + 1,
              lines: segmentLines(text.slice(0, nl), safeWidth),
            };
            stats.segments++;
            recordsStartAbs = trunc;
          }
        }
        // The cut consumed the whole pending tail too: restart it at the cut.
        if (trunc > recordsEndAbs) {
          recordsEndAbs = trunc;
          consumedAbs = trunc;
          pendingChars = 0;
          lastNonEmpty = "";
          current = "";
        }
        if (head > 64) {
          records = records.slice(head);
          head = 0;
        }
      }

      consume(text, trunc, safeWidth);
      result = assemble(safeWidth);
      memoVersion = version;
      memoWidth = width;
      prevVersion = version;
      prevWidth = width;
      prevTrunc = trunc;
      prevText = text;
      return result;
    },
    stats,
  };
}
