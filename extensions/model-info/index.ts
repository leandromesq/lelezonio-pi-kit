import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  emptyModelInfoState,
  MODEL_INFO_CHANNEL,
  REFRESH_CHANNEL,
} from "../shared/dashboard-state.ts";

/**
 * Full branch scan used to seed/resync the accumulator. This is O(branch) and
 * is only called on session start and on events that can rewrite the active
 * branch (compaction, tree navigation/restore) — never on every refresh.
 */
function getSessionCost(ctx: ExtensionContext) {
  let cost = 0;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      cost += entry.message.usage.cost.total;
    }
  }

  return cost;
}

export default function modelInfo(pi: ExtensionAPI) {
  let state = emptyModelInfoState();
  let currentContext: ExtensionContext | undefined;
  /**
   * Incrementally accumulated session cost. Assistant messages are summed once
   * as they end, instead of re-walking the whole branch on agent_start,
   * turn_end, agent_settled, model_select and the refresh channel — which made
   * a long session O(branch^2) overall.
   */
  let sessionCost = 0;

  const publish = () => pi.events.emit(MODEL_INFO_CHANNEL, { ...state });

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
  }

  const resyncCost = (ctx: ExtensionContext) => {
    sessionCost = getSessionCost(ctx);
  };

  const stopRefreshListener = pi.events.on(REFRESH_CHANNEL, () => {
    if (currentContext) refresh(currentContext);
  });

  pi.on("session_start", (_event, ctx) => {
    state = emptyModelInfoState();
    // Startup/new/resume/fork all start here, so the accumulator is seeded
    // from the branch exactly once per session.
    resyncCost(ctx);
    refresh(ctx);
  });

  // Add each assistant message's usage once, as it ends.
  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") {
      sessionCost += event.message.usage.cost.total;
    }
  });

  // Compaction keeps the assistant messages, but tree navigation/restore and
  // compaction can change the active branch; re-sync from it when they do.
  pi.on("session_compact", (_event, ctx) => {
    resyncCost(ctx);
    refresh(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    resyncCost(ctx);
    refresh(ctx);
  });

  pi.on("model_select", (_event, ctx) => refresh(ctx));

  pi.on("thinking_level_select", (event) => {
    state = { ...state, thinking: event.level };
    publish();
  });

  pi.on("agent_start", (_event, ctx) => refresh(ctx));
  pi.on("turn_end", (_event, ctx) => refresh(ctx));
  pi.on("agent_settled", (_event, ctx) => refresh(ctx));

  pi.on("session_shutdown", () => {
    stopRefreshListener();
    currentContext = undefined;
  });
}
