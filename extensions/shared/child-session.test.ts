import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  defineTool,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  type SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  bindChildSessionExtensions,
  CHILD_EXCLUDED_TOOL_NAMES,
  childNativeExtensionFactories,
  childNativeExtensionsFor,
  childToolPolicy,
  createChildResources,
  FULL_CHILD_NATIVE_EXTENSIONS,
  resolveStandaloneChildProjectTrust,
  shutdownAndDisposeChildSession,
  withoutChildExcludedExtensions,
  type DisposableChildSession,
} from "./child-session.ts";
import {
  CHILD_MCP_TOOL_EXCLUSIONS,
  childToolLoadout,
} from "../subagents/src/profile.ts";

async function withTempDir(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-child-policy-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function pathExists(candidate: string) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

/** Poll until `check` is true or the deadline passes (process fixtures). */
async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("child denylist keeps extension and workflow structured tools available", async () => {
  await withTempDir(async (directory) => {
    let starts = 0;
    let shutdowns = 0;
    const settingsManager = SettingsManager.inMemory(undefined, {
      projectTrusted: false,
    });
    const inlineLoader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: path.join(directory, "inline-agent"),
      settingsManager,
      extensionFactories: [
        (pi) => {
          pi.on("session_start", () => {
            starts++;
          });
          pi.on("session_shutdown", () => {
            shutdowns++;
          });
          for (const name of [
            "fixture_extension_tool",
            ...CHILD_EXCLUDED_TOOL_NAMES,
          ]) {
            pi.registerTool({
              name,
              label: name,
              description: name,
              parameters: Type.Object({}),
              async execute() {
                return {
                  content: [{ type: "text", text: "ok" }],
                  details: {},
                };
              },
            });
          }
        },
      ],
    });
    await inlineLoader.reload();

    const structuredOutput = defineTool({
      name: "structured_output",
      label: "Structured Output",
      description: "fixture structured result",
      parameters: Type.Object({ value: Type.String() }),
      async execute(_id, params) {
        return {
          content: [{ type: "text", text: params.value }],
          details: {},
        };
      },
    });
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: path.join(directory, "inline-agent"),
      resourceLoader: inlineLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(directory),
      customTools: [structuredOutput],
      ...childToolPolicy(),
    });
    await bindChildSessionExtensions(session);

    assert.deepEqual(
      [...CHILD_EXCLUDED_TOOL_NAMES],
      [
        "subagent_spawn",
        "subagent_send",
        "subagent_wait",
        "subagent_cancel",
        "subagent_check",
        "subagent_list",
        "remote_spawn",
        "remote_send",
        "remote_wait",
        "remote_cancel",
        "remote_check",
        "remote_list",
        "workflow",
        "ask_user",
      ],
    );
    const allTools = new Set(session.getAllTools().map((tool) => tool.name));
    const activeTools = new Set(session.getActiveToolNames());
    assert.equal(starts, 1);
    assert.equal(allTools.has("fixture_extension_tool"), true);
    assert.equal(activeTools.has("fixture_extension_tool"), true);
    assert.equal(allTools.has("structured_output"), true);
    assert.equal(activeTools.has("structured_output"), true);
    for (const denied of CHILD_EXCLUDED_TOOL_NAMES) {
      assert.equal(allTools.has(denied), false, `${denied} should be denied`);
      assert.equal(
        activeTools.has(denied),
        false,
        `${denied} should be inactive`,
      );
    }
    for (const builtin of ["read", "bash", "edit", "write"]) {
      assert.equal(
        activeTools.has(builtin),
        true,
        `${builtin} should stay active`,
      );
    }

    await Promise.all([
      shutdownAndDisposeChildSession(session),
      shutdownAndDisposeChildSession(session),
    ]);
    assert.equal(shutdowns, 1);
  });
});

