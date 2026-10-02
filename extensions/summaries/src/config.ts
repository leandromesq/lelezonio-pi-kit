import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Data, Effect } from "effect";

class ConfigWriteError extends Data.TaggedError("ConfigWriteError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const REASONING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

/**
 * When automatic recaps run. `auto` recaps every meaningful settled run,
 * `manual` keeps the package active but waits for `/recap`, and `off`
 * disables automatic recaps. `/recap` works in every mode; the package is
 * never disabled by default.
 */
export const SUMMARY_MODES = ["auto", "manual", "off"] as const;
export type SummaryMode = (typeof SUMMARY_MODES)[number];

export interface SummaryConfig {
  readonly provider: string;
  readonly model: string;
  readonly reasoning: ReasoningLevel;
  readonly mode: SummaryMode;
  /**
   * Minimum tool calls for a settled run to earn an automatic recap. Runs
   * below the threshold are treated as trivial conversation and skipped;
   * on-demand `/recap` ignores the threshold.
   */
  readonly minToolCalls: number;
}

export const DEFAULT_SUMMARY_CONFIG: SummaryConfig = {
  provider: "opencode-go",
  model: "deepseek-v4-flash",
  // Recaps are a small structured-output task. Leaving reasoning off keeps
  // the answer budget available for the JSON/tool arguments and reduces
  // latency; users can still opt into a level with /summary-model.
  reasoning: "off",
  mode: "auto",
  // One tool call is the cheapest reliable signal that a run did real work
  // instead of a single conversational turn.
  minToolCalls: 1,
};

const extensionDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
export const PRIVATE_CONFIG_PATH = join(
  extensionDirectory,
  "config.private.json",
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isReasoningLevel = (value: unknown): value is ReasoningLevel =>
  typeof value === "string" &&
  REASONING_LEVELS.includes(value as ReasoningLevel);

export const isSummaryMode = (value: unknown): value is SummaryMode =>
  typeof value === "string" && SUMMARY_MODES.includes(value as SummaryMode);

export function parseSummaryConfig(value: unknown) {
  if (!isRecord(value)) return DEFAULT_SUMMARY_CONFIG;

  if (
    typeof value.provider !== "string" ||
    !value.provider.trim() ||
    typeof value.model !== "string" ||
    !value.model.trim() ||
    !isReasoningLevel(value.reasoning)
  ) {
    return DEFAULT_SUMMARY_CONFIG;
  }

  // Newer optional fields degrade individually so a hand-edited config that
  // predates them keeps working without losing its model selection.
  const mode = isSummaryMode(value.mode)
    ? value.mode
    : DEFAULT_SUMMARY_CONFIG.mode;
  const minToolCalls =
    typeof value.minToolCalls === "number" &&
    Number.isInteger(value.minToolCalls) &&
    value.minToolCalls >= 0
      ? value.minToolCalls
      : DEFAULT_SUMMARY_CONFIG.minToolCalls;

  return {
    provider: value.provider.trim(),
    model: value.model.trim(),
    reasoning: value.reasoning,
    mode,
    minToolCalls,
  } satisfies SummaryConfig;
}

export function loadSummaryConfig() {
  try {
    return parseSummaryConfig(
      JSON.parse(readFileSync(PRIVATE_CONFIG_PATH, "utf8")),
    );
  } catch {
    return DEFAULT_SUMMARY_CONFIG;
  }
}

export function saveSummaryConfig(config: SummaryConfig, signal?: AbortSignal) {
  const tempPath = `${PRIVATE_CONFIG_PATH}.${process.pid}.${randomUUID()}.tmp`;
  const write = Effect.tryPromise({
    try: async (effectSignal) => {
      await mkdir(dirname(PRIVATE_CONFIG_PATH), { recursive: true });
      try {
        await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
          signal: effectSignal,
        });
        await rename(tempPath, PRIVATE_CONFIG_PATH);
      } catch (error) {
        await unlink(tempPath).catch(() => undefined);
        throw error;
      }
    },
    catch: (cause) =>
      new ConfigWriteError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }).pipe(Effect.timeout("5 seconds"));

  return Effect.runPromise(write, signal ? { signal } : undefined);
}
