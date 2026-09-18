import assert from "node:assert/strict";
import test from "node:test";
import {
  reconcileDashboardSelection,
  type DashboardSelection,
} from "./src/ui/ps.ts";
import {
  buildOutputLines,
  createOutputLineCache,
  sanitizeText,
} from "./src/ui/output-view.ts";
import { OutputBuffer } from "./src/output.ts";

test("dashboard selection follows its terminal id and falls back by row", () => {
  const selection: DashboardSelection = { id: "bt-7", index: 6 };

  reconcileDashboardSelection(selection, [
    { id: "bt-new" },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `bt-${index + 1}` })),
  ]);
  assert.deepEqual(selection, { id: "bt-7", index: 7 });

  reconcileDashboardSelection(selection, [
    ...Array.from({ length: 6 }, (_, index) => ({ id: `bt-${index + 1}` })),
    { id: "bt-8" },
    { id: "bt-9" },
  ]);
  assert.deepEqual(selection, { id: "bt-9", index: 7 });

  reconcileDashboardSelection(selection, [{ id: "bt-1" }, { id: "bt-2" }]);
  assert.deepEqual(selection, { id: "bt-2", index: 1 });

  reconcileDashboardSelection(selection, []);
  assert.deepEqual(selection, { id: undefined, index: 0 });
});

test("sanitizeText strips ANSI, tabs, and control characters", () => {
  assert.equal(sanitizeText("\u001b[31mred\u001b[0m"), "red");
  assert.equal(sanitizeText("\u001b[12345Cshifted"), "shifted");
  assert.equal(sanitizeText("\u001b]0;window title\u0007output"), "output");
  assert.equal(
    sanitizeText("\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\"),
    "link",
  );
  assert.equal(sanitizeText("\u001b]0;title\u009coutput"), "output");
  assert.equal(sanitizeText("\u009d0;title\u0007output"), "output");
  assert.equal(sanitizeText("a\u0085b"), "ab");
  assert.equal(sanitizeText("a\tb"), "a  b");
  assert.equal(sanitizeText("a\u0007b\u0000c"), "abc");
});

test("output line cache reuses a version/width key and invalidates either dimension", () => {
  const cache = createOutputLineCache();
  const first = cache.get("first", 1, 80);
  const sameKey = cache.get("different text is intentionally ignored", 1, 80);
  assert.equal(sameKey, first);
  assert.deepEqual(sameKey, ["first"]);

  const newVersion = cache.get("second", 2, 80);
  assert.notEqual(newVersion, first);
  assert.deepEqual(newVersion, ["second"]);

  const newWidth = cache.get("x".repeat(25), 2, 10);
  assert.notEqual(newWidth, newVersion);
  assert.ok(newWidth.length > 1);
});

test("buildOutputLines wraps long lines and keeps only the final CR segment", () => {
  const lines = buildOutputLines("progress 1\rprogress 2\rdone\nnext", 80);
  assert.deepEqual(lines, ["done", "next"]);
  assert.deepEqual(buildOutputLines("progress 1\rprogress 2\r", 80), [
    "progress 2",
  ]);

  const wrapped = buildOutputLines("x".repeat(25), 10);
  assert.ok(wrapped.length > 1);
  assert.equal(wrapped.join(""), "x".repeat(25));
});

test("buildOutputLines drops one trailing empty line from a trailing newline", () => {
  assert.deepEqual(buildOutputLines("a\nb\n", 80), ["a", "b"]);
  assert.deepEqual(buildOutputLines("a\n\n", 80), ["a", ""]);
});

test("incremental line cache only wraps the suffix of a small chunk", () => {
  const cache = createOutputLineCache();
  const big =
    Array.from({ length: 2000 }, (_, index) => `line ${index}`).join("\n") +
    "\n";
  const first = cache.get(big, 1, 80, 0);
  assert.deepEqual(first, buildOutputLines(big, 80));

  const before = cache.stats.segments;
  const grown = big + "one more line\n";
  const second = cache.get(grown, 2, 80, 0);
  assert.deepEqual(second, buildOutputLines(grown, 80));
  // A 2k-line buffer must not be re-wrapped; only the new segment (committed
  // plus the re-wrapped live tail) is processed.
  assert.ok(
    cache.stats.segments - before <= 3,
    `wrapped ${cache.stats.segments - before} segments for one appended chunk`,
  );
});

test("incremental line cache prunes whole segments evicted from the head", () => {
  const cache = createOutputLineCache();
  const first = "alpha\nbeta\ngamma\ndelta\n";
  assert.deepEqual(cache.get(first, 1, 80, 0), [
    "alpha",
    "beta",
    "gamma",
    "delta",
  ]);

  const removed = "alpha\nbeta\n";
  const second = first.slice(removed.length);
  assert.deepEqual(cache.get(second, 2, 80, removed.length), [
    "gamma",
    "delta",
  ]);
});

test("incremental line cache re-wraps the one segment a head cut straddles", () => {
  const cache = createOutputLineCache();
  const first = "hello world\nbye\n";
  assert.deepEqual(cache.get(first, 1, 80, 0), ["hello world", "bye"]);

  const removed = "hello ".length; // cuts inside the first line
  const second = first.slice(removed);
  assert.deepEqual(cache.get(second, 2, 80, removed), ["world", "bye"]);
});

test("incremental line cache tracks a real buffer through pushes and eviction", () => {
  const buf = new OutputBuffer(96);
  const cache = createOutputLineCache();
  let version = 0;
  const render = () => {
    version++;
    const view = buf.view();
    const lines = cache.get(view.text, version, 40, view.truncatedChars);
    assert.deepEqual(
      lines,
      buildOutputLines(view.text, 40),
      `mismatch after ${version} pushes`,
    );
    return lines;
  };

  const chunks = [
    "one\n",
    "two is a longer line that wraps around the narrow viewport\n",
    "three\rprogress\rfour\n",
    "ééé multibyte \n",
    "five\n",
    "six\n",
    "seven\n",
    "eight\n",
    "nine\n",
    "ten\n",
  ];
  for (const chunk of chunks) {
    buf.push(chunk);
    render();
  }
  assert.ok(buf.view().truncatedBytes > 0, "the buffer evicted its head");
});
