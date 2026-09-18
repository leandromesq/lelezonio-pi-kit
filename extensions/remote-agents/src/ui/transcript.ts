import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../../../shared/terminal-text.ts";
import { createTranscriptLineCache } from "../../../shared/ui/transcript-cache.ts";

/** Transcript policy on the shared stripping: expand tabs, drop controls. */
export function sanitizeText(text: string) {
  return sanitizeTerminalText(text, { tabWidth: 2 });
}

export function buildTranscriptLines(text: string, width: number) {
  const lines: string[] = [];
  for (const raw of sanitizeText(text).split("\n")) {
    const segment = raw.split("\r").at(-1) ?? "";
    if (!segment) lines.push("");
    else lines.push(...wrapTextWithAnsi(segment, Math.max(10, width)));
  }
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The per-frame input the shared cache keys on: the text plus its revision. */
interface TranscriptInput {
  text: string;
  revision: number;
}

/**
 * Render-cache contract of `docs/ui-conventions.md` section 8 for the remote
 * takeover transcript: re-wrapping the whole transcript is the expensive part
 * of a frame, so the lines are memoized by (transcript revision, width, theme)
 * and only rebuilt when one of those actually changes. The caller bumps the
 * revision from `RemoteAgentSnapshot.transcriptVersion`.
 */
export function createTranscriptCache() {
  const cache = createTranscriptLineCache<TranscriptInput, string>({
    revision: (input) => input.revision,
    // The whole transcript is one committed chunk: a flat text blob has no
    // item identity to reuse, so any change rebuilds it as before.
    items: (input) => [input.text],
    renderItem: (_theme, text, width, out) => {
      out.push(...buildTranscriptLines(text, width));
    },
    assemble: (committed) => committed,
  });
  return {
    get(
      text: string,
      nextRevision: number,
      nextWidth: number,
      nextTheme: Theme,
    ) {
      return cache.get({ text, revision: nextRevision }, nextWidth, nextTheme);
    },
    invalidate() {
      cache.invalidate();
    },
  };
}
