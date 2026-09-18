import assert from "node:assert/strict";
import test from "node:test";
import { createWidthKeyedLineCache } from "./line-cache.ts";

test("reuses built lines for the same width and rebuilds when width changes", () => {
  const cache = createWidthKeyedLineCache();
  let builds = 0;
  const build = (value: string) => () => {
    builds++;
    return [`${value}@${builds}`];
  };

  const first = cache.get(80, build("a"));
  const sameWidth = cache.get(80, build("ignored"));
  assert.equal(sameWidth, first);
  assert.deepEqual(sameWidth, ["a@1"]);
  assert.equal(builds, 1);

  const resized = cache.get(100, build("b"));
  assert.notEqual(resized, first);
  assert.deepEqual(resized, ["b@2"]);
  assert.equal(builds, 2);

  // Same width as the previous build: reuse again.
  const reused = cache.get(100, build("ignored"));
  assert.equal(reused, resized);
  assert.equal(builds, 2);
});

test("invalidate forces a rebuild even at the same width", () => {
  const cache = createWidthKeyedLineCache();
  let builds = 0;
  const build = () => {
    builds++;
    return [`build ${builds}`];
  };

  cache.get(50, build);
  cache.invalidate();
  const rebuilt = cache.get(50, build);
  assert.deepEqual(rebuilt, ["build 2"]);
  assert.equal(builds, 2);
});
