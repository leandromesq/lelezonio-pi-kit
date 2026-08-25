/**
 * Unit tests for the text renderers (src/format.ts).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { renderConsoleText, renderNetworkText } from "./src/format.ts";
import type { ConsoleEntry, NetEntry } from "./src/types.ts";

test("renderConsoleText renders one ISO-timestamped line per entry", () => {
  const entries: ConsoleEntry[] = [
    { ts: 0, type: "log", text: "hello" },
    { ts: 1000, type: "error", text: "boom", location: "app.js:42" },
  ];
  const out = renderConsoleText(entries);
  const lines = out.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\[1970-01-01T00:00:00\.000Z\] log: hello$/);
  assert.match(lines[1], /error: boom  @ app\.js:42$/);
});

test("renderConsoleText renders the empty buffer as (empty)", () => {
  assert.equal(renderConsoleText([]), "(empty)");
});

test("renderNetworkText is terse by default", () => {
  const entries: NetEntry[] = [
    {
      ts: 0,
      method: "GET",
      url: "https://example.com/app.js",
      status: 200,
      resourceType: "script",
      requestHeaders: { authorization: "Bearer secret" },
      responseHeaders: { "content-type": "application/javascript" },
    },
  ];
  const out = renderNetworkText(entries, {
    showHeaders: false,
    allow: new Set(),
  });
  assert.equal(out, "200 GET https://example.com/app.js");
});

test("renderNetworkText shows failures", () => {
  const entries: NetEntry[] = [
    {
      ts: 0,
      method: "GET",
      url: "https://example.com/api",
      resourceType: "fetch",
      failure: "net::ERR_ABORTED",
    },
  ];
  const out = renderNetworkText(entries, {
    showHeaders: false,
    allow: new Set(),
  });
  assert.equal(out, "ERR GET https://example.com/api  (net::ERR_ABORTED)");
});

test("renderNetworkText inlines only allow-listed headers when verbose", () => {
  const entries: NetEntry[] = [
    {
      ts: 0,
      method: "POST",
      url: "https://example.com/api",
      status: 401,
      resourceType: "fetch",
      requestHeaders: { authorization: "Bearer secret", "user-agent": "x" },
      responseHeaders: { "www-authenticate": "Bearer", server: "envoy" },
    },
  ];
  const out = renderNetworkText(entries, {
    showHeaders: true,
    allow: new Set(["authorization", "www-authenticate"]),
  });
  const lines = out.split("\n");
  assert.equal(lines[0], "401 POST https://example.com/api");
  assert.deepEqual(lines.slice(1), [
    "  \u2192 authorization: Bearer secret",
    "  \u2190 www-authenticate: Bearer",
  ]);
});

test("renderNetworkText renders the empty buffer as (empty)", () => {
  assert.equal(
    renderNetworkText([], { showHeaders: false, allow: new Set() }),
    "(empty)",
  );
});
