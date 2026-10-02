import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalText } from "../shared/terminal-text.ts";
import {
  SUMMARY_MODES,
  isSummaryMode,
  loadSummaryConfig,
  saveSummaryConfig,
  type SummaryConfig,
  type SummaryMode,
} from "./src/config.ts";
import { summarizeRun } from "./src/summarizer.ts";
import {
  buildFallbackRecap,
  createRunBoundary,
  getLastRunEntries,
  getRunEntries,
  isMeaningfulRun,
  isRunInterrupted,
  serializeRunTranscript,
} from "./src/transcript.ts";
import {
  openModelPicker,
  openReasoningPicker,
  renderRecap,
  type RecapEntryData,
} from "./src/ui.ts";

const RECAP_ENTRY_TYPE = "summary-recap";
const STATUS_KEY = "summaries";
const SHUTDOWN_WAIT_MS = 1_000;
const NOTIFICATION_TEXT_MAX = 200;

/**
 * One-line, control-free, length-bounded text for notifications. Error
 * messages can be multi-line or carry escape sequences; the shared helper
 * strips them and this caps the result so a notification is never a wall.
 */
export function summarizeErrorText(text: string) {
  const clean = sanitizeTerminalText(text.replace(/[\r\n\t]+/g, " "), {
    singleLine: true,
  })
    .replace(/\s{2,}/g, " ")
    .trim();
  return clean.length <= NOTIFICATION_TEXT_MAX
    ? clean
    : `${clean.slice(0, NOTIFICATION_TEXT_MAX - 1).trimEnd()}…`;
}

/**
 * Subagent children launched through the Herdr worker launcher carry
 * `PI_SUBAGENT=1` in their env. In them the summaries extension disables
 * itself entirely: a post-run recap inside a child is extra model activity
 * the parent does not orchestrate, and it races the child pane closing
 * right after completion. Other child extensions stay available; tools were
 * already excluded at launch.
 */
export const summariesDisabled = () => process.env.PI_SUBAGENT === "1";

/**
 * Test seams for the private config path. Pi calls the factory with only the
 * API, so production uses the real load/save pair; tests inject a fixed config
 * instead of depending on the developer's `config.private.json`.
 */
export interface SummariesDependencies {
  readonly loadConfig?: typeof loadSummaryConfig;
  readonly saveConfig?: typeof saveSummaryConfig;
}

