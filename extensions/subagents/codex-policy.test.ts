import assert from "node:assert/strict";
import test from "node:test";
import {
  codexExecutionPolicy,
  codexPolicyCliArgs,
  codexPolicyForTask,
} from "./src/backends/codex-policy.ts";

test("trusted Codex children keep autonomous full access", () => {
  assert.deepEqual(codexExecutionPolicy(true), {
    sandbox: "danger-full-access",
    approvalPolicy: "never",
  });
});

test("untrusted Codex children are autonomous but read-only", () => {
  assert.deepEqual(codexExecutionPolicy(false), {
    sandbox: "read-only",
    approvalPolicy: "never",
  });
});

test("Codex CLI policy flags use the same trust decision", () => {
  const task = (projectTrusted: boolean) => ({
    parent: { parentCwd: "/tmp/project", projectTrusted },
  });
  assert.deepEqual(codexPolicyCliArgs(task(true)), [
    "-s",
    "danger-full-access",
    "-a",
    "never",
  ]);
  assert.deepEqual(codexPolicyCliArgs(task(false)), [
    "-s",
    "read-only",
    "-a",
    "never",
  ]);
});

test("a read-only profile wins over project trust", () => {
  const readOnly = {
    parent: {
      parentCwd: "/tmp/project",
      projectTrusted: true,
      toolPolicy: { readOnly: true },
    },
  };
  assert.deepEqual(codexExecutionPolicy(true, { readOnly: true }), {
    sandbox: "read-only",
    approvalPolicy: "never",
  });
  assert.deepEqual(codexPolicyForTask(readOnly), {
    sandbox: "read-only",
    approvalPolicy: "never",
  });
  assert.deepEqual(codexPolicyCliArgs(readOnly), [
    "-s",
    "read-only",
    "-a",
    "never",
  ]);
});
