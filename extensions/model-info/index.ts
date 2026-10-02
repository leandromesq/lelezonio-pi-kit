import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  emptyModelInfoState,
  MODEL_INFO_CHANNEL,
  REFRESH_CHANNEL,
} from "../shared/dashboard-state.ts";

/**
 * Companion channel for the scope of the canonical cost. The cost itself stays
 * on `MODEL_INFO_CHANNEL` (unchanged shape); the subscription marker rides
 * separately so the shared dashboard state contract does not grow.
 */
export const COST_SCOPE_CHANNEL = "dashboard:cost-scope";

/**
 * Where the session's model usage is billed. `subscription` is true only when
 * the public `ModelRegistry` reports that the active model authenticates
 * through OAuth, so it never claims a subscription covers every provider the
 * session touched. `provider` names the inspected active model, empty when
 * unknown.
 */
export interface CostScope {
  readonly subscription: boolean;
  readonly provider: string;
}

export function isCostScope(value: unknown): value is CostScope {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.subscription === "boolean" &&
    typeof record.provider === "string"
  );
}

/**
 * Detect the active model's billing scope. Reads the public registry OAuth
 * marker only; anything unexpected degrades to "not a subscription" rather
 * than guessing. Called at refresh points, never per footer frame.
 */
export function detectCostScope(ctx: ExtensionContext): CostScope {
  const model = ctx.model;
  if (!model) return { subscription: false, provider: "" };
  let subscription = false;
  try {
    subscription = ctx.modelRegistry.isUsingOAuth(model);
  } catch {
    subscription = false;
  }
  return { subscription, provider: model.provider ?? "" };
}

/**
 * Cost of one usage payload. Unknown or non-finite totals count as zero so a
 * malformed entry can never poison the accumulated session total.
 */
function usageCost(usage: { cost?: { total?: number } } | undefined): number {
  const total = usage?.cost?.total;
  return typeof total === "number" && Number.isFinite(total) ? total : 0;
}

/**
 * Canonical session cost: the sum of every model-attributed usage value the
 * session persisted, matching pi's own `getSessionStats()` and footer totals.
 * That includes assistant responses, tool-result usage from nested model calls
 * (already rolled up by pi, so no double counting), cache-warm `usage` entries,
 * and compaction/branch-summary usage. Scans `getEntries()` — ALL persisted
 * entries, including branches that were abandoned and history that was
 * compacted away — because those were actually billed.
 *
 * Full scans happen only at coarse resync points (session start, agent start,
 * branch rewrites); the streaming path adds finalized messages incrementally.
 */
export function computeSessionCost(entries: readonly SessionEntry[]): number {
  let cost = 0;

  for (const entry of entries) {
    switch (entry.type) {
      case "usage":
        cost += usageCost(entry.usage);
        break;
      case "compaction":
      case "branch_summary":
        cost += usageCost(entry.usage);
        break;
      case "message": {
        const message = entry.message;
        if (message.role === "assistant" || message.role === "toolResult") {
          cost += usageCost(message.usage);
        }
        break;
      }
    }
  }

  return cost;
}

export default function modelInfo(pi: ExtensionAPI) {
  let state = emptyModelInfoState();
  let currentContext: ExtensionContext | undefined;
  /**
   * Session cost accumulator. Finalized messages advance it in O(1) as they
   * end, so a long session never re-walks the whole transcript per message.
   * Coarse lifecycle events replace it with the canonical total (see
   * `resyncAndRefresh`), which both folds in usage with no streaming event
   * (cache warming, compaction, branch summaries) and self-heals any drift.
   */
  let sessionCost = 0;

  const publish = () => pi.events.emit(MODEL_INFO_CHANNEL, { ...state });

  const publishScope = (ctx: ExtensionContext) =>
    pi.events.emit(COST_SCOPE_CHANNEL, detectCostScope(ctx));

  function refresh(ctx: ExtensionContext) {
    currentContext = ctx;
    const model = ctx.model;
    const usage = ctx.getContextUsage();

    state = {
      provider: model?.provider ?? "",
      modelId: model?.id ?? "no-model",
      modelName: model?.name ?? model?.id ?? "No model",
      thinking: model?.reasoning ? pi.getThinkingLevel() : "off",
      contextTokens: usage?.tokens ?? null,
      contextWindow: usage?.contextWindow ?? model?.contextWindow ?? 0,
      contextPercent: usage?.percent ?? null,
      cost: sessionCost,
    };
    publish();
    publishScope(ctx);
  }

  /** Replace the accumulator with the canonical total from all entries. */
  const resyncCost = (ctx: ExtensionContext) => {
    sessionCost = computeSessionCost(ctx.sessionManager.getEntries());
  };

  /**
   * Resync points are deliberately coarse: each is O(entries) and happens at
   * most a few times per run, never per streamed message or per footer frame.
   * `agent_start` folds in cost accrued while the session was idle (cache
   * warming writes `usage` entries with no message_end); `agent_settled`
   * folds any non-message usage appended during the run and self-heals drift;
   * `session_compact`/`session_tree` cover compaction/branch-summary usage and
   * branch rewrites; an explicit dashboard refresh recomputes canonical cost.
   */
  const resyncAndRefresh = (ctx: ExtensionContext) => {
    resyncCost(ctx);
    refresh(ctx);
  };

  // An explicit refresh request (e.g. after login or a manual dashboard
  // rebuild) must report canonical cost, not a stale accumulator. This is not
  // a render path: MODEL_INFO_CHANNEL drives renders, and nothing emits
  // REFRESH_CHANNEL per frame.
  const stopRefreshListener = pi.events.on(REFRESH_CHANNEL, () => {
    if (currentContext) resyncAndRefresh(currentContext);
  });

  pi.on("session_start", (_event, ctx) => {
    state = emptyModelInfoState();
    // Startup/new/resume/fork all start here, so the accumulator is seeded
    // from the canonical total exactly once per session.
    resyncAndRefresh(ctx);
  });

  // Fast path: add each finalized message's usage once, as it ends. Assistant
  // responses and tool results (nested model calls) both carry billable cost.
  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role === "assistant" || message.role === "toolResult") {
      sessionCost += usageCost(message.usage);
    }
  });

  pi.on("agent_start", (_event, ctx) => resyncAndRefresh(ctx));

  pi.on("session_compact", (_event, ctx) => resyncAndRefresh(ctx));
  pi.on("session_tree", (_event, ctx) => resyncAndRefresh(ctx));

  pi.on("model_select", (_event, ctx) => refresh(ctx));

  pi.on("thinking_level_select", (event) => {
    state = { ...state, thinking: event.level };
    publish();
  });

  pi.on("turn_end", (_event, ctx) => refresh(ctx));
  // Final boundary of a run: fold any non-message usage appended during it
  // (and any drift from message replacement) before the dashboard goes idle.
  pi.on("agent_settled", (_event, ctx) => resyncAndRefresh(ctx));

  pi.on("session_shutdown", () => {
    stopRefreshListener();
    currentContext = undefined;
  });
}