async function waitForCancellation(
  tasks: readonly Promise<void>[],
  timeoutMs: number,
) {
  if (tasks.length === 0) return;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(tasks),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export default function (pi: ExtensionAPI, deps: SummariesDependencies = {}) {
  const loadConfig = deps.loadConfig ?? loadSummaryConfig;
  const saveConfig = deps.saveConfig ?? saveSummaryConfig;
  const runBoundary = createRunBoundary();
  const activeSummaries = new Map<AbortController, Promise<void>>();
  let sessionActive = false;
  let statusContext: ExtensionContext | undefined;
  // Bumped on every session or branch boundary. A recap task captured under an
  // older epoch is never appended: it would land on a different branch or
  // session than the run it describes.
  let epoch = 0;

  const updateStatus = () => {
    statusContext?.ui.setStatus(
      STATUS_KEY,
      activeSummaries.size > 0
        ? statusContext.ui.theme.fg("muted", "✦ summarizing run…")
        : undefined,
    );
  };

  const cancelActiveSummaries = () => {
    for (const [controller] of activeSummaries) controller.abort();
  };

  pi.registerEntryRenderer<RecapEntryData>(
    RECAP_ENTRY_TYPE,
    (entry, { expanded }, theme) => renderRecap(entry.data, expanded, theme),
  );

  /**
   * Start one recap generation for `entries` and append the entry only while
   * the originating session, branch leaf, and epoch are all still current.
   * Bound to those three so a late completion can never attach a recap to a
   * different session or a rewritten branch (the `/tree` and session-replace
   * races), and shutdown can cancel it.
   */
  const startRecap = (
    ctx: ExtensionContext,
    entries: readonly SessionEntry[],
    config: SummaryConfig,
  ) => {
    const controller = new AbortController();
    const taskEpoch = epoch;
    const taskSessionId = ctx.sessionManager.getSessionId();
    const taskLeafId = ctx.sessionManager.getLeafId();
    statusContext = ctx;

    const stillCurrent = () => {
      if (taskEpoch !== epoch || !sessionActive || controller.signal.aborted) {
        return false;
      }
      // The context can be invalidated by session replacement; a throw here
      // means the session is gone, so the recap must not be appended.
      try {
        return (
          ctx.sessionManager.getSessionId() === taskSessionId &&
          ctx.sessionManager.getLeafId() === taskLeafId
        );
      } catch {
        return false;
      }
    };

    const task = (async () => {
      let recap: RecapEntryData;
      try {
        const generated = await summarizeRun({
          modelRegistry: ctx.modelRegistry,
          config,
          transcript: serializeRunTranscript(entries),
          signal: controller.signal,
        });
        recap = {
          ...generated,
          provider: config.provider,
          model: config.model,
          reasoning: config.reasoning,
        };
      } catch (error) {
        if (controller.signal.aborted || !sessionActive) return;
        recap = {
          ...buildFallbackRecap(entries),
          provider: config.provider,
          model: config.model,
          reasoning: config.reasoning,
          fallback: true,
        };
        const detail = error instanceof Error ? ` ${error.message}` : "";
        ctx.ui.notify(
          summarizeErrorText(
            `The summary model failed; showing a concise local fallback.${detail}`,
          ),
          "warning",
        );
      }

      if (!stillCurrent()) return;
      pi.appendEntry(RECAP_ENTRY_TYPE, recap);
    })().finally(() => {
      activeSummaries.delete(controller);
      updateStatus();
    });

    activeSummaries.set(controller, task);
    updateStatus();
    // Keep the next prompt responsive while the inexpensive recap model runs.
    // The recap is a custom entry, so it cannot affect a later agent turn.
    void task;
  };

  pi.on("session_start", (_event, ctx) => {
    // A new/resumed/replaced session invalidates anything still in flight from
    // the previous one before it can append here.
    epoch++;
    cancelActiveSummaries();
    sessionActive = ctx.mode === "tui" && !summariesDisabled();
    statusContext = ctx;
    runBoundary.reset();
    updateStatus();
  });

  pi.on("session_tree", (_event, ctx) => {
    // `/tree` navigation rewrites the active branch; an in-flight recap belongs
    // to the branch it was generated from and must not be appended to the new
    // one.
    epoch++;
    cancelActiveSummaries();
    runBoundary.reset();
    statusContext = ctx;
    updateStatus();
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    runBoundary.begin(ctx.sessionManager.getLeafId());
  });

  pi.on("agent_settled", (_event, ctx) => {
    const run = runBoundary.settle();
    if (!run || ctx.mode !== "tui" || !sessionActive) return;

    const entries = getRunEntries(
      ctx.sessionManager.getBranch(),
      run.baselineLeafId,
    );
    if (entries.length === 0) return;

    // Never recap interrupted/aborted runs: pi still fires `agent_settled`
    // after a user abort (or a teardown abort), marking the run's final
    // assistant message with stopReason "aborted". The check runs synchronously
    // on the settle-time entries and before any generation task is created, so
    // no async recap can ever be delivered for an aborted run.
    if (isRunInterrupted(entries)) return;

    const config = loadConfig();
    // Automatic recaps are opt-in work: `manual`/`off` keep them for `/recap`,
    // and trivial conversational runs below the tool-call threshold are skipped
    // because there is no investigation or edit to summarize.
    if (config.mode !== "auto") return;
    if (!isMeaningfulRun(entries, config.minToolCalls)) return;

    startRecap(ctx, entries, config);
  });

  pi.on("session_shutdown", async () => {
    sessionActive = false;
    epoch++;
    runBoundary.reset();
    const summaries = [...activeSummaries.entries()];
    for (const [controller] of summaries) controller.abort();
    await waitForCancellation(
      summaries.map(([, task]) => task),
      SHUTDOWN_WAIT_MS,
    );
    activeSummaries.clear();
    statusContext?.ui.setStatus(STATUS_KEY, undefined);
    statusContext = undefined;
  });

  pi.registerCommand("summary-model", {
    description: "Choose the model and reasoning level used for run recaps",
    handler: async (_args, ctx) => {
      if (summariesDisabled()) return;
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Summary model selection is only available in the TUI.",
            "error",
          );
        }
        return;
      }

      const current = loadConfig();
      const model = await openModelPicker(ctx, current);
      if (!model) return;

      const reasoning = await openReasoningPicker(
        ctx,
        model,
        current.reasoning,
      );
      if (!reasoning) return;

      const config: SummaryConfig = {
        provider: model.provider,
        model: model.id,
        reasoning,
        // Keep the recap mode and threshold untouched while changing the model.
        mode: current.mode,
        minToolCalls: current.minToolCalls,
      };
      try {
        await saveConfig(config);
      } catch {
        ctx.ui.notify(
          "Could not save the private summary model config.",
          "error",
        );
        return;
      }

      ctx.ui.notify(
        `Summary model: ${config.provider}/${config.model} · ${config.reasoning}`,
        "info",
      );
    },
  });

  pi.registerCommand("summary-mode", {
    description: "Set when automatic run recaps run: auto, manual, or off",
    getArgumentCompletions: async (prefix) =>
      SUMMARY_MODES.filter((mode) => mode.startsWith(prefix)).map((mode) => ({
        value: mode,
        label: mode,
        description:
          mode === "auto"
            ? "Recap every meaningful settled run"
            : mode === "manual"
              ? "Only recap on /recap"
              : "Disable automatic recaps",
      })),
    handler: async (args, ctx) => {
      if (summariesDisabled()) return;
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Summary mode selection is only available in the TUI.",
            "error",
          );
        }
        return;
      }

      const current = loadConfig();
      const requested = args.trim().toLowerCase();
      let mode: SummaryMode;
      if (!requested) {
        // No argument cycles the mode, so the command doubles as a toggle.
        const index = SUMMARY_MODES.indexOf(current.mode);
        mode = SUMMARY_MODES[(index + 1) % SUMMARY_MODES.length];
      } else if (isSummaryMode(requested)) {
        mode = requested;
      } else {
        ctx.ui.notify(
          `Unknown summary mode "${summarizeErrorText(requested)}". Use auto, manual, or off.`,
          "error",
        );
        return;
      }

      try {
        await saveConfig({ ...current, mode });
      } catch {
        ctx.ui.notify("Could not save the private summary config.", "error");
        return;
      }

      const threshold = `${current.minToolCalls} tool call${current.minToolCalls === 1 ? "" : "s"}`;
      ctx.ui.notify(
        mode === "auto"
          ? `Automatic recaps: auto (minimum ${threshold}).`
          : `Automatic recaps: ${mode}. Use /recap for an on-demand recap.`,
        "info",
      );
    },
  });

  pi.registerCommand("recap", {
    description: "Generate a recap of the most recent run on this branch now",
    handler: async (_args, ctx) => {
      if (summariesDisabled()) return;
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "On-demand recaps are only available in the TUI.",
            "error",
          );
        }
        return;
      }

      const entries = getLastRunEntries(ctx.sessionManager.getBranch());
      if (entries.length === 0) {
        ctx.ui.notify("No completed run to recap yet.", "info");
        return;
      }
      if (isRunInterrupted(entries)) {
        ctx.ui.notify(
          "The latest run was interrupted; no recap generated.",
          "info",
        );
        return;
      }

      // On-demand recap ignores the mode and the meaningful-run threshold: the
      // user explicitly asked for this run.
      startRecap(ctx, entries, loadConfig());
    },
  });
}