test("resource loading gates project extensions but retains global extensions", async () => {
  await withTempDir(async (directory) => {
    const cwd = path.join(directory, "project");
    const agentDir = path.join(directory, "agent");
    await mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
    await mkdir(path.join(agentDir, "extensions"), { recursive: true });
    const extensionSource = (name: string) => `
      export default function (pi) {
        pi.registerTool({
          name: ${JSON.stringify(name)}, label: ${JSON.stringify(name)},
          description: "fixture", parameters: { type: "object", properties: {} },
          async execute() { return { content: [{ type: "text", text: "ok" }] }; }
        });
      }
    `;
    await writeFile(
      path.join(agentDir, "extensions", "global.ts"),
      extensionSource("global_fixture"),
    );
    await writeFile(
      path.join(cwd, ".pi", "extensions", "project.ts"),
      extensionSource("project_fixture"),
    );

    const untrusted = await createChildResources({
      cwd,
      agentDir,
      projectTrusted: false,
    });
    const untrustedTools = untrusted.loader
      .getExtensions()
      .extensions.flatMap((extension) => [...extension.tools.keys()]);
    assert.equal(untrustedTools.includes("global_fixture"), true);
    assert.equal(untrustedTools.includes("project_fixture"), false);

    const trusted = await createChildResources({
      cwd,
      agentDir,
      projectTrusted: true,
    });
    const trustedTools = trusted.loader
      .getExtensions()
      .extensions.flatMap((extension) => [...extension.tools.keys()]);
    assert.equal(trustedTools.includes("global_fixture"), true);
    assert.equal(trustedTools.includes("project_fixture"), true);
  });
});

test("alternate standalone cwd only uses explicit saved trust", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const childCwd = path.join(directory, "alternate");
    const agentDir = path.join(directory, "agent");
    await mkdir(parentCwd, { recursive: true });
    await mkdir(childCwd, { recursive: true });

    assert.equal(
      resolveStandaloneChildProjectTrust({
        parentCwd,
        childCwd: parentCwd,
        parentTrusted: true,
        agentDir,
      }),
      true,
    );
    assert.equal(
      resolveStandaloneChildProjectTrust({
        parentCwd,
        childCwd,
        parentTrusted: true,
        agentDir,
      }),
      false,
    );

    new ProjectTrustStore(agentDir).set(childCwd, true);
    assert.equal(
      resolveStandaloneChildProjectTrust({
        parentCwd,
        childCwd,
        parentTrusted: false,
        agentDir,
      }),
      true,
    );
  });
});

test("shutdown helper balances hooks and disposal despite errors", async () => {
  let emits = 0;
  let disposals = 0;
  const session: DisposableChildSession = {
    extensionRunner: {
      hasHandlers: () => true,
      async emit(event: SessionShutdownEvent) {
        emits++;
        assert.deepEqual(event, { type: "session_shutdown", reason: "quit" });
        throw new Error("fixture shutdown failure");
      },
    },
    dispose() {
      disposals++;
    },
  };

  await Promise.all([
    shutdownAndDisposeChildSession(session),
    shutdownAndDisposeChildSession(session),
    shutdownAndDisposeChildSession(session),
  ]);
  assert.equal(emits, 1);
  assert.equal(disposals, 1);
});

test("shutdown helper bounds a stuck hook before disposal", async () => {
  let disposals = 0;
  const session: DisposableChildSession = {
    extensionRunner: {
      hasHandlers: () => true,
      emit: () => new Promise(() => {}),
    },
    dispose() {
      disposals++;
    },
  };

  await shutdownAndDisposeChildSession(session, { timeoutMs: 10 });
  assert.equal(disposals, 1);
});

/** Minimal shape the override needs: the resolved path is what identifies a
 * package-installed extension inside a child's loader result. */
function extensionResult(resolvedPaths: readonly string[]) {
  return {
    extensions: resolvedPaths.map((resolvedPath) => ({
      path: resolvedPath,
      resolvedPath,
    })),
    errors: [],
    runtime: {},
  } as unknown as Parameters<typeof withoutChildExcludedExtensions>[0];
}

test("a child keeps ordinary extensions and drops parent-only ones", () => {
  const filtered = withoutChildExcludedExtensions(
    extensionResult([
      "C:/Users/x/.pi/agent/extensions/subagents/index.ts",
      "C:/Users/x/.pi/agent/npm/node_modules/pi-observational-memory/src/index.ts",
      // Vendored under a path whose segment is the package name: the same
      // whole-segment rule must catch it.
      "C:/Users/x/.pi/agent/vendor/pi-observational-memory/src/index.ts",
      // The alternative fork's actual manifest/package name is also excluded.
      "C:/Users/x/.pi/agent/npm/node_modules/observational-memory/src/index.ts",
      "C:/Users/x/.pi/agent/npm/node_modules/pi-observational-memory-extra/src/index.ts",
    ]),
  );
  assert.deepEqual(
    filtered.extensions.map((extension) => extension.resolvedPath),
    [
      "C:/Users/x/.pi/agent/extensions/subagents/index.ts",
      // A package whose name only starts with the excluded one is not the
      // excluded package: the match is on the real path segment.
      "C:/Users/x/.pi/agent/npm/node_modules/pi-observational-memory-extra/src/index.ts",
    ],
  );
  // Errors and runtime are carried over untouched.
  assert.equal(filtered.errors.length, 0);
});

