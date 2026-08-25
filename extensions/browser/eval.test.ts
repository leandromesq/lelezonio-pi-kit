/**
 * Unit tests for browser_eval source wrapping and result stringification
 * (src/eval.ts). The wrapper is plain JS, so new Function() lets us run the
 * exact string Playwright would evaluate in a page.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_EVAL_TEXT,
  stringifyEvalResult,
  wrapEvalSource,
} from "./src/eval.ts";

function run(src: string): unknown {
  // new Function treats the string as a function *body*; `return` yields the
  // value that Playwright's evaluate(expression) would produce directly.
  return new Function(`return (${wrapEvalSource(src)})`)();
}

test("plain expressions evaluate to their value", () => {
  assert.equal(run("1 + 1"), 2);
  assert.equal(run("'ab' + 'c'"), "abc");
});

test("function sources are called exactly once", () => {
  assert.equal(run("() => 42"), 42);
  assert.equal(run("(a) => a + 1"), NaN); // called with no args
});

test("already-called IIFEs are not re-wrapped", () => {
  assert.equal(run("(() => 42)()"), 42);
  // A function VALUE produced by an IIFE is still invoked exactly once —
  // that is the documented function-calling semantics of the wrapper.
  assert.equal(run("(() => { return () => 7; })()"), 7);
});

test("async function sources resolve", async () => {
  const value = await run("async () => { return 40 + 2; }");
  assert.equal(value, 42);
});

test("a trailing line comment cannot swallow the closing paren", () => {
  // Upstream-style inline wrapping breaks here; the wrapper puts the source
  // on its own line so the // comment ends before ); .
  assert.equal(run("1 + 1 // note"), 2);
});

test("object literals and template literals survive the wrapper", () => {
  assert.deepEqual(run("({ a: 1 })"), { a: 1 });
  assert.equal(run("`x${1 + 1}y`"), "x2y");
});

test("stringifyEvalResult renders undefined explicitly", () => {
  assert.equal(stringifyEvalResult(undefined), "undefined");
});

test("stringifyEvalResult falls back to String for circular values", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.ok(stringifyEvalResult(circular).includes("[object Object]"));
});

test("stringifyEvalResult handles BigInt", () => {
  assert.equal(stringifyEvalResult(10n), "10");
});

test("stringifyEvalResult caps very large output", () => {
  const huge = "a".repeat(MAX_EVAL_TEXT * 2);
  const out = stringifyEvalResult(huge);
  assert.ok(out.length <= MAX_EVAL_TEXT + 20);
  assert.ok(out.endsWith("[truncated]"));
});
