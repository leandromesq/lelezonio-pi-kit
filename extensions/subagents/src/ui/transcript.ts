/**
 * Transcript rendering for the takeover view: turns a SubagentSnapshot's
 * normalized transcript + live state into plain wrapped lines. Ported from
 * v1, with the session-poking replaced by snapshot reads.
 *
 * The takeover view renders every frame, so `buildTranscriptLines` cannot
 * re-sanitize and re-wrap the whole history (up to 512 items of 64 KiB) on
 * each scroll tick, keystroke, or 1 Hz clock. `createTranscriptLineCache`
 * keeps the wrapped lines of the committed items append-only and re-wraps
 * only the new suffix plus the volatile live tail; the whole result is
 * additionally memoized by (snapshot revision, width, theme), following the
 * `shared/ui/transcript-cache.ts` render-cache contract.
 *
 * Item objects are immutable once appended, so pointer equality is enough to
 * detect an append. A head eviction (the 512-item cap) changes `items[0]` and
 * forces a full rebuild.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../../../shared/terminal-text.ts";
import {
  createTranscriptLineCache as createSharedTranscriptLineCache,
  type TranscriptLineCache as SharedTranscriptLineCache,
} from "../../../shared/ui/transcript-cache.ts";
import type { SubagentSnapshot, TranscriptItem } from "../domain.ts";

/** Explicit ellipsis: the pi-tui default is `...` and must never be used. */
const ELLIPSIS = "…";

/**
 * Transcript policy on the shared terminal-text stripping: expand tabs and
 * drop the remaining control chars. Terminal-expanded tabs (and stray escapes)
 * make lines wider than the width we declare to the TUI, which desyncs the
 * renderer and smears the overlay.
 */
export function sanitizeText(text: string): string {
  return sanitizeTerminalText(text, { tabWidth: 2 });
}

function renderUserText(
  theme: Theme,
  text: string,
  width: number,
  out: string[],
) {
  const clean = sanitizeText(text).trim();
  if (!clean) return;
  const wrapped = wrapTextWithAnsi(clean, Math.max(10, width - 2));
  for (let i = 0; i < wrapped.length; i++) {
    const prefix = i === 0 ? theme.fg("accent", "> ") : "  ";
    out.push(
      truncateToWidth(
        prefix + theme.fg("userMessageText", wrapped[i]),
        width,
        ELLIPSIS,
      ),
    );
  }
}

function renderThinking(
  theme: Theme,
  text: string,
  width: number,
  out: string[],
) {
  const reasoning = sanitizeText(text).trim();
  if (!reasoning) return;
  const prefix = theme.fg("dim", "~ ");
  const wrapped = wrapTextWithAnsi(reasoning, Math.max(10, width - 2));
  for (let i = 0; i < wrapped.length; i++) {
    out.push(
      truncateToWidth(
        (i === 0 ? prefix : "  ") + theme.fg("muted", theme.italic(wrapped[i])),
        width,
        ELLIPSIS,
      ),
    );
  }
}

function renderAssistantItem(
  theme: Theme,
  item: Extract<TranscriptItem, { kind: "assistant" }>,
  width: number,
  out: string[],
) {
  for (const part of item.parts) {
    if (part.type === "text") {
      const text = sanitizeText(part.text).trim();
      if (!text) continue;
      out.push(...wrapTextWithAnsi(text, width));
    } else if (part.type === "thinking") {
      renderThinking(
        theme,
        part.redacted ? "[redacted reasoning]" : part.text,
        width,
        out,
      );
    } else if (part.type === "toolCall") {
      const preview = part.argsPreview ? sanitizeText(part.argsPreview) : "";
      const line =
        theme.fg("muted", "→ ") +
        theme.fg("toolTitle", part.name) +
        (preview && preview !== "{}" ? theme.fg("dim", ` ${preview}`) : "");
      out.push(truncateToWidth(line, width, ELLIPSIS));
    }
  }
}

