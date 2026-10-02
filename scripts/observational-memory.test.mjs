/**
 * Observational-memory vendor regression tests.
 *
 * Loads the vendored amosblomqvist/pi-observational-memory source (pinned commit
 * 78a1efcfdd46332253fb289724f05b26dfc7769e) through the host's jiti, without any model,
 * network, or credential dependency. Covers the local compatibility/safety fixes:
 *
 *   - config validation (relational bounds, `enabled`, `compactAtContextTokens: 0`)
 *   - project-settings trust gating
 *   - child/passive env gating and the `agent_settled` shutdown timing
 *   - the worker turn cap
 *   - `om2.*` ledger namespace isolation from the legacy `om.*` entries
 *   - deterministic ledger fold/projection/render/chunking
 *   - symlink-safe `.memory/` path scoping and the consolidator durable ack
 *   - portable `pi` entry resolution and worker argv/env isolation
 *
 * Run: `node scripts/observational-memory.test.mjs`
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Use the host's declared loader dependency, just as Pi loads TypeScript packages.
const hostRequire = createRequire(
  import.meta.resolve("@earendil-works/pi-coding-agent"),
);
const { createJiti } = hostRequire("jiti");
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  interopDefault: false,
  alias: {
    "@earendil-works/pi-ai/compat": fileURLToPath(
      import.meta.resolve("@earendil-works/pi-ai/compat"),
    ),
    "@earendil-works/pi-ai": fileURLToPath(
      import.meta.resolve("@earendil-works/pi-ai/compat"),
    ),
    "@earendil-works/pi-agent-core": fileURLToPath(
      import.meta.resolve("@earendil-works/pi-agent-core"),
    ),
  },
});
const VENDOR = new URL("../vendor/pi-observational-memory/", import.meta.url);
const load = (path) => jiti.import(fileURLToPath(new URL(path, VENDOR)));

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeFakePi() {
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const entries = [];
  const messages = [];
  const on = (event, handler) => {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
  };
  return {
    pi: {
      registerTool: (definition) => tools.set(definition.name, definition),
      registerCommand: (name, definition) => commands.set(name, definition),
      on,
      appendEntry: (type, data) => entries.push({ type, data }),
      sendMessage: (message, options) => messages.push({ message, options }),
    },
    tools,
    commands,
    handlers,
    entries,
    messages,
  };
}

function withEnv(vars, run) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Isolate the global agent dir so the developer's real settings cannot leak into a test. */
function withIsolatedAgentDir(run) {
  const dir = makeTempDir("om-agentdir-");
  try {
    return withEnv({ PI_CODING_AGENT_DIR: dir }, run);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Config: defaults, validation, trust gating ────────────────────────────────

test("config: defaults disable proactive compaction and opt-in is off", async () => {
  const { DEFAULTS, loadConfig, applyRelationalBounds } =
    await load("src/config.ts");
  assert.equal(DEFAULTS.compactAtContextTokens, 0);
  assert.equal(DEFAULTS.enabled, false);
  assert.equal(DEFAULTS.chunkOverlapTokens, 0);
  assert.equal(DEFAULTS.models.observer.provider, "opencode-go");
  assert.equal(DEFAULTS.models.observer.id, "deepseek-v4.1-flash");
  assert.equal(DEFAULTS.models.consolidator.thinking, "low");

  const cwd = makeTempDir("om-cfg-");
  try {
    withIsolatedAgentDir(() => {
      const config = loadConfig(cwd, {}, { projectTrusted: false });
      assert.equal(config.enabled, false);
      assert.equal(config.compactAtContextTokens, 0);
    });
    // Relational bounds are enforced even for hand-built configs.
    const bounded = applyRelationalBounds({
      ...DEFAULTS,
      chunkTokens: 100,
      chunkOverlapTokens: 500,
      poolTargetTokens: 20_000,
      consolidateAtPoolTokens: 5_000,
      observerConcurrency: 999,
    });
    assert.equal(bounded.chunkOverlapTokens, 99);
    assert.equal(bounded.consolidateAtPoolTokens, 20_000);
    assert.equal(bounded.observerConcurrency, 8);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("config: project settings require trust and honor enabled/0", async () => {
  const { loadConfig } = await load("src/config.ts");
  const cwd = makeTempDir("om-cfg-trust-");
  try {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        "observational-memory": {
          enabled: true,
          compactAtContextTokens: 0,
          observerConcurrency: 1,
          models: {
            observer: {
              provider: "opencode-go",
              id: "deepseek-v4.1-flash",
              thinking: "max",
            },
          },
        },
      }),
    );
    withIsolatedAgentDir(() => {
      const untrusted = loadConfig(cwd, {}, { projectTrusted: false });
      assert.equal(
        untrusted.enabled,
        false,
        "untrusted project settings must be ignored",
      );
      const trusted = loadConfig(cwd, {}, { projectTrusted: true });
      assert.equal(trusted.enabled, true);
      assert.equal(
        trusted.compactAtContextTokens,
        0,
        "0 must survive normalization",
      );
      assert.equal(trusted.observerConcurrency, 1);
      assert.equal(
        trusted.models.observer.thinking,
        "max",
        "Pi 1 max thinking level is accepted",
      );
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("config: PI_OM_PASSIVE env maps to passive without touching the gate", async () => {
  const { readEnvConfig, loadConfig } = await load("src/config.ts");
  assert.deepEqual(readEnvConfig({ PI_OM_PASSIVE: "1" }), { passive: true });
  assert.deepEqual(readEnvConfig({ PI_OM_PASSIVE: "off" }), { passive: false });
  const cwd = makeTempDir("om-cfg-env-");
  try {
    withEnv({ PI_OM_PASSIVE: "1" }, () => {
      const config = loadConfig(cwd, process.env, { projectTrusted: false });
      assert.equal(config.passive, true);
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Orchestrator factory: child gating, handlers, commands ────────────────────

test("factory: registers nothing in a child or passive worker process", async () => {
  const { default: register } = await load("src/index.ts");
  const explodingPi = new Proxy(
    {},
    {
      get() {
        throw new Error("child tried to register memory");
      },
    },
  );
  for (const key of ["PI_SUBAGENT", "PI_OBSERVATIONAL_MEMORY_PASSIVE"]) {
    withEnv({ [key]: "1" }, () => register(explodingPi));
  }
});

test("factory: registers the gate command, tree restore, and shutdown", async () => {
  const { default: register } = await load("src/index.ts");
  const { pi, commands, handlers } = makeFakePi();
  register(pi);
  assert.ok(commands.has("om"), "registers /om");
  assert.ok(commands.has("om:status"));
  assert.ok(handlers.has("session_start"));
  assert.ok(
    handlers.has("session_tree"),
    "the gate must be restored on /tree navigation",
  );
  assert.ok(handlers.has("session_shutdown"));
  assert.ok(handlers.has("turn_end"));
});

// ── Worker extension: shutdown timing + turn cap ──────────────────────────────

test("worker: shuts down at agent_settled (not agent_end) and enforces the turn cap", async () => {
  const { default: omWorker } = await load("agent/index.ts");
  const dir = makeTempDir("om-worker-");
  try {
    withEnv(
      {
        OM_WORKER: "observer",
        OM_RESULT_PATH: join(dir, "r.result.json"),
        OM_MAX_TURNS: "2",
        OM_COST_PATH: undefined,
      },
      () => {
        const { pi, tools, handlers } = makeFakePi();
        omWorker(pi);
        assert.ok(tools.has("record_observations"));
        assert.ok(
          tools.has("finish_observations"),
          "observer needs a terminal acknowledgement tool",
        );
        assert.ok(
          handlers.has("agent_settled"),
          "must shut down at agent_settled",
        );
        assert.ok(
          !handlers.has("agent_end"),
          "must not shut down at agent_end (retries follow)",
        );

        let shutdowns = 0;
        const ctx = {
          shutdown: () => {
            shutdowns++;
          },
        };
        const turnEnd = handlers.get("turn_end")[0];
        turnEnd({ turnIndex: 0 }, ctx);
        assert.equal(shutdowns, 0);
        turnEnd({ turnIndex: 1 }, ctx);
        assert.equal(shutdowns, 1, "turn cap must cut off the worker");
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("observer tool: boot result is incomplete and finish_observations acks", async () => {
  const { registerObserverTool } = await load("agent/observer/tool.ts");
  const { readObserverResult } = await load("src/spawn/runs.ts");
  const dir = makeTempDir("om-obs-tool-");
  try {
    const path = join(dir, "r.result.json");
    const { pi, tools } = makeFakePi();
    registerObserverTool(pi, path);
    // Boot file is valid but explicitly incomplete, so exit-0 alone cannot commit it.
    assert.equal(readObserverResult(path).completed, false);
    await tools.get("record_observations").execute("1", {
      observations: [{ timestamp: "2026-05-02 10:00", content: "one" }],
    });
    assert.equal(readObserverResult(path).completed, false);
    assert.equal(readObserverResult(path).observations.length, 1);
    const finish = await tools.get("finish_observations").execute("2", {});
    assert.equal(finish.terminate, true);
    assert.equal(readObserverResult(path).completed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("safety: async workers cannot commit after a branch/gate change", async () => {
  const observer = readFileSync(
    fileURLToPath(new URL("src/hooks/observer-trigger.ts", VENDOR)),
    "utf-8",
  );
  assert.ok(
    observer.includes("result.completed"),
    "observer must require the completion ack",
  );
  assert.ok(
    observer.includes("controller.signal.aborted"),
    "observer must check the abort signal",
  );
  assert.ok(
    observer.includes("runtime.generation !== generation"),
    "observer must check the dispatch epoch",
  );
  assert.ok(
    observer.includes("entryIndexForId(branch, coversUpToId)"),
    "observer must verify the source anchor",
  );
  const consolidator = readFileSync(
    fileURLToPath(new URL("src/hooks/consolidator-trigger.ts", VENDOR)),
    "utf-8",
  );
  assert.ok(
    consolidator.includes("runtime.generation !== generation"),
    "consolidator must check the dispatch epoch",
  );
  assert.ok(
    consolidator.includes("readConsolidationAck"),
    "consolidator must require the durable ack",
  );
  const index = readFileSync(
    fileURLToPath(new URL("src/index.ts", VENDOR)),
    "utf-8",
  );
  assert.ok(
    /session_tree[\s\S]*?generation \+= 1/.test(index),
    "session_tree must bump the epoch",
  );
  assert.ok(
    /session_tree[\s\S]*?abortAllWorkers/.test(index),
    "session_tree must abort in-flight workers",
  );
});

test("consolidator slot: abort keeps exclusivity and release is identity-guarded", async () => {
  const { Runtime } = await load("src/runtime.ts");
  const runtime = new Runtime();
  const first = new AbortController();
  runtime.consolidatorInFlight = true;
  runtime.consolidatorController = first;

  // A session switch / `/om off` aborts the process but must NOT free the slot: the worker
  // subprocess can outlive the abort by the kill escalation, and a second run would clobber
  // the first one's acknowledged topic writes.
  runtime.abortAllWorkers();
  assert.equal(
    first.signal.aborted,
    true,
    "abortAllWorkers must abort the controller",
  );
  assert.equal(
    runtime.consolidatorInFlight,
    true,
    "slot stays held until the process settles",
  );
  assert.equal(
    runtime.consolidatorController,
    first,
    "abortAllWorkers must not clear the controller",
  );

  // Model a late `finally` from a superseded run after a (theoretically) newer controller was
  // installed: it must not clear the current slot.
  const second = new AbortController();
  runtime.consolidatorController = second;
  runtime.releaseConsolidator(first);
  assert.equal(
    runtime.consolidatorInFlight,
    true,
    "late finally must not clear the new slot",
  );
  assert.equal(runtime.consolidatorController, second);
  runtime.releaseConsolidator(second);
  assert.equal(
    runtime.consolidatorInFlight,
    false,
    "the active run releases its own slot",
  );
  assert.equal(runtime.consolidatorController, undefined);
});

test("safety: consolidator run paths are pinned to the dispatch-time memory root", async () => {
  const source = readFileSync(
    fileURLToPath(new URL("src/hooks/consolidator-trigger.ts", VENDOR)),
    "utf-8",
  );
  const capture = "const memoryRoot = runtime.memoryRoot";
  const start = source.indexOf("async function dispatchConsolidator");
  const captureAt = source.indexOf(capture, start);
  assert.ok(
    start >= 0 && captureAt > start,
    "dispatchConsolidator must capture the memory root",
  );
  const afterCapture = source.slice(captureAt + capture.length);
  assert.ok(
    !/runtime\.memoryRoot/.test(
      afterCapture.slice(0, afterCapture.indexOf("\n}\n")),
    ),
    "per-run paths must use the captured root, not the live runtime.memoryRoot",
  );
  assert.ok(
    source.includes("releaseConsolidator(controller)"),
    "slot release must be identity-guarded",
  );
});

test("observers: a later success cannot jump an earlier uncommitted chunk", async () => {
  const { Runtime } = await load("src/runtime.ts");
  const { commitContiguousObservers } = await load(
    "src/hooks/observer-trigger.ts",
  );
  const runtime = new Runtime();
  runtime.enabled = true;
  runtime.memoryRoot = "/tmp/om-unused";
  const A = "entry-A";
  const B = "entry-B";
  // Branch: A is a source anchor, then a gap, then B.
  const branch = [
    {
      type: "message",
      id: A,
      message: { role: "user", content: [{ type: "text", text: "a" }] },
    },
    {
      type: "message",
      id: "entry-gap",
      message: { role: "assistant", content: [{ type: "text", text: "g" }] },
    },
    {
      type: "message",
      id: B,
      message: { role: "user", content: [{ type: "text", text: "b" }] },
    },
  ];
  const ctx = {
    hasUI: false,
    sessionManager: { getBranch: () => branch },
    getContextUsage: () => ({ tokens: 0 }),
  };
  const appended = [];
  const pi = { appendEntry: (type, data) => appended.push({ type, data }) };
  const pending = (runId, afterEntryId, coversUpToId, result) => ({
    runId,
    controller: new AbortController(),
    afterEntryId,
    coversUpToId,
    lastEntryTimestamp: undefined,
    sliceTokens: 10,
    ...(result ? { result } : {}),
  });

  // Head (seq 0) is still running; a later completed empty chunk (seq 1) must be retained, not committed.
  runtime.pendingObservers.set(0, pending("r0", undefined, A));
  runtime.pendingObservers.set(1, pending("r1", A, B, { observations: [] }));
  runtime.committedFrontierId = undefined;
  commitContiguousObservers(pi, runtime, ctx);
  assert.deepEqual(
    appended,
    [],
    "a later success must not jump the missing head",
  );
  assert.equal(runtime.committedFrontierId, undefined);

  // The head completes: both commit in order; the empty chunk writes a durable coverage marker.
  runtime.pendingObservers.get(0).result = { observations: [] };
  commitContiguousObservers(pi, runtime, ctx);
  assert.deepEqual(
    appended.map((entry) => entry.data.coversUpToId),
    [A, B],
  );
  assert.ok(
    appended.every((entry) => entry.type === "om2.coverage.committed"),
    "zero-observation chunks must leave a durable coverage marker",
  );
  assert.equal(runtime.committedFrontierId, B);
  assert.equal(runtime.pendingObservers.size, 0);

  // A non-empty chunk commits as an observation entry.
  runtime.pendingObservers.set(
    0,
    pending("r2", undefined, A, {
      observations: [{ timestamp: "2026-05-02 10:00", content: "x" }],
    }),
  );
  runtime.committedFrontierId = undefined;
  runtime.nextObserverSequence = 0;
  commitContiguousObservers(pi, runtime, ctx);
  assert.equal(appended.at(-1).type, "om2.observations.recorded");
  assert.equal(appended.at(-1).data.observations.length, 1);
});

test("compaction hook falls back to Pi when coverage would retain an oversized raw tail", async () => {
  const { registerCompactionHook, isUsableMemoryTail } = await load(
    "src/hooks/compaction-hook.ts",
  );
  const { Runtime } = await load("src/runtime.ts");
  const { OM_COVERAGE_COMMITTED } = await load("src/ledger/types.ts");
  const runtime = new Runtime();
  runtime.enabled = true;
  runtime.config = { ...runtime.config, tailTokens: 20, chunkTokens: 10 };
  runtime.ensureConfig = () => {};
  const raw = (id, text) => ({
    type: "message",
    id,
    message: { role: "user", content: [{ type: "text", text }] },
  });
  const branch = [
    raw("A", "covered"),
    raw("B", "unobserved ".repeat(4000)),
    raw("C", "recent"),
    {
      type: "custom",
      id: "covered-marker",
      customType: OM_COVERAGE_COMMITTED,
      data: { coversUpToId: "A" },
    },
  ];
  let hook;
  registerCompactionHook(
    {
      on(name, handler) {
        if (name === "session_before_compact") hook = handler;
      },
    },
    runtime,
  );
  assert.equal(isUsableMemoryTail(undefined, 20, 10), false);
  assert.equal(isUsableMemoryTail(30, 20, 10), true);
  assert.equal(isUsableMemoryTail(31, 20, 10), false);
  const result = await hook(
    {
      preparation: {
        firstKeptEntryId: "C",
        tokensBefore: 12000,
        settings: { keepRecentTokens: 20 },
      },
    },
    { hasUI: false, sessionManager: { getBranch: () => branch } },
  );
  assert.equal(
    result,
    undefined,
    "native compaction must summarize the uncovered backlog",
  );
  assert.equal(runtime.compactHookInFlight, false);
});

test("compaction: declines without coverage and never cuts past the committed frontier", async () => {
  const { snapCutoff } = await load("src/hooks/compaction-hook.ts");
  const raw = (id, text) => ({
    type: "message",
    id,
    message: { role: "user", content: [{ type: "text", text }] },
  });
  const recorded = (id, coversUpToId) => ({
    type: "custom",
    id,
    customType: "om2.observations.recorded",
    data: {
      observations: [{ timestamp: `${id}-ts`, content: "x", tokenCount: 5 }],
      coversUpToId,
    },
  });

  // Only A is committed. A proposed cutoff at B must snap back to A's boundary (first source after A).
  const gapBranch = [
    raw("A", "a"),
    recorded("rec-A", "A"),
    raw("mid", "m"),
    raw("B", "b"),
  ];
  const snapped = snapCutoff(gapBranch, "B", 0, "A");
  assert.equal(
    snapped.firstKeptId,
    "mid",
    "must stop at the last committed boundary",
  );
  assert.notEqual(snapped.tail, undefined);

  // No committed boundary at/before the frontier -> no safe snap (the hook then declines).
  const unsafe = snapCutoff([raw("A", "a"), raw("B", "b")], "B", 0, "A");
  assert.equal(
    unsafe.tail,
    undefined,
    "no committed boundary means the custom summary must decline",
  );
});

test("consolidator ack: zero writes is only authorized by an explicit discard", async () => {
  const { ackAuthorizesDrop } = await load("src/hooks/consolidator-trigger.ts");
  const { readConsolidationAck } = await load("src/spawn/runs.ts");
  const dir = makeTempDir("om-ack-policy-");
  try {
    assert.equal(
      ackAuthorizesDrop({
        observationTimestamps: [],
        durableWrites: 0,
        discardedAll: false,
        completedAt: "",
      }),
      false,
    );
    assert.equal(
      ackAuthorizesDrop({
        observationTimestamps: [],
        durableWrites: 1,
        discardedAll: false,
        completedAt: "",
      }),
      true,
    );
    assert.equal(
      ackAuthorizesDrop({
        observationTimestamps: [],
        durableWrites: 0,
        discardedAll: true,
        completedAt: "",
      }),
      true,
    );
    // A non-integer durableWrites count is rejected when the ack is read.
    const path = join(dir, "ack.json");
    writeFileSync(
      path,
      JSON.stringify({
        observationTimestamps: ["a"],
        durableWrites: 1.5,
        discardedAll: false,
        completedAt: "now",
      }),
    );
    assert.equal(readConsolidationAck(path), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cost: recorded once per runId and suppressed on shutdown", async () => {
  const { recordWorkerCost } = await load("src/hooks/observer-trigger.ts");
  const { writeWorkerCost, runCostPath } = await load("src/spawn/runs.ts");
  const { Runtime } = await load("src/runtime.ts");
  const dir = makeTempDir("om-cost-dedupe-");
  try {
    const root = join(dir, ".memory", "sess-1");
    const runtime = new Runtime();
    runtime.enabled = true;
    const appended = [];
    const pi = { appendEntry: (type, data) => appended.push({ type, data }) };
    const ctx = { sessionManager: { getEntries: () => [] } };
    writeWorkerCost(runCostPath(root, "obs-fixed"), { costUsd: 0.01 });
    recordWorkerCost(pi, runtime, ctx, "observer", "obs-fixed", root);
    recordWorkerCost(pi, runtime, ctx, "observer", "obs-fixed", root);
    assert.equal(appended.length, 1, "same runId must not double-count cost");
    assert.equal(appended[0].type, "om2.cost");

    // Shutdown suppresses appends and notifications against a dead context.
    runtime.shuttingDown = true;
    writeWorkerCost(runCostPath(root, "obs-after-shutdown"), { costUsd: 0.02 });
    recordWorkerCost(pi, runtime, ctx, "observer", "obs-after-shutdown", root);
    assert.equal(appended.length, 1, "no cost append after shutdown");
    let notified = 0;
    runtime.queueToast("om: should be suppressed", "info", () => {
      notified++;
    });
    assert.equal(notified, 0, "no toast after shutdown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run ids are UUID-based, not pid+counter", () => {
  for (const rel of [
    "src/hooks/observer-trigger.ts",
    "src/hooks/consolidator-trigger.ts",
  ]) {
    const source = readFileSync(fileURLToPath(new URL(rel, VENDOR)), "utf-8");
    assert.ok(
      source.includes("randomUUID"),
      `${rel} must use randomUUID for run ids`,
    );
    assert.ok(
      !/process\.pid\}-\$\{runCounter\}/.test(source),
      `${rel} must not use pid+counter run ids`,
    );
  }
});

// ── Ledger: namespace isolation + fold/projection ─────────────────────────────

test("ledger: legacy om.* entries are ignored, om2.* entries fold", async () => {
  const { foldLedger, visibleProjection } = await load("src/ledger/index.ts");
  const legacy = {
    type: "custom",
    id: "legacy-1",
    customType: "om.observations.recorded",
    data: {
      observations: [
        {
          timestamp: "2026-05-02 10:00",
          content: "old",
          id: "hash",
          relevance: "low",
          tokenCount: 10,
        },
      ],
      coversUpToId: "raw-1",
    },
  };
  const current = {
    type: "custom",
    id: "new-1",
    customType: "om2.observations.recorded",
    data: {
      observations: [
        { timestamp: "2026-05-02T10:00:01", content: "new", tokenCount: 10 },
      ],
      coversUpToId: "raw-1",
    },
  };
  const folded = foldLedger([legacy, current]);
  assert.deepEqual(
    folded.observations.map((o) => o.content),
    ["new"],
  );

  const legacyCompaction = {
    type: "compaction",
    id: "c-1",
    details: {
      type: "om.folded",
      version: 1,
      observations: [
        { timestamp: "2026-05-02 10:00", content: "old", tokenCount: 10 },
      ],
    },
  };
  assert.deepEqual(visibleProjection([legacyCompaction]).observations, []);
});

test("ledger: fold applies drops and projection snaps to the cutoff", async () => {
  const { foldLedger, buildCompactionProjection } = await load(
    "src/ledger/index.ts",
  );
  const recorded = (id, observations, coversUpToId) => ({
    type: "custom",
    id,
    customType: "om2.observations.recorded",
    data: { observations, coversUpToId },
  });
  const dropped = (id, observationTimestamps, coversUpToId) => ({
    type: "custom",
    id,
    customType: "om2.observations.dropped",
    data: { observationTimestamps, coversUpToId },
  });
  const raw = (id, text) => ({
    type: "message",
    id,
    message: { role: "user", content: [{ type: "text", text }] },
  });
  const obs = (timestamp, content) => ({ timestamp, content, tokenCount: 10 });

  const branch = [
    raw("raw-1", "aaaa"),
    recorded("rec-1", [obs("2026-05-02T10:00:01", "one")], "raw-1"),
    dropped("drop-1", ["2026-05-02T10:00:01"], "raw-1"),
    raw("raw-2", "bbbb"),
    recorded("rec-2", [obs("2026-05-02T10:05:00", "two")], "raw-2"),
    raw("raw-3", "cccc"),
  ];
  const folded = foldLedger(branch);
  assert.deepEqual(
    folded.activeObservations.map((o) => o.content),
    ["two"],
  );

  const projection = buildCompactionProjection(branch, "raw-3");
  assert.deepEqual(
    projection.observations.map((o) => o.content),
    ["two"],
  );
  assert.equal(projection.details.type, "om2.folded");
});

test("ledger: chunk slicing never splits a tool call from its result", async () => {
  const { selectSourceSlice } = await load("src/ledger/index.ts");
  const raw = (id, role, text) => ({
    type: "message",
    id,
    message: { role, content: [{ type: "text", text }] },
  });
  // The assistant tool call is small; the tool result is large. The budget is exceeded AT the
  // tool result (not a valid cut point), so the slice must extend to keep the pair together.
  const assistantTool = {
    type: "message",
    id: "a-1",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "small" },
        { type: "toolCall", id: "call-1", name: "bash", arguments: {} },
      ],
    },
  };
  const toolResult = {
    type: "message",
    id: "t-1",
    message: {
      role: "toolResult",
      toolName: "bash",
      content: [{ type: "text", text: "y".repeat(8000) }],
    },
  };
  const branch = [
    raw("u-1", "user", "z".repeat(100)),
    assistantTool,
    toolResult,
    raw("u-2", "user", "next"),
  ];
  const slice = selectSourceSlice(branch, undefined, 1000);
  assert.deepEqual(
    slice.entries.map((entry) => entry.id),
    ["u-1", "a-1", "t-1"],
    "tool call and result stay together",
  );
});

test("ids: assigns unique second-resolution ids with a fallback anchor", async () => {
  const { assignObservationTimestamps } = await load("src/ids.ts");
  const assigned = assignObservationTimestamps(
    [
      { timestamp: "2026-05-02 10:00", content: "a" },
      { timestamp: "2026-05-02 10:00", content: "b" },
      { timestamp: "not-a-time", content: "c" },
    ],
    // A local-time anchor so the expected id does not depend on the machine timezone.
    { used: ["2026-05-02T10:00:00"], fallbackAnchor: "2026-05-02 11:00" },
  );
  assert.equal(assigned[0].timestamp, "2026-05-02T10:00:00.01");
  assert.equal(assigned[1].timestamp, "2026-05-02T10:00:00.02");
  assert.equal(assigned[2].timestamp, "2026-05-02T11:00:00");
  assert.ok(assigned.every((o) => o.tokenCount > 0));
});

test("pool: overflow keeps the newest observations within target", async () => {
  const { selectPromotionOverflow } = await load("src/ledger/pool.ts");
  const obs = (n, tokens) => ({
    timestamp: `2026-05-02T10:00:0${n}`,
    content: `c${n}`,
    tokenCount: tokens,
  });
  const { promote, keptTokens } = selectPromotionOverflow(
    [obs(1, 10), obs(2, 10), obs(3, 10)],
    20,
  );
  assert.deepEqual(
    promote.map((o) => o.content),
    ["c1"],
  );
  assert.equal(keptTokens, 20);
});

test("render: summary includes journey, map, and chronological observations", async () => {
  const { renderSummary } = await load("src/ledger/render.ts");
  const summary = renderSummary("journey text", "## Memory map\n- `x.md`", [
    { timestamp: "2026-05-02T10:05:00", content: "later", tokenCount: 1 },
    { timestamp: "2026-05-02T10:00:00", content: "earlier", tokenCount: 1 },
  ]);
  assert.ok(summary.includes("## Journey"));
  assert.ok(summary.includes("## Memory map"));
  const observationsIndex = summary.indexOf("## Observations");
  assert.ok(summary.indexOf("earlier") < summary.indexOf("later"));
  assert.ok(observationsIndex > 0);
});

// ── Memory paths: symlink-safe containment ────────────────────────────────────

test("memory paths: resolveWithinMemory rejects lexical and symlink escapes", async () => {
  const { resolveWithinMemory, listTopics } = await load("src/memory/paths.ts");
  const cwd = makeTempDir("om-paths-");
  try {
    const root = join(cwd, ".memory", "sess-1");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "ok.md"), "---\ntitle: Ok\n---\nbody");

    assert.ok(resolveWithinMemory(root, "ok.md"));
    assert.ok(resolveWithinMemory(root, "nested/new.md"));
    assert.equal(resolveWithinMemory(root, "../escape.md"), undefined);
    assert.equal(resolveWithinMemory(root, "/etc/passwd"), undefined);

    // A symlink inside the sandbox that points outside must not be traversable.
    const outside = join(cwd, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.md"), "secret");
    let symlinkCreated = false;
    try {
      symlinkSync(outside, join(root, "link"), "dir");
      symlinkCreated = true;
    } catch {
      // Windows without developer mode cannot create symlinks; skip that half.
    }
    if (symlinkCreated) {
      assert.equal(
        resolveWithinMemory(root, "link/secret.md"),
        undefined,
        "symlink escape must be rejected",
      );
    }
    assert.deepEqual(
      listTopics(root).map((topic) => topic.filename),
      ["ok.md"],
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Consolidator tools: scoping + durable ack ─────────────────────────────────

test("consolidator tools: scoped file IO and durable acknowledgement", async () => {
  const { registerConsolidatorTools } = await load(
    "agent/consolidator/tools.ts",
  );
  const {
    readConsolidationAck,
    runBatchPath,
    runResultPath,
    writeConsolidationBatch,
  } = await load("src/spawn/runs.ts");
  const cwd = makeTempDir("om-cons-");
  try {
    const root = join(cwd, ".memory", "sess-1");
    const batchPath = runBatchPath(root, "c1");
    const resultPath = runResultPath(root, "c1");
    const { pi, tools } = makeFakePi();
    registerConsolidatorTools(pi, root, { batchPath, resultPath });
    assert.ok(tools.has("finish_consolidation"));

    const write = await tools
      .get("write")
      .execute("1", { path: "auth.md", content: "body" });
    assert.ok(write.content[0].text.includes("Wrote auth.md"));
    const read = await tools.get("read").execute("2", { path: "auth.md" });
    assert.ok(read.content[0].text.includes("body"));

    const escape = await tools
      .get("write")
      .execute("3", { path: "../escape.md", content: "x" });
    assert.ok(escape.content[0].text.includes("escapes .memory/"));
    assert.equal(existsSync(join(cwd, "escape.md")), false);

    // No ack before the terminal tool.
    assert.equal(readConsolidationAck(resultPath), undefined);
    writeConsolidationBatch(batchPath, {
      observationTimestamps: ["2026-05-02T10:00:01"],
    });
    const ackResult = await tools.get("finish_consolidation").execute("4", {});
    assert.equal(ackResult.terminate, true);
    const ack = readConsolidationAck(resultPath);
    assert.deepEqual(ack.observationTimestamps, ["2026-05-02T10:00:01"]);
    assert.equal(ack.durableWrites, 1);
    assert.equal(ack.discardedAll, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("consolidator tools: refuse to ack with no write and no discard", async () => {
  const { registerConsolidatorTools } = await load(
    "agent/consolidator/tools.ts",
  );
  const { readConsolidationAck, runBatchPath, runResultPath } =
    await load("src/spawn/runs.ts");
  const cwd = makeTempDir("om-cons-empty-");
  try {
    const root = join(cwd, ".memory", "sess-1");
    const resultPath = runResultPath(root, "c1");
    const { pi, tools } = makeFakePi();
    registerConsolidatorTools(pi, root, {
      batchPath: runBatchPath(root, "c1"),
      resultPath,
    });
    const result = await tools.get("finish_consolidation").execute("1", {});
    assert.ok(result.content[0].text.includes("no durable write"));
    assert.equal(readConsolidationAck(resultPath), undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Spawn: argv/env isolation and portable pi resolution ──────────────────────

test("spawn: worker argv disables discovery and loads only the worker extension", async () => {
  const { buildWorkerArgv, AGENT_EXTENSION_PATH } = await load(
    "src/spawn/launch.ts",
  );
  const argv = buildWorkerArgv({
    model: {
      provider: "opencode-go",
      id: "deepseek-v4.1-flash",
      thinking: "low",
    },
    sessionName: "om-observer-x",
  });
  for (const flag of [
    "--no-extensions",
    "--no-builtin-tools",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
  ]) {
    assert.ok(argv.includes(flag), `missing ${flag}`);
  }
  assert.equal(
    argv[argv.indexOf("--model") + 1],
    "opencode-go/deepseek-v4.1-flash",
  );
  assert.equal(argv[argv.indexOf("--thinking") + 1], "low");
  assert.equal(argv[argv.indexOf("-e") + 1], AGENT_EXTENSION_PATH);
  assert.ok(AGENT_EXTENSION_PATH.endsWith(join("agent", "index.ts")));
  assert.equal(
    argv.at(-1),
    "-p",
    "large initial messages must not be included in argv",
  );
});

test("spawn: worker env carries turn/timeout bounds and the batch path", async () => {
  const { buildWorkerEnv } = await load("src/spawn/launch.ts");
  const { runBatchPath } = await load("src/spawn/runs.ts");
  const env = buildWorkerEnv("consolidator", {
    memoryRoot: "/proj/.memory/sess-1",
    runId: "c1",
    maxTurns: 40,
    timeoutMs: 600000,
  });
  assert.equal(env.OM_WORKER, "consolidator");
  assert.equal(env.OM_MAX_TURNS, "40");
  assert.equal(env.OM_TIMEOUT_MS, "600000");
  assert.equal(env.OM_BATCH_PATH, runBatchPath("/proj/.memory/sess-1", "c1"));
  assert.equal(
    env.OM_CHUNK_PATH,
    undefined,
    "the chunk travels through stdin, not env",
  );
});

test("spawn: pi resolution never adopts the test runner as pi", async () => {
  const { resolvePiBinary } = await load("src/spawn/launch.ts");
  const resolved = resolvePiBinary();
  const adoptedTestRunner =
    resolved.command === process.execPath &&
    resolved.baseArgs.length > 0 &&
    resolved.baseArgs[0].endsWith("observational-memory.test.mjs");
  assert.equal(
    adoptedTestRunner,
    false,
    "must not spawn the test script as pi",
  );
  // With the package installed, it resolves the package CLI (or falls back to PATH).
  if (resolved.command === process.execPath) {
    assert.match(resolved.baseArgs[0], /cli\.(?:mjs|cjs|js)$/);
  } else {
    assert.equal(resolved.command, "pi");
  }
});

test("spawn: kill escalation uses real process state, not proc.killed", async () => {
  // Source-level guard: the fix replaced `proc.killed` with exitCode/signalCode checks.
  const source = readFileSync(
    fileURLToPath(new URL("src/spawn/launch.ts", VENDOR)),
    "utf-8",
  );
  assert.ok(
    source.includes("hasExited"),
    "escalation must check real process state",
  );
  assert.ok(
    source.includes("killStarted"),
    "escalation must be idempotent (one kill timer)",
  );
  assert.ok(
    /proc\.kill\("SIGKILL"\)/.test(source),
    "escalation must reach SIGKILL",
  );
  assert.ok(
    source.includes("timeoutMs"),
    "worker spawn must support a wall-clock timeout",
  );
  assert.ok(
    !/if\s*\(\s*!\s*proc\.killed\s*\)/.test(source),
    "must not gate escalation on proc.killed",
  );
});

test("spawn: an already-aborted signal returns interrupted without side effects", async () => {
  const { spawnWorker } = await load("src/spawn/launch.ts");
  const cwd = makeTempDir("om-spawn-abort-");
  try {
    const controller = new AbortController();
    controller.abort();
    const memoryRoot = join(cwd, ".memory", "sess-1");
    const exit = await spawnWorker({
      argv: ["definitely-not-a-real-binary-xyz"],
      cwd: memoryRoot,
      env: {},
      signal: controller.signal,
    });
    assert.equal(exit.code, null);
    assert.ok(exit.stderr.includes("aborted before spawn"));
    assert.equal(
      existsSync(memoryRoot),
      false,
      "must not create the memory dir for an abandoned request",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("spawn: delivers a large Unicode prompt intact through stdin, not argv", async () => {
  const { spawnWorker } = await load("src/spawn/launch.ts");
  const cwd = makeTempDir("om-spawn-stdin-");
  const prompt = "Histórico ação 🚀\n--model not-a-flag\n".repeat(10000);
  const program = `
    const { createHash } = require('node:crypto');
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => text += chunk);
    process.stdin.on('end', () => process.stderr.write(JSON.stringify({
      length: text.length, hash: createHash('sha256').update(text).digest('hex')
    })));
  `;
  try {
    const exit = await spawnWorker({
      argv: [process.execPath, "-e", program],
      cwd,
      env: process.env,
      prompt,
      timeoutMs: 10000,
    });
    assert.equal(exit.code, 0, exit.stderr);
    assert.deepEqual(JSON.parse(exit.stderr), {
      length: prompt.length,
      hash: createHash("sha256").update(prompt).digest("hex"),
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("spawn: early worker exit with a large input does not leak EPIPE", async () => {
  const { spawnWorker } = await load("src/spawn/launch.ts");
  const cwd = makeTempDir("om-spawn-stdin-exit-");
  try {
    const exit = await spawnWorker({
      argv: [process.execPath, "-e", "process.exit(2)"],
      cwd,
      env: process.env,
      prompt: "x".repeat(1000000),
      timeoutMs: 10000,
    });
    assert.notEqual(exit.code, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("spawn: worker stderr capture is bounded to a tail", async () => {
  const { spawnWorker } = await load("src/spawn/launch.ts");
  const cwd = makeTempDir("om-spawn-stderr-");
  try {
    const exit = await spawnWorker({
      argv: [
        process.execPath,
        "-e",
        "process.stderr.write('x'.repeat(200000)); process.exit(3)",
      ],
      cwd,
      env: process.env,
    });
    assert.equal(exit.code, 3);
    assert.ok(
      exit.stderr.length <= 64 * 1024,
      `stderr should be capped, got ${exit.stderr.length}`,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── Shutdown lifecycle: bounded drain of tracked workers ──────────────────────

test("perf: footer gauge/cost recompute paths are gone (status stays on-demand)", async () => {
  const { Runtime } = await load("src/runtime.ts");
  const { StatusController } = await load("src/ui/status-controller.ts");
  const runtime = new Runtime();
  assert.equal(
    typeof runtime.refreshFooterGauges,
    "undefined",
    "the no-op footer gauge recompute must be removed",
  );
  assert.equal(
    typeof runtime.refreshCost,
    "undefined",
    "the no-op footer cost recompute must be removed",
  );
  const controller = new StatusController();
  assert.equal(typeof controller.setGauges, "undefined");
  assert.equal(typeof controller.setCost, "undefined");
  const indexSource = readFileSync(
    fileURLToPath(new URL("src/index.ts", VENDOR)),
    "utf-8",
  );
  assert.ok(!indexSource.includes("refreshFooterGauges"));
  assert.ok(!indexSource.includes("refreshCost"));
});

test("shutdown: session_shutdown awaits a bounded worker drain", () => {
  const source = readFileSync(
    fileURLToPath(new URL("src/index.ts", VENDOR)),
    "utf-8",
  );
  assert.ok(
    /session_shutdown[\s\S]*?abortAllWorkers[\s\S]*?whenWorkersIdle\(SHUTDOWN_DRAIN_MS\)/.test(
      source,
    ),
    "shutdown must abort then await the tracked worker drain",
  );
  assert.ok(
    source.includes("SHUTDOWN_DRAIN_MS"),
    "the drain must be bounded so Pi cannot hang",
  );
});

test("shutdown: bounded drain awaits tracked workers after the pipeline is aborted", async () => {
  const { Runtime } = await load("src/runtime.ts");
  const runtime = new Runtime();
  let releaseWorker;
  let workerSettled = false;
  const workerLife = new Promise((resolve) => {
    releaseWorker = resolve;
  }).then(() => {
    workerSettled = true;
  });
  runtime.trackWorkerTask(workerLife);

  // A dispatched observer lives in the ordered pipeline map; abortAllWorkers drops it, but the
  // drain must still await the tracked process task.
  runtime.pendingObservers.set(0, {
    runId: "obs-1",
    controller: new AbortController(),
    afterEntryId: undefined,
    coversUpToId: "A",
    lastEntryTimestamp: undefined,
    sliceTokens: 10,
  });
  runtime.abortAllWorkers();
  assert.equal(
    runtime.pendingObservers.size,
    0,
    "abort drops the pipeline job",
  );

  let drained;
  const drain = runtime.whenWorkersIdle(1000).then((idle) => {
    drained = idle;
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(workerSettled, false, "drain must wait for the tracked worker");
  assert.equal(drained, undefined);
  releaseWorker();
  await drain;
  assert.equal(workerSettled, true);
  assert.equal(drained, true);
});

test("shutdown: whenWorkersIdle reports a timeout when a worker never settles", async () => {
  const { Runtime } = await load("src/runtime.ts");
  const runtime = new Runtime();
  runtime.trackWorkerTask(new Promise(() => {}));
  const started = Date.now();
  assert.equal(await runtime.whenWorkersIdle(25), false);
  assert.ok(Date.now() - started >= 20, "must actually wait out the bound");
});

test(
  "spawn: escalates a SIGTERM-stubborn worker to SIGKILL",
  {
    skip: process.platform === "win32" ? "POSIX signal semantics only" : false,
  },
  async () => {
    const { spawnWorker, KILL_ESCALATION_MS } = await load(
      "src/spawn/launch.ts",
    );
    const cwd = makeTempDir("om-spawn-stubborn-");
    try {
      const controller = new AbortController();
      const pending = spawnWorker({
        argv: [
          process.execPath,
          "-e",
          "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
        ],
        cwd,
        env: process.env,
        signal: controller.signal,
        timeoutMs: 30_000,
      });
      // Give the child time to install its SIGTERM handler before aborting.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const started = Date.now();
      controller.abort();
      const exit = await pending;
      const elapsed = Date.now() - started;
      assert.equal(
        exit.signal,
        "SIGKILL",
        `expected SIGKILL escalation, got ${JSON.stringify(exit)}`,
      );
      assert.ok(
        elapsed >= KILL_ESCALATION_MS - 100,
        `escalation should wait ~${KILL_ESCALATION_MS}ms, took ${elapsed}ms`,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);
