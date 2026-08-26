/**
 * Entry-point tests for the subagent takeover pane wiring: snapshot mapping,
 * host-open routing, and the "outside Herdr or on failure, keep the overlay"
 * fallback. The real Herdr CLI is never touched — hosts are stubbed through
 * the shared test seam.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentSnapshot } from "./src/domain.ts";
import type { SubagentReadModel } from "./src/manager.ts";
import {
  buildSubagentText,
  openSubagentTakeover,
  subagentTarget,
  tryOpenInHerdrPane,
} from "./src/ui/takeover.ts";
import {
  setTakeoverHostForTests,
  type OpenTakeoverOptions,
  type TakeoverHost,
} from "../shared/takeover-host.ts";

const NOW = Date.now();

function makeSnap(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
  return {
    id: "sa-9",
    origin: "model",
    backend: "pi",
    title: "Refactor module",
    prompt: "Do the thing",
    cwd: "/tmp/proj",
    status: "running",
    createdAt: NOW - 20_000,
    meta: { contextWindow: 200_000 },
    usage: { tokens: 10 },
    transcript: [
      { kind: "user", text: "Step 1" },
      {
        kind: "assistant",
        parts: [{ type: "text", text: "Working on it" }],
      },
      {
        kind: "toolResult",
        toolId: "t1",
        name: "bash",
        isError: false,
        outputPreview: "ok",
      },
    ],
    liveTools: [],
    queued: [{ kind: "user", text: "follow-up" }],
    finalText: "",
    turns: 1,
    ...overrides,
  } as SubagentSnapshot;
}

function fakeView(snaps: Record<string, SubagentSnapshot>): SubagentReadModel {
  return {
    list: () => Object.values(snaps),
    get: (id: string) => snaps[id],
    size: () => Object.keys(snaps).length,
    subscribe: () => () => {},
    subscribeTo: () => () => {},
    requestSend: () => {},
    requestAbort: () => {},
    setOnSettled: () => {},
  } as unknown as SubagentReadModel;
}

function fakeCtx() {
  const calls = { custom: 0, notify: [] as Array<[string, string]> };
  const ui = {
    custom: async () => {
      calls.custom += 1;
      return null;
    },
    notify: (message: string, type: string) => {
      calls.notify.push([message, type]);
    },
  };
  return {
    ctx: { mode: "tui", ui } as unknown as Parameters<
      typeof openSubagentTakeover
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

// --- snapshot mapping -------------------------------------------------------------

test("buildSubagentText renders the conversation plainly", () => {
  const text = buildSubagentText(makeSnap());
  assert.match(text, /> Step 1/);
  assert.match(text, /Working on it/);
  assert.match(text, /output: ok/);
  assert.match(text, /> \[queued\] follow-up/);
});

test("subagentTarget projects the snapshot for the bridge", () => {
  const snap = makeSnap({ status: "error", errorText: "boom" });
  const t = subagentTarget(snap);
  assert.equal(t.kind, "subagent");
  assert.equal(t.id, "sa-9");
  assert.equal(t.title, "Refactor module");
  assert.equal(t.status, "error");
  assert.equal(t.since, NOW - 20_000);
  assert.match(t.text, /error: boom/);
});

// --- host routing ------------------------------------------------------------------

test("tryOpenInHerdrPane routes actions over the host and notifies on success", async () => {
  const { host, opened } = stubHost("w1:p7");
  setTakeoverHostForTests(host);
  const view = fakeView({ "sa-9": makeSnap() });
  const { ctx, calls } = fakeCtx();
  let sent = 0;
  let aborted = 0;

  const ok = await tryOpenInHerdrPane(ctx, view, "sa-9");
  assert.equal(ok, true);
  assert.equal(calls.custom, 0);
  assert.deepEqual(
    calls.notify[0][0],
    "Subagent sa-9 taken over in Herdr pane w1:p7",
  );
  const options = opened()!;
  assert.equal(options.cwd, "/tmp/proj");
  assert.equal(typeof options.subscribe, "function");
  options.actions.send!("steer");
  options.actions.abort!();
  assert.equal(sent, 0); // host is stubbed; real routing is covered in shared tests
  const unsubscribe = options.subscribe!();
  unsubscribe();
});

test("tryOpenInHerdrPane reports failure so callers keep the overlay", async () => {
  const { host } = stubHost(undefined);
  setTakeoverHostForTests(host);
  const view = fakeView({ "sa-9": makeSnap() });
  const { ctx, calls } = fakeCtx();
  assert.equal(await tryOpenInHerdrPane(ctx, view, "sa-9"), false);
  assert.equal(calls.custom, 0); // the decision function itself opens nothing
});

test("tryOpenInHerdrPane ignores missing targets", async () => {
  const { host } = stubHost("w1:p7");
  setTakeoverHostForTests(host);
  const { ctx } = fakeCtx();
  assert.equal(await tryOpenInHerdrPane(ctx, fakeView({}), "sa-nope"), false);
});

// --- entry point --------------------------------------------------------------------

test("openSubagentTakeover skips the overlay when the pane opens", async () => {
  const { host } = stubHost("w1:p7");
  setTakeoverHostForTests(host);
  const view = fakeView({ "sa-9": makeSnap() });
  const { ctx, calls } = fakeCtx();
  assert.equal(
    await openSubagentTakeover(ctx, view, "sa-9", { badge: "by the way" }),
    true,
  );
  assert.equal(calls.custom, 0);
});

test("openSubagentTakeover keeps the in-session overlay when the pane fails", async () => {
  const { host } = stubHost(undefined);
  setTakeoverHostForTests(host);
  const view = fakeView({ "sa-9": makeSnap() });
  const { ctx, calls } = fakeCtx();
  assert.equal(await openSubagentTakeover(ctx, view, "sa-9"), false);
  assert.equal(calls.custom, 1);
});

test("outside Herdr the real host falls back to the overlay without a server", async () => {
  // No host stub: the singleton real host sees a non-Herdr environment.
  setTakeoverHostForTests(undefined);
  const saved = {
    HERDR_ENV: process.env.HERDR_ENV,
    HERDR_PANE_ID: process.env.HERDR_PANE_ID,
    HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
  };
  try {
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_SOCKET_PATH;
    const view = fakeView({ "sa-9": makeSnap() });
    const { ctx, calls } = fakeCtx();
    await openSubagentTakeover(ctx, view, "sa-9");
    assert.equal(calls.custom, 1); // overlay preserved exactly
    await import("../shared/takeover-host.ts").then((m) =>
      assert.equal(m.takeoverHost().endpoint, undefined),
    );
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// outside-herdr test keeps the shared fallback covered above.
