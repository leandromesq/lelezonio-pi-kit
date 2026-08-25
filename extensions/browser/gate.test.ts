/**
 * Unit tests for the default-off gate (src/gate.ts).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  applyGate,
  BROWSER_TOOL_NAMES,
  computeEnabledFromEntries,
  ENABLED_ENTRY_TYPE,
  parseBrowserCommand,
  type GateEntryLike,
} from "./src/gate.ts";

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