test("optional child services are excluded only when explicitly requested", () => {
  const optional = "/agent/npm/node_modules/optional-daemon/pi-extension.ts";
  const other = "/agent/extensions/optional-daemon-extra/index.ts";
  const donsetch = "/agent/npm/node_modules/donsetch/pi-extension.ts";
  const base = extensionResult([optional, other, donsetch]);
  // DonSeTch is always excluded, even with no explicit request: its daemon is
  // process-wide and an in-process child could cross-kill the parent's.
  assert.deepEqual(
    withoutChildExcludedExtensions(base).extensions.map(
      (entry) => entry.resolvedPath,
    ),
    [optional, other],
  );
  assert.deepEqual(
    withoutChildExcludedExtensions(base, ["optional-daemon"]).extensions.map(
      (entry) => entry.resolvedPath,
    ),
    [other],
  );
});

test("excluded optional services never run their child session-start hook", async () => {
  await withTempDir(async (directory) => {
    const agentDir = path.join(directory, "agent");
    const extensionDir = path.join(agentDir, "extensions", "optional-daemon");
    await mkdir(extensionDir, { recursive: true });
    await writeFile(
      path.join(extensionDir, "index.ts"),
      `
      export default function (pi) {
        pi.on("session_start", () => { throw new Error("optional daemon must not start"); });
      }
    `,
    );
    const resources = await createChildResources({
      cwd: directory,
      agentDir,
      projectTrusted: false,
      excludedExtensionPaths: ["optional-daemon"],
    });
    assert.equal(resources.loader.getExtensions().extensions.length, 0);
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir,
      resourceLoader: resources.loader,
      settingsManager: resources.settingsManager,
      sessionManager: SessionManager.inMemory(directory),
    });
    try {
      await bindChildSessionExtensions(session);
      assert.equal(session.extensionRunner.hasHandlers("session_start"), false);
    } finally {
      await shutdownAndDisposeChildSession(session);
    }
  });
});

test("a real default coder child never loads the DonSeTch daemon", async () => {
  await withTempDir(async (directory) => {
    const agentDir = path.join(directory, "agent");
    const extensionDir = path.join(agentDir, "extensions", "donsetch");
    const keeperDir = path.join(agentDir, "extensions", "keeper");
    await mkdir(extensionDir, { recursive: true });
    await mkdir(keeperDir, { recursive: true });
    const marker = path.join(directory, "donsetch-started");
    const keeperMarker = path.join(directory, "keeper-started");
    await writeFile(
      path.join(extensionDir, "index.ts"),
      `
      import { writeFileSync } from "node:fs";
      export default function (pi) {
        pi.on("session_start", () => { writeFileSync(${JSON.stringify(marker)}, "started"); });
        pi.registerTool({
          name: "web_fixture", label: "web_fixture", description: "fixture",
          parameters: { type: "object", properties: {} },
          async execute() { return { content: [{ type: "text", text: "ok" }] }; }
        });
      }
    `,
    );
    // A second, ordinary extension proves child session_start hooks do run,
    // so the absent DonSeTch marker below is a real filter and not a silently
    // unbound session.
    await writeFile(
      path.join(keeperDir, "index.ts"),
      `
      import { writeFileSync } from "node:fs";
      export default function (pi) {
        pi.on("session_start", () => { writeFileSync(${JSON.stringify(keeperMarker)}, "started"); });
      }
    `,
    );
    // A default (unnarrowed) child is the surface that used to keep DonSeTch.
    const resources = await createChildResources({
      cwd: directory,
      agentDir,
      projectTrusted: false,
      nativeBuiltins: true,
    });
    assert.equal(
      resources.loader
        .getExtensions()
        .extensions.some((extension) =>
          String(extension.resolvedPath ?? "").includes("donsetch"),
        ),
      false,
    );
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir,
      resourceLoader: resources.loader,
      settingsManager: resources.settingsManager,
      sessionManager: SessionManager.inMemory(directory),
    });
    try {
      await bindChildSessionExtensions(session);
      assert.equal(
        await pathExists(keeperMarker),
        true,
        "ordinary child session hooks still run",
      );
      assert.equal(
        session.getAllTools().some((tool) => tool.name === "web_fixture"),
        false,
        "default children do not get DonSeTch web tools",
      );
      assert.equal(await pathExists(marker), false);
    } finally {
      await shutdownAndDisposeChildSession(session);
    }
  });
});

