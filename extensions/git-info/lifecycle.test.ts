import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import gitInfo from "./index.ts";

function harness() {
  const handlers = new Map<string, (...args: any[]) => any>();
  let unsubscribed = false;
  gitInfo({
    on: (name: string, handler: (...args: any[]) => any) =>
      handlers.set(name, handler),
    events: {
      on: () => () => {
        unsubscribed = true;
      },
      emit() {},
    },
    registerCommand() {},
  } as unknown as ExtensionAPI);
  return { handlers, unsubscribed: () => unsubscribed };
}

test("a subagent child schedules no refresh from mutations or input", async (t) => {
  // A child still polls its own footer, so only the debounced refresh path is
  // forbidden here: any setTimeout would be a per-mutation/per-input refresh.
  const timer = t.mock.method(globalThis, "setTimeout", () => {
    throw new Error("a subagent must not refresh per mutation or input");
  });
  const previous = process.env.PI_SUBAGENT;
  process.env.PI_SUBAGENT = "1";
  try {
    const { handlers, unsubscribed } = harness();
    const ctx = { mode: "tui", cwd: process.cwd() } as ExtensionContext;
    handlers.get("input")!({}, ctx);
    for (const toolName of ["write", "edit", "bash", "custom_mutation"])
      handlers.get("tool_execution_end")!({ toolName }, ctx);
    assert.equal(timer.mock.callCount(), 0);
    await handlers.get("session_shutdown")!({}, ctx);
    assert.equal(unsubscribed(), true);
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT;
    else process.env.PI_SUBAGENT = previous;
  }
});

test("headless lifecycle and tools never schedule display refresh timers", async (t) => {
  const timer = t.mock.method(globalThis, "setTimeout", () => {
    throw new Error("headless Git refresh must not schedule timers");
  });
  const { handlers, unsubscribed } = harness();
  const ctx = { mode: "print", cwd: process.cwd() } as ExtensionContext;
  await handlers.get("session_start")!({}, ctx);
  handlers.get("input")!({}, ctx);
  handlers.get("tool_execution_end")!({ toolName: "write" }, ctx);
  await handlers.get("session_shutdown")!({}, ctx);
  assert.equal(timer.mock.callCount(), 0);
  assert.equal(unsubscribed(), true);
});

test("TUI tool bursts debounce and shutdown clears a pending refresh", async (t) => {
  const callbacks: Array<() => void> = [];
  const timer = t.mock.method(
    globalThis,
    "setTimeout",
    (callback: () => void) => {
      callbacks.push(callback);
      return callbacks.length as unknown as ReturnType<typeof setTimeout>;
    },
  );
  const clear = t.mock.method(globalThis, "clearTimeout", () => {});
  const { handlers } = harness();
  const ctx = { mode: "tui", cwd: process.cwd() } as ExtensionContext;
  // Avoid session_start's polling runtime: exercise only event scheduling.
  handlers.get("tool_execution_end")!({ toolName: "read" }, ctx);
  assert.equal(timer.mock.callCount(), 0);
  handlers.get("tool_execution_end")!({ toolName: "write" }, ctx);
  handlers.get("tool_execution_end")!({ toolName: "edit" }, ctx);
  assert.equal(timer.mock.callCount(), 2);
  assert.equal(clear.mock.callCount(), 1);
  await handlers.get("session_shutdown")!({}, ctx);
  assert.equal(clear.mock.callCount(), 2);
  // A callback already queued at shutdown is also generation-guarded.
  callbacks[1]!();
});
