import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  emptyModelInfoState,
  MODEL_INFO_CHANNEL,
  REFRESH_CHANNEL,
} from "../shared/dashboard-state.ts";

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
      cost: getSessionCost(ctx),
    };
    publish();
  }

  const stopRefreshListener = pi.events.on(REFRESH_CHANNEL, () => {
    if (currentContext) refresh(currentContext);
  });

  pi.on("session_start", (_event, ctx) => {
    state = emptyModelInfoState();
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