test("native builtins are opt-in and register codemode plus tool_search", async () => {
  await withTempDir(async (directory) => {
    const agentDir = path.join(directory, "agent");
    const cwd = path.join(directory, "project");
    await mkdir(cwd, { recursive: true });

    const plain = await createChildResources({
      cwd,
      agentDir,
      projectTrusted: false,
    });
    const plainTools = plain.loader
      .getExtensions()
      .extensions.flatMap((extension) => [...extension.tools.keys()]);
    assert.equal(plainTools.includes("codemode"), false);
    assert.equal(plainTools.includes("tool_search"), false);

    const native = await createChildResources({
      cwd,
      agentDir,
      projectTrusted: false,
      nativeBuiltins: true,
    });
    const nativeTools = native.loader
      .getExtensions()
      .extensions.flatMap((extension) => [...extension.tools.keys()]);
    assert.equal(nativeTools.includes("codemode"), true);
    assert.equal(nativeTools.includes("tool_search"), true);

    // The factory selection is additive and independent: codemode can be
    // requested without tool_search or MCP.
    assert.deepEqual(FULL_CHILD_NATIVE_EXTENSIONS, {
      codemode: true,
      toolSearch: true,
      mcp: true,
    });
    assert.equal(childNativeExtensionFactories({ codemode: true }).length, 1);
    assert.equal(childNativeExtensionFactories({}).length, 0);
    assert.equal(childNativeExtensionFactories().length, 3);
  });
});

test("narrowed SDK children load codemode alone; full children keep MCP", async () => {
  await withTempDir(async (directory) => {
    const agentDir = path.join(directory, "agent");
    const cwd = path.join(directory, "project");
    await mkdir(cwd, { recursive: true });

    // A narrowed profile that names codemode: exactly codemode, no
    // tool_search and no MCP extension.
    assert.deepEqual(
      childNativeExtensionsFor({ tools: ["read", "codemode"] }),
      {
        codemode: true,
        toolSearch: false,
        mcp: false,
      },
    );
    assert.deepEqual(childNativeExtensionsFor({ tools: ["read"] }), {
      codemode: false,
      toolSearch: false,
      mcp: false,
    });
    // A full-surface child (no allowlist) keeps the whole native set.
    assert.deepEqual(
      childNativeExtensionsFor({ tools: undefined }),
      FULL_CHILD_NATIVE_EXTENSIONS,
    );

    const narrowed = await createChildResources({
      cwd,
      agentDir,
      projectTrusted: false,
      nativeExtensions: childNativeExtensionsFor({
        tools: ["read", "codemode"],
      }),
    });
    const narrowedTools = narrowed.loader
      .getExtensions()
      .extensions.flatMap((extension) => [...extension.tools.keys()]);
    assert.equal(narrowedTools.includes("codemode"), true);
    assert.equal(narrowedTools.includes("tool_search"), false);
    const narrowedSession = (
      await createAgentSession({
        cwd,
        agentDir,
        resourceLoader: narrowed.loader,
        settingsManager: narrowed.settingsManager,
        sessionManager: SessionManager.inMemory(directory),
        tools: ["read", "codemode"],
        excludeTools: [...CHILD_MCP_TOOL_EXCLUSIONS],
      })
    ).session;
    try {
      await bindChildSessionExtensions(narrowedSession);
      // The MCP extension owns this handler; its absence is what guarantees no
      // server process can start for a narrowed child.
      assert.equal(
        narrowedSession.extensionRunner.hasHandlers("mcp_servers_change"),
        false,
      );
    } finally {
      await shutdownAndDisposeChildSession(narrowedSession);
    }

    const full = await createChildResources({
      cwd,
      agentDir,
      projectTrusted: false,
      nativeExtensions: childNativeExtensionsFor({ tools: undefined }),
    });
    const fullTools = full.loader
      .getExtensions()
      .extensions.flatMap((extension) => [...extension.tools.keys()]);
    assert.equal(fullTools.includes("codemode"), true);
    assert.equal(fullTools.includes("tool_search"), true);
    const fullSession = (
      await createAgentSession({
        cwd,
        agentDir,
        resourceLoader: full.loader,
        settingsManager: full.settingsManager,
        sessionManager: SessionManager.inMemory(directory),
      })
    ).session;
    try {
      await bindChildSessionExtensions(fullSession);
      assert.equal(
        fullSession.extensionRunner.hasHandlers("mcp_servers_change"),
        true,
      );
    } finally {
      await shutdownAndDisposeChildSession(fullSession);
    }
  });
});

