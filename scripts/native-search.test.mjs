import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReadOnlyTools } from "@earendil-works/pi-coding-agent";

test("native find/grep/ls use Pi-provisioned search binaries", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-native-search-"));
  try {
    await writeFile(
      join(cwd, "sample.txt"),
      "native search regression needle\n",
    );
    const tools = new Map(
      createReadOnlyTools(cwd).map((tool) => [tool.name, tool]),
    );
    const text = (result) =>
      result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
    assert.match(
      text(
        await tools.get("find").execute("find-fixture", { pattern: "*.txt" }),
      ),
      /sample\.txt/,
    );
    assert.match(
      text(
        await tools.get("grep").execute("grep-fixture", {
          pattern: "regression needle",
          literal: true,
        }),
      ),
      /regression needle/,
    );
    assert.match(
      text(await tools.get("ls").execute("ls-fixture", {})),
      /sample\.txt/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
