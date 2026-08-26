/**
 * Entry-point tests for the remote-agent takeover pane wiring: snapshot
 * mapping, send/cancel/refresh routing, and the keep-the-overlay fallback.
 * Targets src/ui/pane.ts (leaf module, no TUI classes) so it runs under
 * Node's strip-only TypeScript mode.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteAgentSnapshot } from "./src/domain.ts";
import type { RemoteAgentReadModel } from "./src/manager.ts";
import {
  openRemoteTakeoverPaneOr,
  remoteTarget,
  tryOpenRemoteTakeoverPane,
} from "./src/ui/pane.ts";
import {
  setTakeoverHostForTests,
  type OpenTakeoverOptions,
  type TakeoverHost,
} from "../shared/takeover-host.ts";

const NOW = Date.now();

function makeRemote(
  overrides: Partial<RemoteAgentSnapshot> = {},
): RemoteAgentSnapshot {
  return {
    id: "ra-a31f",
    name: "refactor",
    title: "Refactor module",
    host: "macmini",
    localCwd: "/tmp/local/proj",
    remoteCwd: "/tmp/remote/proj",
    workspaceId: "w9",
    status: "working",
    createdAt: NOW - 60_000,
    updatedAt: NOW - 5_000,
    transcript: "remote transcript line\nmore output",
    transcriptVersion: 7,
    generation: 2,
  } as RemoteAgentSnapshot;
}

function fakeView(snaps: Record<string, RemoteAgentSnapshot>) {
  const calls = { refresh: 0, send: [] as string[], cancel: 0 };
  const view: RemoteAgentReadModel & { calls: typeof calls } = {
    list: () => Object.values(snaps),
    get: (id: string) => snaps[id],
    subscribe: () => () => {},
    subscribeTo: () => () => {},
    requestRefresh: (id: string) => {
      calls.refresh += 1;
      assert.equal(id, "ra-a31f");
    },
    requestSend: (id: string, text: string) => {
      calls.send.push(text);
      assert.equal(id, "ra-a31f");
    },
    requestCancel: (id: string) => {
      calls.cancel += 1;
      assert.equal(id, "ra-a31f");
    },
    requestDelete: () => {},
    calls,
  };
  return { view, calls };
}

function fakeCtx() {
  const calls = { notify: [] as Array<[string, string]> };
  const ui = {
    notify: (message: string, type: string) => {
      calls.notify.push([message, type]);
    },
  };
  return {
    ctx: { mode: "tui", ui } as unknown as Parameters<
      typeof tryOpenRemoteTakeoverPane
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

test("remoteTarget projects the snapshot for the bridge", () => {
  const t = remoteTarget(makeRemote());
  assert.equal(t.kind, "remote");
  assert.equal(t.id, "ra-a31f");
  assert.equal(t.status, "working");
  assert.equal(t.since, NOW - 60_000);
  assert.equal(t.text, "remote transcript line\nmore output");
});

test("tryOpenRemoteTakeoverPane opens a pane with send/cancel/refresh and notifies", async () => {
  const { host, opened } = stubHost("w1:p4");
  setTakeoverHostForTests(host);
  const { view, calls } = fakeView({ "ra-a31f": makeRemote() });
  const { ctx, calls: uiCalls } = fakeCtx();

  assert.equal(await tryOpenRemoteTakeoverPane(ctx, view, "ra-a31f"), true);
  assert.equal(
    uiCalls.notify[0][0],
    "Remote agent ra-a31f taken over in Herdr pane w1:p4",
  );

  const options = opened()!;
  assert.equal(options.cwd, "/tmp/local/proj");
  assert.equal(typeof options.subscribe, "function");
  options.actions.send!("keep going");
  options.actions.cancel!();
  options.actions.refresh!();
  assert.deepEqual(calls.send, ["keep going"]);
  assert.equal(calls.cancel, 1);
  assert.equal(calls.refresh, 1);
});

test("tryOpenRemoteTakeoverPane reports failure so callers keep the overlay", async () => {
  const { host } = stubHost(undefined);
  setTakeoverHostForTests(host);
  const { view } = fakeView({ "ra-a31f": makeRemote() });
  const { ctx } = fakeCtx();
  assert.equal(await tryOpenRemoteTakeoverPane(ctx, view, "ra-a31f"), false);
});

test("openRemoteTakeoverPaneOr refreshes, prefers the pane, and falls back to the overlay", async () => {
  const { host } = stubHost("w1:p4");
  setTakeoverHostForTests(host);
  const { view, calls } = fakeView({ "ra-a31f": makeRemote() });
  let overlays = 0;
  assert.equal(
    await openRemoteTakeoverPaneOr(ctxOf(host), view, "ra-a31f", async () => {
      overlays += 1;
    }),
    true,
  );
  assert.equal(calls.refresh, 1);
  assert.equal(overlays, 0);

  setTakeoverHostForTests(stubHost(undefined).host);
  assert.equal(
    await openRemoteTakeoverPaneOr(ctxOf(host), view, "ra-a31f", async () => {
      overlays += 1;
    }),
    false,
  );
  assert.equal(overlays, 1);
  assert.equal(calls.refresh, 2);
});

test("openRemoteTakeoverPaneOr ignores unknown ids", async () => {
  setTakeoverHostForTests(stubHost("w1:p4").host);
  const { view } = fakeView({});
  let overlays = 0;
  assert.equal(
    await openRemoteTakeoverPaneOr(
      ctxOf(stubHost("w1:p4").host),
      view,
      "ra-gone",
      async () => {
        overlays += 1;
      },
    ),
    false,
  );
  assert.equal(overlays, 0);
});

let sharedCtx: Parameters<typeof tryOpenRemoteTakeoverPane>[0] | undefined;
function ctxOf(_host: TakeoverHost) {
  return (sharedCtx ??= fakeCtx().ctx);
}