function renderToolResultItem(
  theme: Theme,
  item: Extract<TranscriptItem, { kind: "toolResult" }>,
  width: number,
  out: string[],
) {
  const firstLine =
    sanitizeText(item.outputPreview ?? "")
      .split("\n")
      .find((line) => line.trim()) ?? "";
  const label = item.isError
    ? theme.fg("error", "  error: ")
    : theme.fg("dim", "  output: ");
  out.push(
    truncateToWidth(
      label + theme.fg("dim", firstLine || "(no output)"),
      width,
      ELLIPSIS,
    ),
  );
}

/** Render one committed item into `out`, keeping its blank separator. */
function renderItem(
  theme: Theme,
  item: TranscriptItem,
  width: number,
  out: string[],
) {
  const before = out.length;
  if (item.kind === "user") {
    renderUserText(theme, item.text, width, out);
  } else if (item.kind === "assistant") {
    renderAssistantItem(theme, item, width, out);
  } else {
    renderToolResultItem(theme, item, width, out);
  }
  if (out.length > before) out.push("");
}

/** Append the volatile tail: live assistant text, live tools, queued input. */
function renderLive(
  snap: SubagentSnapshot,
  width: number,
  theme: Theme,
  out: string[],
) {
  // Live streaming assistant buffers (cleared when the finalized message lands).
  if (snap.liveAssistant) {
    const { thinking, text } = snap.liveAssistant;
    const before = out.length;
    if (out.length > 0) out.push("");
    if (thinking.trim()) renderThinking(theme, thinking, width, out);
    if (text.trim())
      out.push(...wrapTextWithAnsi(sanitizeText(text).trim(), width));
    if (out.length === before + 1) out.pop();
  }

  // Live tool executions (present until the ToolEnd lands in the transcript).
  for (const tool of snap.liveTools) {
    if (out.length > 0) out.push("");
    const marker = tool.done
      ? tool.isError
        ? theme.fg("error", "error")
        : theme.fg("success", "done")
      : theme.fg("warning", "running");
    let line = `${theme.fg("toolTitle", tool.name)} · ${marker}`;
    const preview = tool.outputPreview && sanitizeText(tool.outputPreview);
    if (preview) line += theme.fg("dim", ` · ${preview}`);
    out.push(truncateToWidth(line, width, ELLIPSIS));
  }

  // Queued steering/follow-up messages: show them immediately so Enter
  // visibly acknowledges the user's input instead of appearing to do nothing.
  for (const message of snap.queued) {
    if (out.length > 0) out.push("");
    const prefix = theme.fg("warning", `> [queued ${message.kind}] `);
    const wrapped = wrapTextWithAnsi(
      sanitizeText(message.text),
      Math.max(10, width - visibleWidth(prefix)),
    );
    for (let i = 0; i < wrapped.length; i++) {
      out.push(
        truncateToWidth(
          (i === 0 ? prefix : " ".repeat(visibleWidth(prefix))) +
            theme.fg("muted", wrapped[i]),
          width,
          ELLIPSIS,
        ),
      );
    }
  }
}

export type TranscriptLineCache = SharedTranscriptLineCache<SubagentSnapshot>;
export type { TranscriptLineCacheStats } from "../../../shared/ui/transcript-cache.ts";

/**
 * Per-view cache: wires the subagents transcript (snapshot items plus the
 * volatile live tail) into the shared primitive, which memoizes by
 * (transcript revision, width, theme) and keeps the committed items' wrapped
 * lines append-only so a live delta costs O(live tail), not O(history).
 */
export function createTranscriptLineCache(): TranscriptLineCache {
  return createSharedTranscriptLineCache<SubagentSnapshot, TranscriptItem>({
    revision: (snap) => snap.transcriptVersion,
    items: (snap) => snap.transcript,
    renderItem,
    assemble(committed, snap, width, theme) {
      while (committed.length > 0 && committed[committed.length - 1] === "")
        committed.pop();
      renderLive(snap, width, theme, committed);
      return committed;
    },
  });
}

/** One-shot render; the takeover view uses `createTranscriptLineCache`. */
export function buildTranscriptLines(
  snap: SubagentSnapshot,
  width: number,
  theme: Theme,
): string[] {
  return createTranscriptLineCache().get(snap, width, theme);
}