test("script exposure never escapes the exclusion or allowlist", async () => {
  await withTempDir(async (directory) => {
    const agentDir = path.join(directory, "agent");
    const settingsManager = SettingsManager.inMemory(undefined, {
      projectTrusted: false,
    });
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir,
      settingsManager,
      extensionFactories: [
        (pi) => {
          for (const [name, exposure] of [
            ["fixture_codemode", "codemode"],
            ["fixture_deferred", "deferred"],
            ["fixture_model_only", "model-only"],
            // A denied name must stay denied even when it asks for script
            // callability: exclusion removes it from the callable registry,
            // not just from the active set.
            ["subagent_spawn", "codemode"],
          ] as const) {
            pi.registerTool({
              name,
              label: name,
              description: name,
              exposure,
              parameters: Type.Object({}),
              async execute() {
                return {
                  content: [{ type: "text", text: "ok" }],
                  details: {},
                };
              },
            });
          }
        },
      ],
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: directory,
      agentDir,
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(directory),
      ...childToolPolicy(),
    });
    await bindChildSessionExtensions(session);

    const callable = new Set(session.getCallableToolNames());
    assert.equal(callable.has("fixture_codemode"), true);
    assert.equal(callable.has("fixture_deferred"), true);
    // Model-only tools are declared, never callable from a script.
    assert.equal(callable.has("fixture_model_only"), false);
    assert.equal(callable.has("subagent_spawn"), false);

    const all = new Set(session.getAllTools().map((tool) => tool.name));
    assert.equal(all.has("fixture_model_only"), true);
    assert.equal(all.has("subagent_spawn"), false);
    assert.equal(
      session.getActiveToolNames().includes("fixture_model_only"),
      true,
    );

    await shutdownAndDisposeChildSession(session);
  });
});

/** A minimal assistant message so codemode's nested calls have an issuer. */
function fakeAssistantMessage() {
  return {
    role: "assistant",
    content: [],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as never;
}

function codemodeResultText(result: {
  content: ReadonlyArray<{ type: string; text?: string }>;
}) {
  return result.content
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("\n");
}

test("codemode executes allowlisted reads and denies every other surface", async () => {
  await withTempDir(async (directory) => {
    const agentDir = path.join(directory, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(directory, "sample.txt"), "hello codemode\n");
    const loadout = childToolLoadout({ tools: ["read", "codemode"] });
    const settingsManager = SettingsManager.inMemory(undefined, {
      projectTrusted: false,
    });
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir,
      settingsManager,
      extensionFactories: [
        createCodemodeExtension(),
        (pi) => {
          for (const [name, exposure] of [
            ["fixture_extension_tool", "codemode"],
            ["fixture_deferred", "deferred"],
            // An alternate MCP server: `mcp__*` must not survive the narrowed
            // allowlist even though native-MCP selection/`--no-mcp` only
            // covers the built-in extension.
            ["mcp__unauthorized", "codemode"],
          ] as const) {
            pi.registerTool({
              name,
              label: name,
              description: name,
              exposure,
              parameters: Type.Object({}),
              async execute() {
                return {
                  content: [{ type: "text", text: "should never run" }],
                  details: {},
                };
              },
            });
          }
        },
      ],
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: directory,
      agentDir,
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(directory),
      tools: [...loadout.tools!],
      excludeTools: [...loadout.exclude],
    });
    try {
      await bindChildSessionExtensions(session);

      const callable = new Set(session.getCallableToolNames());
      assert.equal(callable.has("read"), true);
      // Denied by the allowlist/exclusion, not merely left inactive: these
      // names are absent from the registry a codemode script can reach.
      for (const denied of [
        "write",
        "bash",
        "edit",
        "fixture_extension_tool",
        "fixture_deferred",
        "mcp__unauthorized",
      ]) {
        assert.equal(
          callable.has(denied),
          false,
          `${denied} must not be callable`,
        );
        assert.equal(
          session.getAllTools().some((tool) => tool.name === denied),
          false,
          `${denied} must not be registered`,
        );
      }

      // A fake assistant message gives nested calls their issuer; the nested
      // tool pipeline, registry filter, and tool execution are the real ones.
      session.state.messages.push(fakeAssistantMessage());
      const codemode = session.getToolDefinition("codemode");
      assert.ok(codemode, "codemode must be registered for this child");
      const run = (code: string) =>
        codemode.execute(
          "cm-1",
          { code },
          undefined,
          undefined,
          session.extensionRunner.createToolContext("cm-1", undefined),
        );

      const ok = await run(
        'const text = await tools.read({ path: "sample.txt" }); return text;',
      );
      assert.equal(ok.isError ?? false, false, codemodeResultText(ok));
      assert.match(codemodeResultText(ok), /hello codemode/);

      for (const [label, code] of [
        ["write", 'await tools.write({ path: "x.txt", content: "nope" });'],
        ["bash", 'await tools.bash({ command: "echo nope" });'],
        ["extension", "await tools.fixture_extension_tool({});"],
        ["deferred", "await tools.fixture_deferred({});"],
        ["mcp", "await tools.mcp__unauthorized({});"],
      ] as const) {
        const denied = await run(code);
        assert.equal(denied.isError, true, `${label} must be denied`);
        assert.match(
          codemodeResultText(denied),
          /does not exist|not a function|not found/i,
          `${label}: ${codemodeResultText(denied)}`,
        );
      }
      // The denied write script never created its file.
      assert.equal(await pathExists(path.join(directory, "x.txt")), false);
    } finally {
      await shutdownAndDisposeChildSession(session);
    }
  });
});

