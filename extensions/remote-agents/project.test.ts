import assert from "node:assert/strict";
import test from "node:test";
import { remoteProjectLocation } from "./src/project.ts";

test("remote project location preserves the working subdirectory", () => {
  assert.deepEqual(
    remoteProjectLocation("/Users/remote/Projects", {
      name: "example",
      root: "C:\\code\\example",
      relativeCwd: ["packages", "web"].join(
        process.platform === "win32" ? "\\" : "/",
      ),
      origin: "git@github.com:owner/example.git",
    }),
    {
      root: "/Users/remote/Projects/example",
      cwd: "/Users/remote/Projects/example/packages/web",
    },
  );
});
