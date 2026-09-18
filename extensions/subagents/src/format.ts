/**
 * Subagent formatting on top of the shared single sources of truth.
 *
 * Token/context formatting lives in `shared/context-utilization.ts` and the
 * orchestration status line in `shared/activity-status.ts`; the copies that
 * used to live here were explicitly "self-contained" and had already diverged
 * (a `❓` glyph and a different count order than the footer). Only stall
 * detection is subagent-specific and stays here.
 */

export {
  contextPercent,
  formatCompactTokens,
  formatContextUtilization,
  type ContextUtilization,
} from "../../shared/context-utilization.ts";
export {
  formatActivityStatus,
  isEmptyActivity,
  type ActivityCounts,
} from "../../shared/activity-status.ts";

/** A running subagent with no activity for this long is considered stalled. */
export const STALLED_AFTER_MS = 90_000;

export function isStalled(
  snap: { readonly status: string; readonly lastEventAt: number },
  now: number = Date.now(),
): boolean {
  return (
    snap.status === "running" && now - snap.lastEventAt >= STALLED_AFTER_MS
  );
}
