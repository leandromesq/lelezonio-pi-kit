import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

const MAX_SAMPLES = 200;

export function percentile(
  samples: readonly number[],
  quantile: number,
): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(quantile * sorted.length) - 1),
  );
  return sorted[index]!;
}

function pushSample(samples: number[], value: number) {
  if (!Number.isFinite(value) || value < 0) return;
  samples.push(value);
  if (samples.length > MAX_SAMPLES)
    samples.splice(0, samples.length - MAX_SAMPLES);
}

function durationLine(label: string, samples: number[]) {
  const p50 = percentile(samples, 0.5);
  const p95 = percentile(samples, 0.95);
  const max = percentile(samples, 1);
  return p50 === null
    ? `${label}: no samples yet`
    : `${label}: ${samples.length} samples · p50 ${Math.round(p50)}ms · p95 ${Math.round(p95!)}ms · max ${Math.round(max!)}ms`;
}

export default function performanceExtension(pi: ExtensionAPI) {
  const loadedAt = performance.now();
  let sessionReadyMs = 0;
  const toolStarts = new Map<string, number>();
  const turnStarts = new Map<number, number>();
  const toolDurations: number[] = [];
  const turnDurations: number[] = [];

  pi.on("session_start", () => {
    sessionReadyMs = performance.now() - loadedAt;
    toolStarts.clear();
    turnStarts.clear();
  });
  pi.on("tool_execution_start", (event) => {
    toolStarts.set(event.toolCallId, performance.now());
  });
  pi.on("tool_execution_end", (event) => {
    const started = toolStarts.get(event.toolCallId);
    toolStarts.delete(event.toolCallId);
    if (started !== undefined)
      pushSample(toolDurations, performance.now() - started);
  });
  pi.on("turn_start", (event) => {
    turnStarts.set(event.turnIndex, performance.now());
  });
  pi.on("turn_end", (event) => {
    const started = turnStarts.get(event.turnIndex);
    turnStarts.delete(event.turnIndex);
    if (started !== undefined)
      pushSample(turnDurations, performance.now() - started);
  });

  pi.registerCommand("perf", {
    description: "Show lightweight Pi runtime performance metrics",
    handler: async (_args, ctx) => {
      const memoryMb = process.memoryUsage().rss / 1024 / 1024;
      const rows = [
        "Pi runtime performance",
        "",
        `Extension runtime ready: ${Math.round(sessionReadyMs)}ms`,
        durationLine("Turns", turnDurations),
        durationLine("Tools", toolDurations),
        `Process: ${Math.round(memoryMb)} MiB RSS · uptime ${Math.round(process.uptime())}s`,
        "",
        `Samples are bounded to the most recent ${MAX_SAMPLES}; instrumentation has no polling timer.`,
      ];
      if (ctx.mode !== "tui") {
        ctx.ui.notify(rows.join("\n"), "info");
        return;
      }
      await ctx.ui.custom<void>(
        (tui, theme, keybindings, done) => ({
          render(width: number) {
            return [
              theme.fg("borderAccent", "─".repeat(Math.max(1, width))),
              ...rows.map((line, index) =>
                truncateToWidth(
                  ` ${index === 0 ? theme.fg("accent", theme.bold(line)) : theme.fg(index >= 2 && index <= 5 ? "text" : "dim", line)}`,
                  width,
                ),
              ),
              truncateToWidth(
                theme.fg(
                  "dim",
                  ` ${keybindings.getKeys("tui.select.cancel").join("/") || "Esc"} close`,
                ),
                width,
              ),
              theme.fg("borderAccent", "─".repeat(Math.max(1, width))),
            ];
          },
          handleInput(data: string) {
            if (
              matchesKey(data, Key.escape) ||
              keybindings.matches(data, "tui.select.cancel")
            )
              done();
            else tui.requestRender();
          },
          invalidate() {},
        }),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "80%",
            maxHeight: "80%",
            minWidth: 50,
          },
        },
      );
    },
  });
}
