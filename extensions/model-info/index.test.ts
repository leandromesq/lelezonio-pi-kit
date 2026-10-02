import assert from "node:assert/strict";
import test from "node:test";
import modelInfo, { computeSessionCost, detectCostScope } from "./index.ts";

const CHANNEL = "dashboard:model-info";
const SCOPE_CHANNEL = "dashboard:cost-scope";

function assistantEntry(cost: number) {
  return {
    type: "message",
    message: { role: "assistant", usage: { cost: { total: cost } } },
  };
}

function toolResultEntry(cost: number) {
  return {
    type: "message",
    message: { role: "toolResult", usage: { cost: { total: cost } } },
  };
}

function usageEntry(kind: string, cost: number) {
  return { type: "usage", kind, usage: { cost: { total: cost } } };
}

function compactionEntry(cost: number) {
  return { type: "compaction", usage: { cost: { total: cost } } };
}

function branchSummaryEntry(cost: number) {
  return { type: "branch_summary", usage: { cost: { total: cost } } };
}

function setup() {
  const handlers = new Map<string, ((event: any, ctx: any) => void)[]>();
  const states: any[] = [];
  const scopes: any[] = [];
  let refreshListener: (() => void) | undefined;

  const pi: any = {
    events: {
      emit: (channel: string, payload: unknown) => {
        if (channel === CHANNEL) states.push(payload);
        if (channel === SCOPE_CHANNEL) scopes.push(payload);
      },
      on: (channel: string, handler: () => void) => {
        if (channel === "dashboard:refresh") refreshListener = handler;
        return () => {};
      },
    },
    on: (event: string, handler: (event: any, ctx: any) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    getThinkingLevel: () => "off",
  };

  const entries: any[] = [];
  const ctx: any = {
    model: { provider: "p", id: "m", name: "M", reasoning: false },
    getContextUsage: () => ({ tokens: 1, contextWindow: 100, percent: 1 }),
    modelRegistry: { isUsingOAuth: () => false },
    sessionManager: { getEntries: () => entries },
  };

  modelInfo(pi);
  const fire = (event: string, payload: any = {}) => {
    for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
  };
  return {
    states,
    scopes,
    fire,
    entries,
    ctx,
    refresh: () => refreshListener?.(),
    lastCost: () => states.at(-1)?.cost,
  };
}

test("computeSessionCost mirrors pi's canonical billed total", () => {
  assert.equal(
    computeSessionCost([
      assistantEntry(2) as any,
      toolResultEntry(3) as any,
      usageEntry("cache_warm", 1) as any,
      compactionEntry(0.5) as any,
      branchSummaryEntry(0.25) as any,
      { type: "message", message: { role: "user" } } as any,
      { type: "custom", customType: "x" } as any,
    ]),
    6.75,
  );
});

test("computeSessionCost ignores missing or non-finite totals", () => {
  assert.equal(
    computeSessionCost([
      { type: "message", message: { role: "assistant", usage: {} } } as any,
      {
        type: "usage",
        usage: { cost: { total: Number.NaN } },
      } as any,
      assistantEntry(1) as any,
    ]),
    1,
  );
});

test("detectCostScope marks only registry OAuth as a subscription", () => {
  const apiCtx = {
    model: { provider: "anthropic", id: "m" },
    modelRegistry: { isUsingOAuth: () => false },
  } as any;
  const oauthCtx = {
    model: { provider: "openai", id: "m" },
    modelRegistry: { isUsingOAuth: () => true },
  } as any;
  const noModel = {
    model: undefined,
    modelRegistry: { isUsingOAuth: () => true },
  } as any;
  const throwing = {
    model: { provider: "openai", id: "m" },
    modelRegistry: {
      isUsingOAuth: () => {
        throw new Error("registry unavailable");
      },
    },
  } as any;

  assert.deepEqual(detectCostScope(apiCtx), {
    subscription: false,
    provider: "anthropic",
  });
  assert.deepEqual(detectCostScope(oauthCtx), {
    subscription: true,
    provider: "openai",
  });
  assert.deepEqual(detectCostScope(noModel), {
    subscription: false,
    provider: "",
  });
  assert.deepEqual(detectCostScope(throwing), {
    subscription: false,
    provider: "openai",
  });
});

test("refresh publishes the cost scope alongside the canonical cost", () => {
  const { fire, scopes, ctx } = setup();
  ctx.modelRegistry.isUsingOAuth = () => true;
  fire("session_start");
  assert.equal(scopes.at(-1)?.subscription, true);
  assert.equal(scopes.at(-1)?.provider, "p");
});

test("session_start seeds from the canonical total across all entries", () => {
  const { fire, entries, lastCost } = setup();

  entries.push(
    assistantEntry(2),
    toolResultEntry(3),
    usageEntry("cache_warm", 1),
    compactionEntry(0.5),
    branchSummaryEntry(0.25),
    { type: "message", message: { role: "user" } },
  );
  fire("session_start");

  assert.equal(lastCost(), 6.75);
});

test("message_end advances assistant and tool-result cost without rescanning", () => {
  const { states, fire, entries, lastCost } = setup();
  fire("session_start");
  assert.equal(lastCost(), 0);

  const emittedBefore = states.length;
  entries.push(assistantEntry(3));
  fire("message_end", {
    message: {
      role: "assistant",
      usage: { cost: { total: 3 } },
    },
  });
  entries.push(toolResultEntry(2));
  fire("message_end", {
    message: { role: "toolResult", usage: { cost: { total: 2 } } },
  });
  fire("turn_end");

  assert.equal(lastCost(), 5);
  assert.equal(states.length, emittedBefore + 1, "one refresh per turn_end");

  // A non-usage role must not touch the accumulator, and a repeated settle
  // resync is idempotent (entries already match the accumulator).
  fire("message_end", { message: { role: "user" } });
  fire("agent_settled");
  assert.equal(lastCost(), 5);
  fire("agent_settled");
  assert.equal(lastCost(), 5);
});

test("agent_settled folds non-message usage appended during the run", () => {
  const { fire, entries, lastCost } = setup();

  entries.push(assistantEntry(1));
  fire("session_start");

  entries.push(assistantEntry(2));
  fire("message_end", {
    message: { role: "assistant", usage: { cost: { total: 2 } } },
  });
  // An extension-appended usage entry during the run has no message_end.
  entries.push(usageEntry("tool_nested", 3));

  fire("agent_settled");
  assert.equal(lastCost(), 6);
});

test("an explicit refresh recomputes canonical cost", () => {
  const { fire, entries, refresh, lastCost } = setup();

  entries.push(assistantEntry(1));
  fire("session_start");
  assert.equal(lastCost(), 1);

  // Idle cache warming appends usage with no streaming event.
  entries.push(usageEntry("cache_warm", 4));
  refresh();
  assert.equal(lastCost(), 5);
});

test("agent_start resyncs so idle cache-warm usage is included", () => {
  const { fire, entries, lastCost } = setup();

  entries.push(assistantEntry(1));
  fire("session_start");
  assert.equal(lastCost(), 1);

  // Cache warming appends a usage entry while the session is idle; there is no
  // message_end for it, so only the next resync can fold it in.
  entries.push(usageEntry("cache_warm", 4));
  fire("agent_start");
  assert.equal(lastCost(), 5);
});

test("branch rewrites re-sync instead of accumulating drift", () => {
  const { fire, entries, lastCost } = setup();

  entries.push(assistantEntry(4));
  fire("session_start");
  assert.equal(lastCost(), 4);

  // A finalized assistant message is persisted and added incrementally;
  // turn_end republishes the accumulator.
  entries.push(assistantEntry(2));
  fire("message_end", {
    message: { role: "assistant", usage: { cost: { total: 2 } } },
  });
  fire("turn_end");
  assert.equal(lastCost(), 6);

  // Tree navigation persists a branch summary; the rescan replaces, not adds.
  entries.push(branchSummaryEntry(1));
  fire("session_tree");
  assert.equal(lastCost(), 7);

  // Compaction usage is likewise picked up by the rescan.
  entries.push(compactionEntry(0.5));
  fire("session_compact");
  assert.equal(lastCost(), 7.5);
});
