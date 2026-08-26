/**
 * Smoke tests at the extension boundary: registers the real extension against
 * a minimal fake ExtensionAPI and exercises the tool-handler layer that the
 * manager/backend tests can't reach. Focuses on argument validation and
 * unknown-target errors (no backends are spawned here).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import subagentsExtension from "./index.ts";

interface FakeTool extends ToolDefinition {
  enter: () => Promise<unknown>;
}

function makeFakePi() {
  const tools = new Map<string, FakeTool>();
  const commands = new Map<string, { description: string }>();
  const handlers = new Map<
    string,
    (args: string, ctx: unknown) => Promise<void>
  >();
  const messages: unknown[] = [];
  const entries: Array<{ type: string; data: unknown }> = [];
  const events = new Map<string, (event: unknown, ctx: unknown) => void>();
  const pi = {
    registerTool: (tool: ToolDefinition) => {
      tools.set(tool.name, {
        ...tool,
        enter: () =>
          tool.execute?.(
            "t",
            {} as never,
            undefined,
            undefined,
            ctxFor({}) as never,
          ),
      });
    },
    registerCommand: (
      name: string,
      def: {
        description: string;
        handler: (args: string, ctx: unknown) => Promise<void>;
      },
    ) => {
      commands.set(name, { description: def.description });
      handlers.set(name, def.handler);
    },
    registerEntryRenderer: () => {},
    registerMessageRenderer: () => {},
    on: (event: string, cb: (event: unknown, ctx: unknown) => void) =>
      events.set(event, cb),
    sendMessage: (message: unknown, _opts?: unknown) => messages.push(message),
    appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
    getThinkingLevel: () => "high",
  };
  return { pi, tools, commands, handlers, messages, entries, events };
}

function ctxFor(overrides: Record<string, unknown> = {}) {
  return {
    cwd: process.cwd(),
    hasUI: false,
    ui: undefined,
    modelRegistry: undefined,
    model: undefined,
    isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => "019f-smoke" },
    ...overrides,
  };
}

test("registers the full tool surface (and no child-only tools outside a child)", () => {
  const saved = {
    PI_SUBAGENT: process.env.PI_SUBAGENT,
    PI_SUBAGENT_ASK_FILE: process.env.PI_SUBAGENT_ASK_FILE,
  };
  try {
    process.env.PI_SUBAGENT = undefined;
    process.env.PI_SUBAGENT_ASK_FILE = undefined;
    const { pi, tools } = makeFakePi();
    subagentsExtension(pi as never);
    for (const name of [
      "subagent_spawn",
      "subagent_send",
      "subagent_wait",
      "subagent_cancel",
      "subagent_check",
      "subagent_list",
    ]) {
      assert.ok(tools.has(name), `missing tool ${name}`);
    }
    assert.ok(!tools.has("ask_question"), "ask_question is child-only");
  } finally {
    process.env.PI_SUBAGENT = saved.PI_SUBAGENT;
    process.env.PI_SUBAGENT_ASK_FILE = saved.PI_SUBAGENT_ASK_FILE;
  }
});

test("registers ask_question inside a child (PI_SUBAGENT=1)", () => {
  const saved = {
    PI_SUBAGENT: process.env.PI_SUBAGENT,
    PI_SUBAGENT_ASK_FILE: process.env.PI_SUBAGENT_ASK_FILE,
  };
  try {
    process.env.PI_SUBAGENT = "1";
    process.env.PI_SUBAGENT_ASK_FILE = path.join(
      os.tmpdir(),
      `ask-${process.pid}.json`,
    );
    const { pi, tools } = makeFakePi();
    subagentsExtension(pi as never);
    assert.ok(tools.has("ask_question"));
  } finally {
    process.env.PI_SUBAGENT = saved.PI_SUBAGENT;
    process.env.PI_SUBAGENT_ASK_FILE = saved.PI_SUBAGENT_ASK_FILE;
  }
});

test("subagent_send rejects unknown targets with the known list", async () => {
  const { pi, tools } = makeFakePi();
  subagentsExtension(pi as never);
  const send = tools.get("subagent_send")!;
  await assert.rejects(send.enter(), /Unknown subagent target/);
  await assert.rejects(
    send.execute(
      "t",
      { target: "ghost", message: "hi" } as never,
      undefined,
      undefined,
      ctxFor() as never,
    ),
    /Unknown subagent target "ghost"/,
  );
});

test("subagent_wait / cancel / check reject unknown ids", async () => {
  const { pi, tools } = makeFakePi();
  subagentsExtension(pi as never);

  const wait = tools.get("subagent_wait")!;
  await assert.rejects(
    wait.execute(
      "t",
      { ids: ["sa-x"] } as never,
      undefined,
      undefined,
      ctxFor() as never,
    ),
    /Unknown subagent id\(s\): sa-x/,
  );

  const cancel = tools.get("subagent_cancel")!;
  await assert.rejects(
    cancel.execute(
      "t",
      { ids: ["sa-x"] } as never,
      undefined,
      undefined,
      ctxFor() as never,
    ),
    /Unknown subagent id\(s\): sa-x/,
  );

  const check = tools.get("subagent_check")!;
  await assert.rejects(
    check.execute(
      "t",
      { id: "sa-x" } as never,
      undefined,
      undefined,
      ctxFor() as never,
    ),
    /Unknown subagent id "sa-x"/,
  );
});

test("subagent_list returns an empty overview on a fresh session", async () => {
  const { pi, tools } = makeFakePi();
  subagentsExtension(pi as never);
  const list = tools.get("subagent_list")!;
  const result = await list.execute(
    "t",
    {} as never,
    undefined,
    undefined,
    ctxFor() as never,
  );
  const text = (result.content as Array<{ type?: string; text?: string }>)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
  assert.match(text, /no subagents/i);
});

test("spawn without a profile and empty agent dir resolves through pi (headless) and fails on missing model registry", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-smoke-"));
  const { pi, tools } = makeFakePi();
  subagentsExtension(pi as never);
  const spawn = tools.get("subagent_spawn")!;
  await assert.rejects(
    spawn.execute(
      "t",
      { prompt: "hello", name: "smoke" } as never,
      undefined,
      undefined,
      ctxFor({ cwd: tmp }) as never,
    ),
    /pi backend requires the parent session's model registry/,
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});
