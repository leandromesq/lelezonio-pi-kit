import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  formatActivityStatus,
  isEmptyActivity,
  type ActivityCounts,
} from "../../../shared/activity-status.ts";
import type { RemoteAgentSnapshot } from "../domain.ts";

/**
 * Counts the tracked jobs the way the shared status line expects: everything
 * settled that is not in a dedicated bucket stays in `done`, so a cancelled
 * job is still reported as finished rather than dropped.
 */
export function remoteActivityCounts(
  jobs: ReadonlyArray<RemoteAgentSnapshot>,
): ActivityCounts {
  const running = jobs.filter(
    (job) => job.status === "working" || job.status === "starting",
  ).length;
  const blocked = jobs.filter((job) => job.status === "blocked").length;
  const unreachable = jobs.filter((job) => job.status === "unreachable").length;
  const failed = jobs.filter((job) => job.status === "failed").length;
  return {
    running,
    done: jobs.length - running - blocked - unreachable - failed,
    failed,
    questions: blocked,
    offline: unreachable,
  };
}

/** `undefined` when nothing is left to report, so the status line is cleared. */
export function remoteActivityStatus(
  theme: Theme,
  jobs: ReadonlyArray<RemoteAgentSnapshot>,
): string | undefined {
  const counts = remoteActivityCounts(jobs);
  if (isEmptyActivity(counts)) return undefined;
  return formatActivityStatus(theme, "remote", counts);
}
