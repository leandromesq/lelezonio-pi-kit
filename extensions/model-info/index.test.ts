import assert from "node:assert/strict";
import test from "node:test";
import modelInfo from "./index.ts";

const CHANNEL = "dashboard:model-info";

function assistantEntry(cost: number) {
  return {
    type: "message",
    message: { role: "assistant", usage: { cost: { total: cost } } },
  };
}

function setup() {
  const handlers = new Map<string, ((event: any, ctx: any) => void)[]>();
  const states: any[] = [];
  let refreshListener: (() => void) | undefined;

  const pi: any = {
    events: {
      emit: (channel: string, payload: unknown) => {
        if (channel === CHANNEL) states.push(payload);
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

  const branch: any[] = [];
  const ctx: any = {
    model: { provider: "p", id: "m", name: "M", reasoning: false },
    getContextUsage: () => ({ tokens: 1, contextWindow: 100, percent: 1 }),
    sessionManager: { getBranch: () => branch },
  };

  modelInfo(pi);
  const fire = (event: string, payload: any = {}) => {
    for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
  };
  return {
    states,
    fire,
    branch,
    refresh: () => refreshListener?.(),
    lastCost: () => states.at(-1)?.cost,
  };
}

test("accumulates assistant cost incrementally instead of rescanning the branch", () => {
  const { states, fire, branch, refresh, lastCost } = setup();

  branch.push(assistantEntry(2), {
    type: "message",
    message: { role: "user" },
  });
  fire("session_start");
  assert.equal(lastCost(), 2);

  const emittedBefore = states.length;
  fire("message_end", {
    message: { role: "assistant", usage: { cost: { total: 3 } } },
  });
  fire("turn_end");
  assert.equal(states.length, emittedBefore + 1);
  assert.equal(lastCost(), 5);

  // A non-assistant message_end must not touch the accumulator.
  fire("message_end", { message: { role: "user" } });
  fire("agent_settled");
  assert.equal(lastCost(), 5);

  // The refresh channel reuses the accumulator.
  refresh();
  assert.equal(lastCost(), 5);
});

test("re-syncs from the branch when tree navigation rewrites it", () => {
  const { fire, branch, lastCost } = setup();

  branch.push(assistantEntry(4));
  fire("session_start");
  assert.equal(lastCost(), 4);

  // Restore/tree navigation: the active branch lost an earlier message.
  branch.length = 0;
  branch.push(assistantEntry(1));
  fire("session_tree");
  assert.equal(lastCost(), 1);

  fire("message_end", {
    message: { role: "assistant", usage: { cost: { total: 2 } } },
  });
  fire("turn_end");
  assert.equal(lastCost(), 3);
});
