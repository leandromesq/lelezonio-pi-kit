import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildWorkflowPrompt,
  extractBaseBranch,
  normalizeBranchArg,
} from "./index.ts";

describe("PR target parsing", () => {
  it("accepts the supported gh base forms", () => {
    assert.equal(
      extractBaseBranch("gh pr create --base main --head feature"),
      "main",
    );
    assert.equal(
      extractBaseBranch('gh.exe pr create -B "release/v2"'),
      "release/v2",
    );
    assert.equal(extractBaseBranch("gh pr create --base=develop"), "develop");
  });

  it("does not infer a missing base branch", () => {
    assert.equal(extractBaseBranch("gh pr create --fill"), undefined);
    assert.equal(extractBaseBranch("git push origin feature"), undefined);
  });

  it("requires exactly one target branch", () => {
    assert.deepEqual(normalizeBranchArg(" main "), {
      ok: true,
      branch: "main",
    });
    assert.equal(normalizeBranchArg("").ok, false);
    assert.equal(normalizeBranchArg("main develop").ok, false);
  });
});

describe("PR workflow prompt", () => {
  it("requires approval and pins gh pr create to the requested base", () => {
    const prompt = buildWorkflowPrompt({
      targetBranch: "develop",
      currentBranch: "feature/example",
      isDirty: true,
      snapshots: [
        {
          command: "git status --short --branch",
          stdout: "## feature/example",
          stderr: "",
          code: 0,
        },
      ],
    });

    assert.match(
      prompt,
      /Every `gh pr create` command MUST include `--base develop`/,
    );
    assert.match(prompt, /Do not push or create a PR until I approve/);
    assert.match(prompt, /wait for my approval before touching anything/);
  });
});
