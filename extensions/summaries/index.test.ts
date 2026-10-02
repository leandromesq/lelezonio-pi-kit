import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import summariesExtension, { summarizeErrorText } from "./index.ts";
import type { SummaryConfig } from "./src/config.ts";

const RECAP_ENTRY_TYPE = "summary-recap";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const BASE_CONFIG: SummaryConfig = {
  provider: "summary-test",
  model: "model",
  reasoning: "off",
  mode: "auto",
  minToolCalls: 1,
};

function userEntry(id: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: id === "base" ? null : "base",
    timestamp: new Date(0).toISOString(),
    message: { role: "user", content: id, timestamp: 0 },
  };
}

function runEntry(
  stopReason: "stop" | "aborted" | "error" = "stop",
  toolCalls = 1,
): SessionEntry {
  const content = [
    ...Array.from({ length: toolCalls }, (_, index) => ({
      type: "toolCall" as const,
      id: `call-${index}`,
      name: "bash",
      arguments: {},
    })),
    { type: "text" as const, text: "partial work" },
  ];
  return {
    type: "message",
    id: "run-message",
    parentId: "base",
    timestamp: new Date(0).toISOString(),
    message: {
      role: "assistant",
      content,
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      usage,
      stopReason,
      timestamp: 1,
    },
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function recapResponse(recap = "Feito.", next = "Revisar.") {
  return {
    content: [{ type: "text", text: JSON.stringify({ recap, next }) }],
    stopReason: "stop",
  };
}

interface Harness {
  fire: (event: string, payload?: unknown) => unknown;
  command: (name: string) => (args: string) => Promise<void>;
  state: { branch: SessionEntry[]; leafId: string | null; sessionId: string };
  calls: { find: number; stream: number };
  generated: Deferred<unknown>[];
  notified: { message: string; type: string | undefined }[];
  recaps: () => { customType: string; data: any }[];
  statuses: (string | undefined)[];
}

function createHarness(
  config: SummaryConfig = BASE_CONFIG,
  options: { auth?: boolean } = {},
): Harness {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: unknown) => Promise<void> }
  >();
  const appended: { customType: string; data: unknown }[] = [];
  const notified: { message: string; type: string | undefined }[] = [];
  const statuses: (string | undefined)[] = [];
  const generated: Deferred<unknown>[] = [];
  const calls = { find: 0, stream: 0 };

  const registry = {
    find: () => {
      calls.find++;
      return {
        provider: config.provider,
        id: config.model,
        api: "openai-completions",
      };
    },
    hasConfiguredAuth: () => options.auth !== false,
    streamSimple: () => {
      calls.stream++;
      const request = deferred<unknown>();
      generated.push(request);
      return { result: () => request.promise };
    },
  };

  const state = {
    branch: [] as SessionEntry[],
    leafId: "base" as string | null,
    sessionId: "session-1",
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    modelRegistry: registry,
    sessionManager: {
      getLeafId: () => state.leafId,
      getBranch: () => state.branch,
      getSessionId: () => state.sessionId,
    },
    ui: {
      theme: { fg: () => () => "" },
      setStatus: (_key: string, value: string | undefined) =>
        statuses.push(value),
      notify: (message: string, type: "info" | "warning" | "error") =>
        notified.push({ message, type }),
    },
  } as unknown as ExtensionContext;

  const api = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) =>
      handlers.set(event, handler),
    registerEntryRenderer: () => undefined,
    registerCommand: (
      name: string,
      definition: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) => commands.set(name, definition),
    appendEntry: (customType: string, data: unknown) =>
      appended.push({ customType, data }),
  } as unknown as ExtensionAPI;

  summariesExtension(api, {
    loadConfig: () => config,
    saveConfig: async () => undefined,
  });

  return {
    fire: (event, payload = {}) => handlers.get(event)!(payload, ctx),
    command: (name) => (args: string) => commands.get(name)!.handler(args, ctx),
    state,
    calls,
    generated,
    notified,
    recaps: () =>
      appended.filter(({ customType }) => customType === RECAP_ENTRY_TYPE),
    statuses,
  };
}

async function settleAutoRun(
  harness: Harness,
  entry: SessionEntry = runEntry(),
) {
  harness.state.branch = [userEntry("base"), entry];
  harness.state.leafId = "base";
  await harness.fire("session_start");
  await harness.fire("before_agent_start");
  await harness.fire("agent_settled");
}

test("registers the recap renderer, recap commands, and bounded lifecycle hooks", () => {
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
      "session_tree",
      "before_agent_start",
      "agent_settled",
      "session_shutdown",
    ]),
  );
  assert.deepEqual(renderers, new Set(["summary-recap"]));
  assert.deepEqual(
    commands,
    new Set(["summary-model", "summary-mode", "recap"]),
  );
});

test("aborted runs never reach the summarizer nor append a recap", async () => {
  const harness = createHarness();
  await settleAutoRun(harness, runEntry("aborted"));

  assert.equal(harness.calls.find, 0);
  assert.equal(harness.calls.stream, 0);
  assert.equal(harness.recaps().length, 0);
  assert.equal(harness.notified.length, 0);
});

