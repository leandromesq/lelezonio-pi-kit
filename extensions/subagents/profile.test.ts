import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  buildChildPrompt,
  extraExcludedTools,
  loadProfileSystemPrompt,
  nestingAllowed,
  toolPolicyFor,
} from "./src/profile.ts";

test("toolPolicyFor maps readOnly and explicit tools", () => {
  assert.deepEqual(toolPolicyFor({ readOnly: true }), {
    tools: ["read", "grep", "find", "ls"],
    readOnly: true,
  });
  assert.deepEqual(toolPolicyFor({ tools: ["read", "bash"] }), {
    tools: ["read", "bash"],
  });
  assert.deepEqual(toolPolicyFor({}), {});
});

test("extraExcludedTools flips the allowlist model and filters the write trio", () => {
  // Explicit allowlist: everything built-in not listed is excluded.
  assert.deepEqual(extraExcludedTools({ tools: ["read", "grep"] }), [
    "write",
    "edit",
    "bash",
    "find",
    "ls",
  ]);
  // readOnly without an allowlist: only the writing trio.
  assert.deepEqual(extraExcludedTools({ readOnly: true }), [
    "write",
    "edit",
    "bash",
  ]);
  assert.deepEqual(extraExcludedTools(undefined), []);
});

test("loadProfileSystemPrompt prefers inline text and loads promptFile relative to the agent dir", () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-prompt-"));
  fs.writeFileSync(path.join(agentDir, "reviewer.md"), "review strictly\n");
  assert.equal(
    loadProfileSystemPrompt(agentDir, { systemPrompt: "inline" }),
    "inline",
  );
  assert.equal(
    loadProfileSystemPrompt(agentDir, { promptFile: "reviewer.md" }),
    "review strictly\n",
  );
  assert.equal(loadProfileSystemPrompt(agentDir, {}), undefined);
  assert.throws(
    () => loadProfileSystemPrompt(agentDir, { promptFile: "missing.md" }),
    /Could not load prompt file/,
  );
  fs.rmSync(agentDir, { recursive: true, force: true });
});

test("buildChildPrompt frames summary context and the system prompt above the task", () => {
  const framed = buildChildPrompt({
    prompt: "do the thing",
    systemPrompt: "You are a reviewer.",
    contextMode: "summary",
    parentCwd: "/work",
    parentSessionId: "sess-1",
  });
  // Order: injected system prompt, then parent context frame, then the task.
  assert.ok(framed.startsWith("[system prompt]\nYou are a reviewer."));
  assert.ok(framed.includes("[parent context]"));
  assert.ok(framed.includes("parent session: sess-1 in /work"));
  assert.ok(framed.endsWith("do the thing"));
  assert.ok(
    framed.indexOf("[parent context]") > framed.indexOf("[system prompt]"),
  );

  const standalone = buildChildPrompt({
    prompt: "do it",
    systemPrompt: "Be nice.",
    contextMode: "standalone",
    parentCwd: "/work",
  });
  assert.ok(!standalone.includes("[parent context]"));
  assert.ok(standalone.startsWith("[system prompt]"));
});

test("nestingAllowed enforces allowlist and depth budget", () => {
  const nest = { allow: ["reviewer"], depth: 0, maxDepth: 1 };
  assert.equal(nestingAllowed(nest, "reviewer"), true);
  assert.equal(nestingAllowed(nest, "coder"), false);
  assert.equal(nestingAllowed({ ...nest, depth: 1 }, "reviewer"), false);
});