test("a narrowed child starts no configured MCP server process", async () => {
  await withTempDir(async (directory) => {
    const agentDir = path.join(directory, "agent");
    await mkdir(agentDir, { recursive: true });
    const marker = path.join(directory, "mcp-started");
    // A fake stdio server: it writes a marker the instant it is spawned and
    // then stays alive (self-exiting as a safety net), so a real connection
    // attempt is observable without speaking MCP.
    const serverScript =
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started");` +
      "process.stdin.resume();" +
      "setTimeout(() => process.exit(0), 10000);";
    await writeFile(
      path.join(agentDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          fixture: { command: process.execPath, args: ["-e", serverScript] },
        },
      }),
    );

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      const narrowed = await createChildResources({
        cwd: directory,
        agentDir,
        projectTrusted: false,
        nativeExtensions: childNativeExtensionsFor({
          tools: ["read", "codemode"],
        }),
      });
      const narrowedSession = (
        await createAgentSession({
          cwd: directory,
          agentDir,
          resourceLoader: narrowed.loader,
          settingsManager: narrowed.settingsManager,
          sessionManager: SessionManager.inMemory(directory),
          tools: ["read", "codemode"],
          excludeTools: [...CHILD_MCP_TOOL_EXCLUSIONS],
        })
      ).session;
      try {
        await bindChildSessionExtensions(narrowedSession);
        assert.equal(
          narrowedSession.extensionRunner.hasHandlers("mcp_servers_change"),
          false,
        );
        // Give a would-be spawn ample time to write the marker.
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal(
          await pathExists(marker),
          false,
          "a narrowed child must not start an MCP server",
        );
      } finally {
        await shutdownAndDisposeChildSession(narrowedSession);
      }

      // Positive control: the same fixture DOES start for a full-surface
      // child, so the assertion above cannot pass vacuously.
      const full = await createChildResources({
        cwd: directory,
        agentDir,
        projectTrusted: false,
        nativeBuiltins: true,
      });
      const fullSession = (
        await createAgentSession({
          cwd: directory,
          agentDir,
          resourceLoader: full.loader,
          settingsManager: full.settingsManager,
          sessionManager: SessionManager.inMemory(directory),
        })
      ).session;
      try {
        await bindChildSessionExtensions(fullSession);
        assert.equal(
          fullSession.extensionRunner.hasHandlers("mcp_servers_change"),
          true,
        );
        await waitFor(
          () => pathExists(marker),
          5000,
          "full-surface child to start the configured MCP server",
        );
      } finally {
        await shutdownAndDisposeChildSession(fullSession);
      }
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });
});
