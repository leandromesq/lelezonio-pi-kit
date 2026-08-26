/**
 * Entry-point tests for the terminal observer pane wiring: /ps routes a
 * selected terminal to its Herdr observer pane (take over + focus), and the
 * in-session overlay is kept when no live observer exists.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { TerminalSnapshot } from "./src/domain.ts";
import type { TerminalReadModel } from "./src/manager.ts";
import { openTerminalPicker, tryOpenTerminalObserver } from "./src/ui/ps.ts";
import type { TerminalObserverCoordinator } from "./src/observer.ts";

function makeTerminal(
  overrides: Partial<TerminalSnapshot> = {},
): TerminalSnapshot {
  return {
    id: "bt-1",
    command: "npm run dev",
    title: "dev server",
    cwd: "/tmp/proj",
    pid: 1234,
    status: "running",
    createdAt: Date.now() - 10_000,
    stdout: { text: "stdout line", totalBytes: 11, truncatedBytes: 0 },
    stderr: { text: "stderr line", totalBytes: 11, truncatedBytes: 0 },
    ...overrides,
  } as TerminalSnapshot;
}

function fakeView(snaps: Record<string, TerminalSnapshot>): TerminalReadModel {
  const view = {
    list: () => Object.values(snaps),
    get: (id: string) => snaps[id],
    size: () => Object.keys(snaps).length,
    subscribe: () => () => {},
    subscribeTo: () => () => {},
    requestKill: () => {},
    setOnSettled: () => {},
  } as unknown as TerminalReadModel;
  return view;
}

function fakeCtx(results: Array<string | null> = [null]) {
  const calls = { custom: 0, notify: [] as Array<[string, string]> };
  const ui = {
    custom: async () => {
      const result = results[Math.min(calls.custom, results.length - 1)];
      calls.custom += 1;
      return result;
    },
    notify: (message: string, type: string) => {
      calls.notify.push([message, type]);
    },
  };
  return {
    ctx: { mode: "tui", ui } as unknown as Parameters<
      typeof openTerminalPicker
    >[0],
    calls,
  };
}

function stubCoordinator(takeOverResult: boolean) {
  const takenOver: string[] = [];
  const coordinator = {
    attach: async () => {},
    takeOver: async (id: string) => {
      takenOver.push(id);
      return takeOverResult;
    },
    settle: async () => {},
    dispose: async () => {},
  } as TerminalObserverCoordinator;
  return { coordinator, takenOver: () => takenOver };
}

test("tryOpenTerminalObserver reports false without a coordinator", async () => {
  const { ctx } = fakeCtx();
  assert.equal(await tryOpenTerminalObserver(ctx, undefined, "bt-1"), false);
});

test("tryOpenTerminalObserver takes over a live observer and notifies", async () => {
  const { coordinator, takenOver } = stubCoordinator(true);
  const { ctx, calls } = fakeCtx();
  assert.equal(await tryOpenTerminalObserver(ctx, coordinator, "bt-1"), true);
  assert.deepEqual(takenOver(), ["bt-1"]);
  assert.deepEqual(calls.notify, [
    ["Terminal bt-1 opened in the Pi Workers workspace", "info"],
  ]);
});

test("tryOpenTerminalObserver keeps the overlay when no observer exists", async () => {
  const { coordinator, takenOver } = stubCoordinator(false);
  const { ctx, calls } = fakeCtx();
  assert.equal(await tryOpenTerminalObserver(ctx, coordinator, "bt-1"), false);
  assert.deepEqual(takenOver(), ["bt-1"]);
  assert.equal(calls.notify.length, 0);
});

test("openTerminalPicker returns after a successful observer take-over", async () => {
  const { coordinator } = stubCoordinator(true);
  const view = fakeView({ "bt-1": makeTerminal() });
  // Dashboard resolves to a picked terminal, then the observer takes over:
  // the picker must return without reopening the dashboard in a loop.
  const { ctx, calls } = fakeCtx(["bt-1", null]);
  await openTerminalPicker(ctx, view, coordinator);
  assert.equal(calls.custom, 1); // dashboard only — no detail, no re-dashboard
});

test("openTerminalPicker keeps the dashboard loop when the observer is gone", async () => {
  const { coordinator } = stubCoordinator(false);
  const view = fakeView({ "bt-1": makeTerminal() });
  // Dashboard picks the terminal, detail view opens (fallback path); backing
  // out of detail reopens the dashboard, which then closes.
  const { ctx, calls } = fakeCtx(["bt-1", null]);
  await openTerminalPicker(ctx, view, coordinator);
  assert.equal(calls.custom, 3); // dashboard → detail → dashboard → exit
});

test("openTerminalPicker ignores a terminal that vanished mid-pick", async () => {
  const { coordinator } = stubCoordinator(false);
  const view = fakeView({ "bt-0": makeTerminal({ id: "bt-0" }) });
  const { ctx, calls } = fakeCtx(["bt-1", null]);
  await openTerminalPicker(ctx, view, coordinator);
  // Dashboard picks "bt-1" (already gone) → loop → dashboard → exit.
  assert.equal(calls.custom, 2);
});
