import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  buildChildPrompt,
  CHILD_ASK_TOOL,
  CHILD_ORCHESTRATION_TOOLS,
  childToolLoadout,
  type ChildToolLoadout,
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

test("childToolLoadout gives narrowed profiles a real allowlist", () => {
  const readOnly = childToolLoadout(toolPolicyFor({ readOnly: true }));
  assert.deepEqual(readOnly.tools, [
    "read",
    "grep",
    "find",
    "ls",
    "ask_question",
  ]);
  assert.deepEqual(readOnly.exclude, []);
  // Everything not named is denied: a new/unknown built-in cannot leak in,
  // and neither can extension-backed execution/remote tools.
  for (const blocked of [
    "powershell",
    "bash",
    "write",
    "edit",
    "bg_start",
    "bg_kill",
    "remote_spawn",
    "subagent_spawn",
  ]) {
    assert.equal(readOnly.tools?.includes(blocked), false, `${blocked} denied`);
  }

  // Custom tools profiles get the same treatment and keep ask_question.
  const custom = childToolLoadout({ tools: ["read", "grep", "git_status"] });
  assert.deepEqual(custom.tools, [
    "read",
    "grep",
    "git_status",
    CHILD_ASK_TOOL,
  ]);
  assert.deepEqual(custom.exclude, []);

  // A genuinely nesting-capable child keeps its spawn bridge.
  const nested = childToolLoadout(toolPolicyFor({ readOnly: true }), {
    nestedSpawn: true,
  });
  assert.ok(nested.tools?.includes("subagent_spawn"));
});

test("childToolLoadout leaves the default coder surface denylist-based", () => {
  const coder = childToolLoadout(undefined);
  assert.equal(coder.tools, undefined);
  // The one orchestration channel every child keeps is never denied. Check it
  // before the deepEqual assertion narrows `exclude` to its literal union.
  assert.equal(coder.exclude.includes(CHILD_ASK_TOOL), false);
  assert.deepEqual(coder.exclude, [...CHILD_ORCHESTRATION_TOOLS]);

  const nesting = childToolLoadout(undefined, { nestedSpawn: true });
  assert.equal(nesting.tools, undefined);
  assert.equal(nesting.exclude.includes("subagent_spawn"), false);
  assert.equal(nesting.exclude.includes("subagent_wait"), true);
});

test("childToolLoadout fails closed for an explicit empty allowlist", () => {
  assert.deepEqual(childToolLoadout({ tools: [] }).tools, [CHILD_ASK_TOOL]);
});

/** Extension tools registered into the fixture session: real execution/remote
 * capabilities plus orchestration tools that must be denied. */
const FIXTURE_EXTENSION_TOOLS = [
  "bg_start",
  "remote_spawn",
  "git_status",
  "subagent_wait",
  "workflow",
];

/** Build a real in-process child session exactly as the pi backend does and
 * report its registered/active tool names. */
async function realChildToolSurface(loadout: ChildToolLoadout) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "profile-tools-"));
  const agentDir = path.join(directory, "agent");
  try {
    // Mirror the live settings: powershell is a configured default tool, so
    // this regression cannot pass merely because the default surface is
    // narrow.
    const settingsManager = SettingsManager.inMemory(
      { defaultTools: ["read", "bash", "powershell", "edit", "write"] },
      { projectTrusted: false },
    );
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir,
      settingsManager,
      extensionFactories: [
        (pi) => {
          for (const name of FIXTURE_EXTENSION_TOOLS) {
            pi.registerTool({
              name,
              label: name,
              description: name,
              parameters: Type.Object({}),
              async execute() {
                return { content: [{ type: "text", text: "ok" }], details: {} };
              },
            });
          }
        },
      ],
    });
    await loader.reload();
    const askQuestion = defineTool({
      name: CHILD_ASK_TOOL,
      label: "Ask Orchestrator",
      description: "fixture",
      parameters: Type.Object({ question: Type.String() }),
      async execute() {
        return { content: [{ type: "text", text: "ok" }], details: {} };
      },
    });
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir,
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(directory),
      customTools: [askQuestion],
      ...(loadout.tools ? { tools: [...loadout.tools] } : {}),
      ...(loadout.exclude.length > 0
        ? { excludeTools: [...loadout.exclude] }
        : {}),
    });
    const surface = {
      all: new Set(session.getAllTools().map((tool) => tool.name)),
      active: new Set(session.getActiveToolNames()),
    };
    session.dispose();
    return surface;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("a real read-only child cannot see powershell or extension execution tools", async () => {
  const { all, active } = await realChildToolSurface(
    childToolLoadout(toolPolicyFor({ readOnly: true })),
  );
  for (const blocked of [
    ...FIXTURE_EXTENSION_TOOLS,
    "powershell",
    "bash",
    "write",
    "edit",
    "subagent_spawn",
    "subagent_send",
    "ask_user",
  ]) {
    assert.equal(all.has(blocked), false, `${blocked} must not be registered`);
    assert.equal(active.has(blocked), false, `${blocked} must not be active`);
  }
  for (const kept of ["read", "grep", "find", "ls", CHILD_ASK_TOOL]) {
    assert.equal(active.has(kept), true, `${kept} must be active`);
  }
});

test("a real default coder child keeps powershell and extension tools", async () => {
  const { all, active } = await realChildToolSurface(
    childToolLoadout(undefined),
  );
  for (const kept of [
    "bg_start",
    "remote_spawn",
    "git_status",
    "read",
    "bash",
    "powershell",
    "edit",
    "write",
    CHILD_ASK_TOOL,
  ]) {
    assert.equal(active.has(kept), true, `${kept} must be active`);
  }
  for (const blocked of [
    "subagent_spawn",
    "subagent_send",
    "subagent_wait",
    "workflow",
    "ask_user",
  ]) {
    assert.equal(all.has(blocked), false, `${blocked} must not be registered`);
  }
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