test("auto mode appends the model recap for a meaningful run", async () => {
  const harness = createHarness();
  await settleAutoRun(harness);

  assert.equal(harness.calls.stream, 1);
  harness.generated[0].resolve(recapResponse());
  await tick();

  const recaps = harness.recaps();
  assert.equal(recaps.length, 1);
  assert.equal(recaps[0].data.recap, "Feito.");
  assert.equal(recaps[0].data.next, "Revisar.");
  assert.equal(recaps[0].data.fallback, undefined);
  assert.equal(recaps[0].data.provider, BASE_CONFIG.provider);
});

test("auto mode skips a trivial run below the tool-call threshold", async () => {
  const harness = createHarness();
  await settleAutoRun(harness, runEntry("stop", 0));

  assert.equal(harness.calls.stream, 0);
  assert.equal(harness.recaps().length, 0);
});

test("manual and off modes skip automatic recaps but keep the model idle", async () => {
  for (const mode of ["manual", "off"] as const) {
    const harness = createHarness({ ...BASE_CONFIG, mode });
    await settleAutoRun(harness);
    assert.equal(harness.calls.stream, 0, `mode ${mode} must not recap`);
    assert.equal(harness.recaps().length, 0);
  }
});

test("a failing model still yields the bounded local fallback", async () => {
  const harness = createHarness(BASE_CONFIG, { auth: false });
  await settleAutoRun(harness);
  await tick();

  const recaps = harness.recaps();
  assert.equal(recaps.length, 1);
  assert.equal(recaps[0].data.fallback, true);
  assert.ok(typeof recaps[0].data.recap === "string");
  assert.equal(harness.notified.length, 1);
  assert.equal(harness.notified[0].type, "warning");
  assert.match(harness.notified[0].message, /local fallback/);
  assert.doesNotMatch(harness.notified[0].message, /[\r\n\u001b]/);
});

test("errored runs are not interruptions and still get a summary", async () => {
  const harness = createHarness(BASE_CONFIG, { auth: false });
  await settleAutoRun(harness, runEntry("error"));
  await tick();

  assert.equal(harness.calls.find, 1);
  assert.equal(harness.recaps().length, 1);
});

test("on-demand /recap ignores the threshold and the configured mode", async () => {
  const harness = createHarness({ ...BASE_CONFIG, mode: "manual" });
  harness.state.branch = [userEntry("base"), runEntry("stop", 0)];
  harness.state.leafId = "base";
  await harness.fire("session_start");

  await harness.command("recap")("");

  assert.equal(harness.calls.stream, 1);
  harness.generated[0].resolve(recapResponse("Manual.", "Pronto."));
  await tick();

  const recaps = harness.recaps();
  assert.equal(recaps.length, 1);
  assert.equal(recaps[0].data.recap, "Manual.");
});

test("on-demand /recap without any run notifies instead of generating", async () => {
  const harness = createHarness();
  harness.state.branch = [];

  await harness.command("recap")("");

  assert.equal(harness.calls.stream, 0);
  assert.equal(harness.recaps().length, 0);
  assert.match(harness.notified[0]?.message ?? "", /No completed run/);
});

test("branch navigation cancels an in-flight recap so none lands on the new branch", async () => {
  const harness = createHarness();
  await settleAutoRun(harness);
  assert.equal(harness.calls.stream, 1);

  // The user navigates the tree while the recap model is still running.
  await harness.fire("session_tree", { newLeafId: "other" });
  harness.generated[0].resolve(recapResponse("Stale.", "Ignore."));
  await tick();

  assert.equal(harness.recaps().length, 0);
});

test("shutdown cancels an in-flight recap and never appends late", async () => {
  const harness = createHarness();
  await settleAutoRun(harness);
  assert.equal(harness.calls.stream, 1);

  const shutdown = harness.fire("session_shutdown") as Promise<void>;
  harness.generated[0].resolve(recapResponse("Late.", "Ignore."));
  await shutdown;
  await tick();

  assert.equal(harness.recaps().length, 0);
});

test("a recap bound to the old session cannot append after session replacement", async () => {
  const harness = createHarness();
  await settleAutoRun(harness);

  // Session replacement keeps the branch object but changes session identity.
  harness.state.sessionId = "session-2";
  harness.generated[0].resolve(recapResponse("Wrong session.", "Ignore."));
  await tick();

  assert.equal(harness.recaps().length, 0);
});

test("a PI_SUBAGENT=1 child disables recaps entirely (no model activity, no entries)", async () => {
  const previous = process.env.PI_SUBAGENT;
  process.env.PI_SUBAGENT = "1";
  try {
    const harness = createHarness();
    await settleAutoRun(harness);

    assert.equal(harness.calls.stream, 0);
    assert.equal(harness.recaps().length, 0);
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT;
    else process.env.PI_SUBAGENT = previous;
  }
});

test("summarizeErrorText collapses and bounds untrusted error text", () => {
  const noisy = `${"x".repeat(500)}\n\u001b[31msecond line\u001b[0m\t\tthird`;
  const bounded = summarizeErrorText(noisy);

  assert.ok(
    bounded.length <= 200,
    `expected <= 200 chars, got ${bounded.length}`,
  );
  assert.doesNotMatch(bounded, /[\r\n\t\u001b]/);
  assert.doesNotMatch(bounded, / {2,}/);
  assert.match(summarizeErrorText(" short "), /^short$/);
});
