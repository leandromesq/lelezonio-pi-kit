/**
 * Entry-point tests for the terminal takeover pane wiring: snapshot mapping
 * and the keep-the-overlay fallback when a pane cannot open.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { TerminalSnapshot } from "./src/domain.ts";
import type { TerminalReadModel } from "./src/manager.ts";
import {
  terminalTarget,
  tryOpenTerminalTakeoverPane,
  openTerminalPicker,
} from "./src/ui/ps.ts";
import {
  setTakeoverHostForTests,
  type OpenTakeoverOptions,
  type TakeoverHost,
} from "../shared/takeover-host.ts";

const NOW = Date.now();

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
    createdAt: NOW - 10_000,
    stdout: { text: "stdout line", totalBytes: 11, truncatedBytes: 0 },
    stderr: { text: "stderr line", totalBytes: 11, truncatedBytes: 0 },
    ...overrides,
  } as TerminalSnapshot;
}

function fakeView(snaps: Record<string, TerminalSnapshot>): TerminalReadModel {
  let killed = 0;
  const view = {
    list: () => Object.values(snaps),
    get: (id: string) => snaps[id],
    size: () => Object.keys(snaps).length,
    subscribe: () => () => {},
    subscribeTo: () => () => {},
    requestKill: (id: string) => {
      killed += 1;
      assert.equal(id, "bt-1");
    },
    setOnSettled: () => {},
    killed: () => killed,
  } as unknown as TerminalReadModel & { killed: () => number };
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

function stubHost(result: string | undefined) {
  let opened: OpenTakeoverOptions | undefined;
  const host = {
    open: async (options: OpenTakeoverOptions) => {
      opened = options;
      return result;
    },
    refresh: () => {},
    dispose: async () => {},
    endpoint: undefined,
  } as unknown as TakeoverHost;
  return { host, opened: () => opened };
}

test.afterEach(() => {
  setTakeoverHostForTests(undefined);
});

test("terminalTarget exposes stdout as main and stderr as secondary", () => {
  const t = terminalTarget(makeTerminal());
  assert.equal(t.kind, "terminal");
  assert.equal(t.id, "bt-1");
  assert.equal(t.status, "running");
  assert.equal(t.since, NOW - 10_000);
  assert.equal(t.text, "stdout line");
  assert.equal(t.secondaryText, "stderr line");

  const settled = terminalTarget(
    makeTerminal({
      status: "done",
      stdout: { text: "bye", totalBytes: 3, truncatedBytes: 0 },
    }),
  );
  assert.equal(settled.status, "done");
});

test("tryOpenTerminalTakeoverPane opens a pane with a kill action only", async () => {
  const { host, opened } = stubHost("w1:p5");
  setTakeoverHostForTests(host);
  const view = fakeView({ "bt-1": makeTerminal() });
  const { ctx, calls } = fakeCtx();
  assert.equal(await tryOpenTerminalTakeoverPane(ctx, view, "bt-1"), true);
  assert.equal(calls.custom, 0);
  assert.equal(
    calls.notify[0][0],
    "Terminal bt-1 taken over in Herdr pane w1:p5",
  );
  const options = opened()!;
  assert.equal(options.cwd, "/tmp/proj");
  assert.equal(options.actions.send, undefined); // read-only except kill
  assert.equal(typeof options.actions.kill, "function");
  options.actions.kill!();
  assert.equal((view as any).killed(), 1);
});

test("tryOpenTerminalTakeoverPane keeps the overlay when no pane opens", async () => {
  const { host } = stubHost(undefined);
  setTakeoverHostForTests(host);
  const view = fakeView({ "bt-1": makeTerminal() });
  const { ctx } = fakeCtx();
  assert.equal(await tryOpenTerminalTakeoverPane(ctx, view, "bt-1"), false);
});

test("tryOpenTerminalTakeoverPane ignores unknown ids", async () => {
  const { host } = stubHost("w1:p5");
  setTakeoverHostForTests(host);
  const { ctx } = fakeCtx();
  assert.equal(
    await tryOpenTerminalTakeoverPane(ctx, fakeView({}), "nope"),
    false,
  );
});

test("openTerminalPicker returns after a successful pane takeover", async () => {
  const { host } = stubHost("w1:p5");
  setTakeoverHostForTests(host);
  const view = fakeView({ "bt-1": makeTerminal() });
  // Dashboard resolves to a picked terminal, then the pane opens: the picker
  // must return without reopening the dashboard in a loop.
  const { ctx, calls } = fakeCtx(["bt-1", null]);
  await openTerminalPicker(ctx, view);
  assert.equal(calls.custom, 1); // dashboard only — no detail, no re-dashboard
});

test("openTerminalPicker keeps the dashboard loop when the pane fails", async () => {
  const { host } = stubHost(undefined);
  setTakeoverHostForTests(host);
  const view = fakeView({ "bt-1": makeTerminal() });
  // Dashboard picks the terminal, detail view opens (failure path); backing
  // out of detail reopens the dashboard, which then closes.
  const { ctx, calls } = fakeCtx(["bt-1", null]);
  await openTerminalPicker(ctx, view);
  assert.equal(calls.custom, 3); // dashboard → detail → dashboard → exit
});
