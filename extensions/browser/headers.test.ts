/**
 * Unit tests for header capture / rendering policy (src/headers.ts).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  allowListFor,
  boundHeaders,
  filterHeaders,
  KEEP_HEADERS,
  MAX_HEADER_FIELDS,
  MAX_HEADER_VALUE,
} from "./src/headers.ts";

test("boundHeaders caps field count", () => {
  const many: Record<string, string> = {};
  for (let i = 0; i < MAX_HEADER_FIELDS * 2; i++) many[`h${i}`] = "v";
  const out = boundHeaders(many);
  assert.equal(Object.keys(out).length, MAX_HEADER_FIELDS);
});

test("boundHeaders truncates long values", () => {
  const out = boundHeaders({ big: "y".repeat(MAX_HEADER_VALUE * 2) });
  assert.ok(out.big.length <= MAX_HEADER_VALUE);
  assert.ok(out.big.endsWith("\u2026[truncated]"));
});

test("boundHeaders keeps small maps intact and in order", () => {
  const out = boundHeaders({ a: "1", b: "2" });
  assert.deepEqual(out, { a: "1", b: "2" });
});

test("filterHeaders keeps only allowed names, case-insensitively", () => {
  const h = {
    Authorization: "Bearer x",
    "Content-Type": "application/json",
    cookie: "s=1",
  };
  assert.deepEqual(filterHeaders(h, new Set(["authorization"])), {
    Authorization: "Bearer x",
  });
  assert.deepEqual(filterHeaders(h, new Set(["cookie", "authorization"])), {
    Authorization: "Bearer x",
    cookie: "s=1",
  });
});

test("allowListFor merges the curated set with caller extras", () => {
  const allow = allowListFor(["Cookie", "cache-control"]);
  assert.ok(allow.has("authorization")); // curated default
  assert.ok(allow.has("cookie")); // caller extra, lowercased
  assert.ok(allow.has("cache-control"));
  assert.ok(!allow.has("user-agent"));
  assert.deepEqual(allowListFor(undefined), KEEP_HEADERS);
});
