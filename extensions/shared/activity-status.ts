import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Theme = ExtensionContext["ui"]["theme"];

/**
 * Counts accepted by every orchestration status line. All fields except the
 * three base counts are optional so a surface only pays for what it shows.
 */
export interface ActivityCounts {
  /** Active right now. */
  running: number;
  /** Finished successfully. */
  done: number;
  /** Finished with an error. */
  failed: number;
  /** Running with no recent progress. */
  stalled?: number;
  /** Waiting on an answer (subagent `ask_question`, remote "blocked"). */
  questions?: number;
  /** Known but currently unreachable (remote hosts). */
  offline?: number;
}

/** Surfaces allowed to publish a status line, and the command that opens them. */
export type ActivityLabel = "subagents" | "workflows" | "remote";

const COMMAND: Record<ActivityLabel, string> = {
  subagents: "/subagents",
  workflows: "/workflows",
  remote: "/remotes",
};

const SQUARE = "■";

/**
 * Single status-line format for every asynchronous orchestration surface:
 *
 *   subagents: ■ 2 running · ■ 1 done · /subagents to view
 *
 * Order is fixed (running, stalled, done, failed, ask, offline) so the eye can
 * find the same count in the same place across `/subagents`, `/workflows` and
 * `/remotes`. Running is `warning` everywhere — it is activity to notice, not a
 * failure — and each count keeps its own semantic color.
 */
export function formatActivityStatus(
  theme: Theme,
  label: ActivityLabel,
  counts: ActivityCounts,
) {
  const parts: string[] = [];
  if (counts.running > 0) {
    parts.push(theme.fg("warning", `${SQUARE} ${counts.running} running`));
  }
  if (counts.stalled && counts.stalled > 0) {
    parts.push(theme.fg("error", `◔ ${counts.stalled} stalled`));
  }
  if (counts.done > 0) {
    parts.push(theme.fg("success", `${SQUARE} ${counts.done} done`));
  }
  if (counts.failed > 0) {
    parts.push(theme.fg("error", `${SQUARE} ${counts.failed} failed`));
  }
  if (counts.questions && counts.questions > 0) {
    parts.push(theme.fg("warning", `? ${counts.questions} ask`));
  }
  if (counts.offline && counts.offline > 0) {
    parts.push(theme.fg("warning", `${SQUARE} ${counts.offline} offline`));
  }
  parts.push(theme.fg("accent", COMMAND[label]) + theme.fg("dim", " to view"));

  return `${theme.fg("muted", `${label}:`)} ${parts.join(theme.fg("dim", " · "))}`;
}

/** True when every count is zero, so callers can clear the status instead. */
export function isEmptyActivity(counts: ActivityCounts): boolean {
  return (
    counts.running === 0 &&
    counts.done === 0 &&
    counts.failed === 0 &&
    !counts.stalled &&
    !counts.questions &&
    !counts.offline
  );
}
