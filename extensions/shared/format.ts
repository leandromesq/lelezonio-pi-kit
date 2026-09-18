/**
 * One source of truth for the numbers and durations shown across surfaces.
 *
 * Before this module there were four `formatElapsed` implementations (subagents,
 * background-terminals, remote-agents, workflows) and three token formatters
 * (footer, shared context-utilization, workflows). They agreed by luck, not by
 * construction: the footer rendered `1500` tokens as `2k`, the subagent panel as
 * `1.5k`, and byte sizes came from pi's own `formatSize` (`1.5KB`).
 *
 * Keep this file dependency-free so every extension can import it, including
 * children and UI helpers.
 */

/**
 * Elapsed time for an open or settled range: `7s`, `3m07s`, `1h12m`.
 * Seconds are zero-padded only when minutes are shown, so the width stays
 * stable while a duration is still counting.
 */
export function formatElapsed(startedAt: number, finishedAt?: number): string {
  const end = Number.isFinite(finishedAt) ? (finishedAt as number) : Date.now();
  const totalSeconds = Math.max(0, Math.round((end - startedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${minutes.toString().padStart(2, "0")}m`;
  return minutes > 0
    ? `${minutes}m${seconds.toString().padStart(2, "0")}s`
    : `${seconds}s`;
}

/**
 * Compact token/size count for footers, status lines and dashboards:
 * `999`, `1.5k`, `126k`, `1.5M`.
 */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count)) return "?";
  const value = Math.max(0, count);
  if (value < 1000) return `${Math.round(value)}`;
  if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1000000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1000000).toFixed(1)}M`;
}
