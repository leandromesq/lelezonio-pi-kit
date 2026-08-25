import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRegistry,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import summariesExtension from "./index.ts";

const RECAP_ENTRY_TYPE = "summary-recap";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("registers only the recap renderer, command, and bounded lifecycle hooks", () => {
  const events = new Set<string>();
  const renderers = new Set<string>();
  const commands = new Set<string>();
  const api = {
    on: (event: string) => events.add(event),
    registerEntryRenderer: (customType: string) => renderers.add(customType),
    registerCommand: (name: string) => commands.add(name),
  } as unknown as ExtensionAPI;

  summariesExtension(api);

  assert.deepEqual(
    events,
    new Set([
      "session_start",
      "before_agent_start",
      "agent_settled",
      "session_shutdown",
    ]),
  );
  assert.deepEqual(renderers, new Set(["summary-recap"]));
  assert.deepEqual(commands, new Set(["summary-model"]));
});

test("aborted runs never reach the summarizer nor append a recap", async () => {
  const { run, assertNoGeneration } = await wireSettledHandler("aborted");
  await run();

  assertNoGeneration();
});

test("normal runs still get a recap (fallback when the model is unavailable)", async () => {
  const { run, assertNoGeneration } = await wireSettledHandler("normal");
  await run();

  assertNoGeneration();
});

test("errored runs are not interruptions and still get a recap", async () => {
  const { run, assertNoGeneration } = await wireSettledHandler("error");
  await run();

  assertNoGeneration();
});

function wireSettledHandler(termination: "aborted" | "normal" | "error") {
  const handlers = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => unknown
  >();
  const appended: Array<{ customType: string; data: unknown }> = [];
  const notified: Array<{ message: string; type: string | undefined }> = [];
  const api = {
    on: (
      event: string,
      handler: (event: unknown, ctx: ExtensionContext) => unknown,
    ) => handlers.set(event, handler),
    registerEntryRenderer: () => undefined,
    registerCommand: () => undefined,
    appendEntry: (customType: string, data: unknown) =>
      appended.push({ customType, data }),
  } as unknown as ExtensionAPI;

  summariesExtension(api);

  let generationAttempts = 0;
  const registry = {
    find() {
      generationAttempts++;
      if (termination === "aborted") {
        throw new Error(
          "summarizeRun must not run for interrupted/aborted runs",
        );
      }
      return { id: "fake-model" };
    },
    getApiKeyAndHeaders: async () => ({
      ok: false as const,
      error: "no api key in tests",
    }),
  } as unknown as ModelRegistry;

  const ui = {
    theme: { fg: () => () => "" },
    setStatus: () => undefined,
    notify: (message: string, type: "info" | "warning" | "error") =>
      notified.push({ message, type }),
  };
  const makeCtx = (branch: readonly SessionEntry[]): ExtensionContext =>
    ({
      mode: "tui",
      ui,
      modelRegistry: registry,
      sessionManager: {
        getLeafId: () => "base",
        getBranch: () => branch,
      },
    }) as unknown as ExtensionContext;

  const branch: SessionEntry[] = [
    {
      type: "message",
      id: "base",
      parentId: null,
      timestamp: new Date(0).toISOString(),
      message: { role: "user", content: "base", timestamp: 0 },
    },
    {
      type: "message",
      id: "run-message",
      parentId: "base",
      timestamp: new Date(0).toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "partial work" }],
        api: "openai-codex-responses",
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        usage,
        stopReason: termination === "normal" ? "stop" : termination,
        timestamp: 1,
      },
    },
  ];

  const run = async () => {
    // Settle handlers await every extension handler, mirroring pi's event order:
    // session_start -> before_agent_start (leaf baseline) -> agent_settled.
    await handlers.get("session_start")!({}, makeCtx([]));
    await handlers.get("before_agent_start")!({}, makeCtx([]));
    await handlers.get("agent_settled")!({}, makeCtx(branch));
    // The recap task is deliberately not awaited by pi; let its microtasks settle.
    await new Promise((resolve) => setTimeout(resolve, 100));
  };

  const assertNoGeneration = () => {
    const recaps = appended.filter(
      ({ customType }) => customType === RECAP_ENTRY_TYPE,
    );
    if (termination === "aborted") {
      assert.equal(
        generationAttempts,
        0,
        "generation attempted for aborted run",
      );
      assert.equal(recaps.length, 0, "recap delivered for aborted run");
      assert.equal(notified.length, 0, "fallback notified for aborted run");
    } else {
      assert.ok(generationAttempts >= 1, "generation never attempted");
      assert.equal(recaps.length, 1, "recap missing for completed run");
      const data = recaps[0].data as { fallback?: boolean; recap?: unknown };
      assert.equal(data.fallback, true, "expected the local fallback recap");
      assert.ok(typeof data.recap === "string" && data.recap.length > 0);
    }
  };

  return { run, assertNoGeneration };
}
