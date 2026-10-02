/**
 * Unit tests for the default-off gate (src/gate.ts).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  applyGate,
  BROWSER_NAMESPACE,
  BROWSER_TOOL_NAMES,
  computeEnabledFromEntries,
  ENABLED_ENTRY_TYPE,
  parseBrowserCommand,
  type GateEntryLike,
} from "./src/gate.ts";
import browserExtension from "./index.ts";

function gateEntry(on: boolean): GateEntryLike {
  return { customType: ENABLED_ENTRY_TYPE, data: { on } };
}

test("a session with no browser entries defaults to off", () => {
  assert.equal(computeEnabledFromEntries([]), false);
  assert.equal(
    computeEnabledFromEntries([
      { customType: "other-ext", data: { anything: 1 } },
    ]),
    false,
  );
});

test("the newest browser-enabled entry wins", () => {
  assert.equal(computeEnabledFromEntries([gateEntry(true)]), true);
  assert.equal(
    computeEnabledFromEntries([gateEntry(true), gateEntry(false)]),
    false,
  );
  assert.equal(
    computeEnabledFromEntries([gateEntry(false), gateEntry(true)]),
    true,
  );
});

test("entries without a boolean on field leave the gate unchanged", () => {
  assert.equal(
    computeEnabledFromEntries([
      gateEntry(true),
      { customType: ENABLED_ENTRY_TYPE, data: {} },
    ]),
    true,
  );
});

test("applyGate strips only this extension's tools when off", () => {
  const active = ["read", "bash", ...BROWSER_TOOL_NAMES, "write"];
  const out = applyGate(active, false);
  assert.deepEqual(out, ["read", "bash", "write"]);
});

test("applyGate adds this extension's tools when on, preserving the rest", () => {
  const active = ["read", "bash"];
  const out = applyGate(active, true);
  assert.deepEqual(out, ["read", "bash", ...BROWSER_TOOL_NAMES]);
});

test("applyGate is idempotent", () => {
  const once = applyGate(["read"], true);
  assert.deepEqual(applyGate(once, true), once);
  const off = applyGate(once, false);
  assert.deepEqual(off, ["read"]);
});

test("parseBrowserCommand understands on/off aliases and status", () => {
  assert.equal(parseBrowserCommand(undefined), "status");
  assert.equal(parseBrowserCommand(""), "status");
  assert.equal(parseBrowserCommand("on"), "on");
  assert.equal(parseBrowserCommand(" enable "), "on");
  assert.equal(parseBrowserCommand("ON"), "on");
  assert.equal(parseBrowserCommand("off"), "off");
  assert.equal(parseBrowserCommand("disable"), "off");
  assert.equal(parseBrowserCommand("close"), "off");
  assert.equal(parseBrowserCommand("kill"), "off");
  assert.equal(parseBrowserCommand("what?"), "status");
});

/* ---- extension wiring (index.ts) -------------------------------------- */

function setupBrowser(activeTools: readonly string[] = ["read", "bash"]) {
  const tools = new Map<string, Record<string, unknown>>();
  const handlers = new Map<string, ((event: unknown, ctx: any) => void)[]>();
  let active = [...activeTools];

  const pi = {
    on: (event: string, handler: (event: unknown, ctx: any) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerTool: (tool: Record<string, unknown>) => {
      tools.set(tool.name as string, tool);
    },
    registerCommand: () => undefined,
    appendEntry: () => undefined,
    getActiveTools: () => [...active],
    setActiveTools: (next: readonly string[]) => {
      active = [...next];
    },
  };

  browserExtension(pi as never);

  let branch: unknown[] = [];
  const ctx = {
    sessionManager: {
      getBranch: () => branch,
      getEntries: () => {
        throw new Error("the gate must read the active branch, not getEntries");
      },
    },
  };
  const fire = (event: string) => {
    for (const handler of handlers.get(event) ?? []) handler({}, ctx);
  };

  return {
    tools,
    fire,
    active: () => active,
    setBranch: (entries: unknown[]) => {
      branch = entries;
    },
    handlers,
  };
}

test("registers every browser tool inactive and gated at registration", () => {
  const { tools } = setupBrowser();

  assert.deepEqual([...tools.keys()].sort(), [...BROWSER_TOOL_NAMES].sort());
  for (const name of BROWSER_TOOL_NAMES) {
    const tool = tools.get(name)!;
    assert.equal(tool.defaultActive, false, `${name} must not self-activate`);
    // `direct` (not codemode/deferred): those stay callable via tool_search even
    // when inactive, which would bypass the off gate.
    assert.equal(tool.exposure, "direct", `${name} exposure`);
    assert.deepEqual(tool.namespace, BROWSER_NAMESPACE);
  }
});

test("no browser entry on the branch keeps the gate off and strips strays", () => {
  const { fire, active, setBranch } = setupBrowser([
    "read",
    ...BROWSER_TOOL_NAMES,
  ]);

  setBranch([]);
  fire("session_start");

  assert.deepEqual(active(), ["read"]);
});

test("session_start restores the enable bit from the active branch", () => {
  const { fire, active, setBranch } = setupBrowser(["read"]);

  setBranch([gateEntry(true)]);
  fire("session_start");

  assert.deepEqual(active(), ["read", ...BROWSER_TOOL_NAMES]);
});

test("the newest branch entry wins", () => {
  const { fire, active, setBranch } = setupBrowser(["read"]);

  setBranch([gateEntry(true), gateEntry(false)]);
  fire("session_start");
  assert.deepEqual(active(), ["read"]);

  setBranch([gateEntry(false), gateEntry(true)]);
  fire("session_start");
  assert.deepEqual(active(), ["read", ...BROWSER_TOOL_NAMES]);
});

test("session_tree re-evaluates the gate for the newly active branch", () => {
  const { fire, active, setBranch, handlers } = setupBrowser(["read"]);
  assert.ok(handlers.has("session_tree"), "session_tree handler registered");

  setBranch([]);
  fire("session_start");
  assert.deepEqual(active(), ["read"]);

  setBranch([gateEntry(true)]);
  fire("session_tree");
  assert.deepEqual(active(), ["read", ...BROWSER_TOOL_NAMES]);

  setBranch([]);
  fire("session_tree");
  assert.deepEqual(active(), ["read"]);
});
