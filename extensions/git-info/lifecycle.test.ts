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
