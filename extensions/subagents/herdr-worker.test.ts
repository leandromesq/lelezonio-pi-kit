/**
 * Session-lifecycle tests for Herdr-native subagent workers: a stub WorkerWorkspaceController
 * (records pane opens/prompts/keys/focus/closes) with real temp session/rollout files and
 * fast polls drives the whole run loop — completion, close policy, take-over (running and
 * settled-resume), send restart, cancellation, codex queueing, fallback, races and dispose.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Cause, Effect, Exit, Scope, Stream } from "effect";
import type {
  WorkerLaunchOptions,
  WorkerWorkspaceController,
} from "../shared/herdr-workspace.ts";
import {
  makeHerdrWorkerSession,
  resetHerdrWorkerDepsForTests,
  setHerdrWorkerDepsForTests,
  trySpawnHerdrWorker,
  type HerdrWorkerDeps,
} from "./src/backends/herdr-worker.ts";
import type { SubagentSession } from "./src/backend.ts";
import type { ParentContext, SpawnTask, SubagentEvent } from "./src/domain.ts";

const DIR = path.join(os.tmpdir(), `herdr-worker-session-${process.pid}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --- stub workspace -----------------------------------------------------------------

interface StubWorkspace {
  controller: WorkerWorkspaceController;
  opened: Array<WorkerLaunchOptions>;
  prompts: string[];
  keys: string[][];
  closed: string[];
  focused: string[];
  states: Array<{ pane: string; state: string }>;
  failOpen: boolean;
  available: boolean;
  agentState: () => string | undefined;
}

function stubWorkspace(
  agentState: () => string | undefined = () => "working",
): StubWorkspace {
  const ws: StubWorkspace = {
    opened: [],
    prompts: [],
    keys: [],
    closed: [],
    focused: [],
    states: [],
    failOpen: false,
    available: true,
    agentState,
    controller: undefined as unknown as WorkerWorkspaceController,
  };
  let nextPane = 0;
  const controller: WorkerWorkspaceController = {
    available: () => ws.available,
    ensureWorkspace: async () => "w1",
    async openWorker(options) {
      if (ws.failOpen) return undefined;
      ws.opened.push(options);
      const paneId = `w1:p${++nextPane}`;
      return {
        paneId,
        category: "subagents",
        tabId: "w1:t1",
        workspaceId: "w1",
        run: async () => {},
        sendKeys: async (...keys) => {
          ws.keys.push(keys);
        },
        rename: async () => {},
        submitText: async (text) => {
          ws.prompts.push(text);
        },
        reportState: async (state, message) => {
          ws.states.push({ pane: paneId, state: `state:${state}` });
        },
        getAgentState: async () => ws.agentState(),
        reportMetadata: async () => {},
        focus: async () => {
          ws.focused.push(paneId);
        },
        close: async () => {
          ws.closed.push(paneId);
        },
      };
    },
    openObserver: async () => undefined,
    focusWorkspace: async () => {},
    dispose: async () => {},
    workspaceId: "w1",
  };
  ws.controller = controller;
  return ws;
}

function testDeps(
  ws: StubWorkspace,
  root = DIR,
  extra: Partial<HerdrWorkerDeps> = {},
): HerdrWorkerDeps {
  return {
    workspace: () => ws.controller,
    launcherPath: () => path.join(root, "launcher", "worker-launcher.mjs"),
    specDirRoot: () => path.join(root, "specs"),
    piCliPath: async () => path.join(root, "pi-cli.js"),
    codexCliPath: async () => path.join(root, "codex.js"),
    sessionDirRoot: () => path.join(root, "sessions"),
    codexHome: () => path.join(root, "codex"),
    pollIntervalMs: 5,
    interruptFallbackMs: 40,
    livenessProbeEveryMs: undefined,
    ...extra,
  };
}

function parentCtx(overrides: Partial<ParentContext> = {}): ParentContext {
  return {
    parentCwd: "C:\\work\\proj",
    projectTrusted: true,
    parentSessionId: "019e16ea-bbb6-721d",
    ...overrides,
  };
}

function freshSessionRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "herdr-session-test-"));
}

function task(text: string, overrides: Partial<SpawnTask> = {}): SpawnTask {
  return {
    logicalId: "sa-3",
    prompt: text,
    title: "Refactor module",
    cwd: "C:\\work\\proj",
    parent: parentCtx(),
    ...overrides,
  };
}

/** Run a session in a fresh scope, collect its events, and let the caller
 * drive it; the scope closes (session finalizer) when the body resolves. */
async function withSession(
  kind: "pi" | "codex",
  deps: HerdrWorkerDeps,
  t: SpawnTask,
  body: (session: SubagentSession, events: SubagentEvent[]) => Promise<void>,
): Promise<void> {
  const program = Effect.scoped(
    Effect.gen(function* () {
      const session = yield* makeHerdrWorkerSession(kind, t, deps).pipe(
        Effect.mapError((error) => new Error(error.message)),
      );
      const events: SubagentEvent[] = [];
      yield* Effect.forkScoped(
        Stream.runForEach(session.events, (event) =>
          Effect.sync(() => events.push(event)),
        ).pipe(Effect.ignore),
      );
      yield* Effect.promise(() => body(session, events));
    }),
  );
  const exit = await Effect.runPromiseExit(program);
  if (!Exit.isSuccess(exit)) {
    console.error(
      "herdr-worker session failed:",
      JSON.stringify(
        exit,
        (key, value) => (value instanceof Error ? value.stack : value),
        2,
      ),
    );
  }
  assert.equal(Exit.isSuccess(exit), true, "session effect failed");
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await sleep(10);
  }
}

function settled(events: SubagentEvent[]) {
  const run = events.filter((e) => e._tag === "RunStarted");
  const settledEvents = events.filter((e) => e._tag === "RunSettled");
  return { run: run.length, settled: settledEvents.length };
}

/** The last pane-launch token is ALWAYS the spec path: the pane runs
 * `& node <launcher> <spec>` on Windows and `node <launcher> <spec>`
 * elsewhere, and the spec carries the real argv the launcher spawns. */
function launchSpecToken(launch: ReadonlyArray<string>): string {
  return launch[launch.length - 1];
}

/** The native session id the launcher pinned: the `--session-id` in the
 * initial spec (raw argv). pi writes its session file keyed to this id, and
 * run discovery matches the file head against it. */
function piNativeSessionId(ws: StubWorkspace): string {
  const launch = ws.opened[0]?.launch;
  assert.ok(launch, "the worker pane opened before the session file");
  const spec = readLaunchSpec(launchSpecToken(launch));
  const idx = spec.args.indexOf("--session-id");
  assert.ok(idx >= 0 && spec.args[idx + 1], "spec pins --session-id");
  return spec.args[idx + 1];
}

/** The pi session file for the live session: keyed to the pinned id. */
async function piSessionFile(
  ws: StubWorkspace,
  sessionDir: string,
): Promise<string> {
  const id = piNativeSessionId(ws);
  return path.join(sessionDir, `2026-01-01T00-00-00_${id}.jsonl`);
}

/** Parse the raw launch spec a pane-run launch token points at. */
function readLaunchSpec(token: string): {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
} {
  const specPath = token.replace(/^'([\s\S]*)'$/, "$1");
  return JSON.parse(fs.readFileSync(specPath, "utf8"));
}

// --- pi session file fixtures -------------------------------------------------------------

function piSessionLines(cwd: string, sessionId: string): string[] {
  return [
    JSON.stringify({ type: "session", id: sessionId, cwd }),
    JSON.stringify({
      type: "model_change",
      id: `m1-${sessionId}`,
      provider: "openai",
      modelId: "gpt-5.4",
    }),
  ];
}

function piUserLine(id: string, text: string): string {
  return JSON.stringify({
    type: "message",
    id,
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

function piAssistantLine(
  id: string,
  text: string,
  stopReason = "stop",
): string {
  return JSON.stringify({
    type: "message",
    id,
    // The REAL session format carries stopReason AND usage on the assistant
    // MESSAGE, not the entry top level.
    message: {
      role: "assistant",
      stopReason,
      usage: { totalTokens: 900, input: 400, output: 500 },
      content: [{ type: "text", text }],
    },
  });
}

// --- codex rollout fixture -----------------------------------------------------------------

function cxSessionMeta(cwd: string, id: string): string {
  return JSON.stringify({ type: "session_meta", payload: { id, cwd } });
}
function cxEvent(payload: Record<string, unknown>): string {
  return JSON.stringify({ type: "event_msg", payload });
}

// --- fallback -----------------------------------------------------------------------------

test.afterEach(() => {
  resetHerdrWorkerDepsForTests();
});

test("trySpawnHerdrWorker resolves undefined outside Herdr (fallback preserved)", async () => {
  const ws = stubWorkspace();
  ws.available = false;
  setHerdrWorkerDepsForTests(testDeps(ws));
  const exit = await Effect.runPromiseExit(
    Effect.scoped(trySpawnHerdrWorker("pi", task("x"))),
  );
  assert.equal(Exit.isSuccess(exit), true);
  assert.equal(Exit.isSuccess(exit) ? exit.value : undefined, undefined);
});

test("trySpawnHerdrWorker resolves undefined when the pane cannot open", async () => {
  const ws = stubWorkspace();
  ws.failOpen = true;
  setHerdrWorkerDepsForTests(testDeps(ws));
  const exit = await Effect.runPromiseExit(
    Effect.scoped(trySpawnHerdrWorker("pi", task("x"))),
  );
  assert.ok(Exit.isSuccess(exit));
  assert.equal((exit as Exit.Success<unknown>).value, undefined);
});

test("pi worker: pane runs only node <launcher> <spec>; spec carries raw argv + PI_SUBAGENT=1 and is cleaned", async () => {
  const ws = stubWorkspace();
  const root = freshSessionRoot();
  const sessionDir = path.join(root, "sessions", "sa-3");
  fs.mkdirSync(sessionDir, { recursive: true });
  await withSession(
    "pi",
    testDeps(ws, root),
    task("do it", {
      model: "openai/gpt-5.4",
      parent: {
        ...parentCtx(),
        inheritedThinkingLevel: "high",
      },
    }),
    async (session, events) => {
      await waitFor(() => ws.opened.length === 1, "pane open");
      // The pane command line is EXACTLY the launcher tokens — on Windows a
      // leading `&` call operator makes the quoted node path execute. The
      // real argv (spaces, unicode, quotes) never touches the shell.
      const launch = ws.opened[0].launch;
      assert.equal(
        launch.length,
        process.platform === "win32" ? 4 : 3,
        "pane run is `& node <launcher> <spec>` on Windows, else 3 tokens",
      );
      if (process.platform === "win32") assert.equal(launch[0], "&");
      const spec = readLaunchSpec(launchSpecToken(launch));
      assert.equal(spec.command, process.execPath);
      // Raw argv, byte-exact — the exact values the launcher will spawn.
      assert.ok(spec.args.includes("--session-id"));
      assert.ok(spec.args.includes("--session-dir"));
      assert.ok(spec.args.includes(sessionDir), spec.args.join(" "));
      const nameIdx = spec.args.indexOf("--name");
      assert.equal(spec.args[nameIdx + 1], "[sa-3 · pi] Refactor module");
      assert.ok(spec.args.includes("--model"), spec.args.join(" "));
      assert.ok(spec.args.includes("openai/gpt-5.4"));
      assert.ok(spec.args.includes("--thinking"));
      assert.ok(spec.args.includes("high"));
      assert.ok(spec.args.includes("--exclude-tools"));
      assert.ok(spec.args.includes("--approve"));
      assert.equal(spec.cwd, "C:\\work\\proj");
      assert.equal(spec.env.PI_SUBAGENT, "1");

      const file = await piSessionFile(ws, sessionDir);
      fs.writeFileSync(
        file,
        [
          ...piSessionLines(
            "C:\\work\\proj",
            path.basename(file).split("_")[1].replace(".jsonl", ""),
          ),
          piUserLine("u1", "do it"),
          piAssistantLine("a1", "done"),
        ].join("\n") + "\n",
        "utf8",
      );
      await waitFor(() => settled(events).settled === 1, "run settle");
    },
  );
  // The scope-close finalizer cleaned the transient specs (the launcher
  // self-cleans the ones it actually consumed).
  const leftovers = fs.existsSync(path.join(root, "specs"))
    ? fs.readdirSync(path.join(root, "specs"))
    : [];
  assert.deepEqual(leftovers, [], "launcher specs are cleaned");
});

test("worker startup exit before a session file settles as failed", async () => {
  const ws = stubWorkspace(() => undefined);
  const root = freshSessionRoot();
  await withSession(
    "pi",
    testDeps(ws, root, { livenessProbeEveryMs: 1, pollIntervalMs: 5 }),
    task("never reaches pi"),
    async (_session, events) => {
      await waitFor(
        () => events.some((event) => event._tag === "RunSettled"),
        "startup liveness failure",
      );
      const event = events.find((entry) => entry._tag === "RunSettled");
      assert.equal(event?._tag, "RunSettled");
      if (event?._tag === "RunSettled") {
        assert.equal(event.outcome._tag, "Failed");
        if (event.outcome._tag === "Failed")
          assert.match(event.outcome.errorText, /exited before producing/);
      }
    },
  );
});

// --- pi run lifecycle ---------------------------------------------------------------------

test("pi worker: full run completes, pane is closed after settle (not taken over)", async () => {
  const ws = stubWorkspace();
  const root = freshSessionRoot();
  const sessionDir = path.join(root, "sessions", "sa-3");
  fs.mkdirSync(sessionDir, { recursive: true });
  await withSession(
    "pi",
    testDeps(ws, root),
    task("do it"),
    async (session, events) => {
      await waitFor(() => ws.opened.length === 1, "pane open");
      await waitFor(() => ws.prompts.length >= 1, "prompt submitted");
      assert.equal(ws.prompts[0], "do it");

      // The private session appears with the full run (fast tiny prompt case):
      // replay from byte 0 must still surface everything exactly once.
      const file = await piSessionFile(ws, sessionDir);
      fs.writeFileSync(
        file,
        [
          ...piSessionLines(
            "C:\\work\\proj",
            path.basename(file).split("_")[1].replace(".jsonl", ""),
          ),
          piUserLine("u1", "do it"),
          piAssistantLine("a1", "done"),
        ].join("\n") + "\n",
        "utf8",
      );

      await waitFor(() => settled(events).settled === 1, "run settle");
      const run = events.filter((e) => e._tag === "RunStarted");
      assert.equal(run.length, 1);
      const user = events.filter((e) => e._tag === "UserMessage");
      assert.equal(user.length, 1);
      const final = events.find((e) => e._tag === "RunSettled");
      assert.deepEqual(final, {
        _tag: "RunSettled",
        outcome: { _tag: "Completed", finalText: "done" },
      });
      // working reported at open + again at run start; idle at settle.
      assert.ok(ws.states.some((s) => s.state === "state:working"));
      assert.ok(ws.states.some((s) => s.state === "state:idle"));
      // settle close policy: pane closed unless taken over.
      await waitFor(() => ws.closed.length === 1, "pane closed after settle");
      assert.equal(ws.focused.length, 0);
    },
  );
  // The scope-close finalizer must not double-close (pane already gone).
  assert.equal(ws.closed.length, 1);
  // Named pi sessions PERSIST under the agent sessions tree: the dir is
  // deliberately NOT deleted on scope close/prune (resumable sessions).
  assert.equal(
    fs.existsSync(sessionDir),
    true,
    "session dir survives the scope close",
  );
});

test("pi worker: take over while running keeps the pane open and never interrupts", async () => {
  const ws = stubWorkspace();
  const sessionDir = path.join(DIR, "sessions", "sa-3");
  fs.mkdirSync(sessionDir, { recursive: true });
  let takenOver = false;
  await withSession(
    "pi",
    testDeps(ws),
    task("do it"),
    async (session, events) => {
      await waitFor(() => ws.opened.length === 1, "pane open");
      await waitFor(() => ws.prompts.length >= 1, "prompt submitted");
      const file = await piSessionFile(ws, sessionDir);
      fs.writeFileSync(
        file,
        [
          ...piSessionLines(
            "C:\\work\\proj",
            path.basename(file).split("_")[1].replace(".jsonl", ""),
          ),
          piUserLine("u1", "do it"),
        ].join("\n") + "\n",
        "utf8",
      );
      await waitFor(() => ws.prompts.length === 1, "prompt submitted");

      takenOver = await Effect.runPromise(session.takeOver);
      assert.equal(takenOver, true);
      assert.equal(ws.focused.length, 1);
      assert.equal(ws.keys.length, 0, "take over never interrupts");

      fs.appendFileSync(file, piAssistantLine("a1", "done") + "\n", "utf8");
      await waitFor(() => settled(events).settled === 1, "run settle");
      // The pane must survive the settle.
      await sleep(50);
      assert.equal(
        ws.closed.length,
        0,
        "taken-over pane is not closed at settle",
      );
    },
  );
  // Scope close keeps the taken-over pane open.
  assert.equal(ws.closed.length, 0);
});

test("pi worker: take over a settled run reopens and resumes the exact session", async () => {
  const ws = stubWorkspace();
  const root = freshSessionRoot();
  const sessionDir = path.join(root, "sessions", "sa-3");
  fs.mkdirSync(sessionDir, { recursive: true });
  await withSession(
    "pi",
    testDeps(ws, root),
    task("do it"),
    async (session, events) => {
      await waitFor(() => ws.prompts.length >= 1, "prompt submitted");
      const file = await piSessionFile(ws, sessionDir);
      fs.writeFileSync(
        file,
        [
          ...piSessionLines(
            "C:\\work\\proj",
            path.basename(file).split("_")[1].replace(".jsonl", ""),
          ),
          piUserLine("u1", "do it"),
          piAssistantLine("a1", "done"),
        ].join("\n") + "\n",
        "utf8",
      );
      await waitFor(() => settled(events).settled === 1, "run settle");
      await waitFor(() => ws.closed.length === 1, "pane closed after settle");

      const [firstTakeover, secondTakeover] = await Promise.all([
        Effect.runPromise(session.takeOver),
        Effect.runPromise(session.takeOver),
      ]);
      assert.equal(firstTakeover, true);
      assert.equal(secondTakeover, true);
      await waitFor(() => ws.opened.length === 2, "one resume pane opened");
      assert.equal(ws.opened.length, 2, "concurrent takeover never duplicates");
      // The pane runs ONLY `node <launcher> <spec>`; the raw resume argv
      // (--session + the exact session file, full policy) lives in the spec.
      const resume = ws.opened[1].launch;
      assert.equal(
        resume.length,
        process.platform === "win32" ? 4 : 3,
        "resume pane runs `& node <launcher> <spec>` on Windows, else 3 tokens",
      );
      if (process.platform === "win32") assert.equal(resume[0], "&");
      const resumeSpec = readLaunchSpec(launchSpecToken(resume));
      assert.ok(
        resumeSpec.args.includes("--session"),
        resumeSpec.args.join(" "),
      );
      assert.ok(resumeSpec.args.includes(file), resumeSpec.args.join(" "));
      assert.ok(
        resumeSpec.args.includes("--exclude-tools"),
        "resume preserves the tool exclusions",
      );
      assert.equal(
        resumeSpec.env.PI_SUBAGENT,
        "1",
        "resume spec still marks the child as a subagent",
      );
      assert.equal(ws.focused.length, 1);
      // The resumed pane is kept open.
      await sleep(30);
      assert.equal(ws.closed.length, 1);
    },
  );
});

test("pi worker: send on a settled run resumes, prompts, monitors the next run, and closes again", async () => {
  const ws = stubWorkspace();
  const root = freshSessionRoot();
  const sessionDir = path.join(root, "sessions", "sa-3");
  fs.mkdirSync(sessionDir, { recursive: true });
  await withSession(
    "pi",
    testDeps(ws, root),
    task("run one"),
    async (session, events) => {
      const file = await piSessionFile(ws, sessionDir);
      fs.writeFileSync(
        file,
        [
          ...piSessionLines(
            "C:\\work\\proj",
            path.basename(file).split("_")[1].replace(".jsonl", ""),
          ),
          piUserLine("u1", "run one"),
          piAssistantLine("a1", "first"),
        ].join("\n") + "\n",
        "utf8",
      );
      await waitFor(() => settled(events).settled === 1, "first settle");
      await waitFor(() => ws.closed.length === 1, "first pane closed");

      await Effect.runPromise(session.send("run two"));
      await waitFor(() => ws.opened.length === 2, "resume pane for send");
      await waitFor(
        () => ws.prompts.includes("run two"),
        "second prompt submitted",
      );

      fs.appendFileSync(
        file,
        piUserLine("u2", "run two") +
          "\n" +
          piAssistantLine("a2", "second") +
          "\n",
        "utf8",
      );
      await waitFor(() => settled(events).settled === 2, "second settle");
      const finals = events.filter((e) => e._tag === "RunSettled");
      assert.equal(finals[1].outcome._tag, "Completed");
      assert.equal(
        (finals[1].outcome as { finalText: string }).finalText,
        "second",
      );
      await waitFor(
        () => ws.closed.length === 2,
        "second pane closed after settle",
      );
      assert.equal(ws.prompts.length, 2);
    },
  );
});

test("pi worker: a failed settled resume settles truthfully (RunStarted + RunSettled)", async () => {
  const ws = stubWorkspace();
  const root = freshSessionRoot();
  const sessionDir = path.join(root, "sessions", "sa-3");
  fs.mkdirSync(sessionDir, { recursive: true });
  await withSession(
    "pi",
    testDeps(ws, root),
    task("run one"),
    async (session, events) => {
      const file = await piSessionFile(ws, sessionDir);
      fs.writeFileSync(
        file,
        [
          ...piSessionLines(
            "C:\\work\\proj",
            path.basename(file).split("_")[1].replace(".jsonl", ""),
          ),
          piUserLine("u1", "run one"),
          piAssistantLine("a1", "first"),
        ].join("\n") + "\n",
        "utf8",
      );
      await waitFor(() => settled(events).settled === 1, "first settle");
      await waitFor(() => ws.closed.length === 1, "first pane closed");
      // The resume reopen now fails: the restarted run must STILL settle —
      // before the fix this emitted a dangling RunStarted with no
      // RunSettled and the manager waited forever.
      ws.failOpen = true;
      await Effect.runPromise(session.send("run two"));
      await waitFor(
        () => settled(events).settled === 2,
        "resume failure settles",
      );
      const settledEvents = events.filter((e) => e._tag === "RunSettled");
      assert.equal(
        (settledEvents[1] as { outcome: { _tag: string } }).outcome._tag,
        "Failed",
      );
      const runs = events.filter((e) => e._tag === "RunStarted");
      assert.equal(
        runs.length,
        2,
        "the failed resume attempt announced its run truthfully",
      );
    },
  );
});

test("pi worker: steering while running goes through the TUI and interrupt sends ctrl+c", async () => {
  const ws = stubWorkspace();
  const root = freshSessionRoot();
  const sessionDir = path.join(root, "sessions", "sa-3");
  fs.mkdirSync(sessionDir, { recursive: true });
  await withSession(
    "pi",
    testDeps(ws, root),
    task("run"),
    async (session, events) => {
      const file = await piSessionFile(ws, sessionDir);
      fs.writeFileSync(file, piUserLine("u1", "run") + "\n", "utf8");
      await waitFor(() => ws.prompts.length === 1, "prompt submitted");

      await Effect.runPromise(session.send("steer during work"));
      assert.equal(ws.prompts[1], "steer during work");

      await Effect.runPromise(session.interrupt);
      assert.deepEqual(ws.keys.at(-1), ["ctrl+c"]);

      fs.appendFileSync(
        file,
        piAssistantLine("a1", "cut", "aborted") + "\n",
        "utf8",
      );
      await waitFor(() => settled(events).settled === 1, "interrupted settle");
      assert.equal(
        (
          events.find((e) => e._tag === "RunSettled") as {
            outcome: { _tag: string };
          }
        ).outcome._tag,
        "Interrupted",
      );
    },
  );
});

test("pi worker: interrupt falls back to a local settle when no terminal message arrives", async () => {
  const ws = stubWorkspace();
  const sessionDir = path.join(DIR, "sessions", "sa-3");
  fs.mkdirSync(sessionDir, { recursive: true });
  const deps = testDeps(ws, DIR, { interruptFallbackMs: 30 });
  await withSession("pi", deps, task("run"), async (session, events) => {
    const file = await piSessionFile(ws, sessionDir);
    fs.writeFileSync(file, piUserLine("u1", "run") + "\n", "utf8");
    await waitFor(() => ws.prompts.length === 1, "prompt submitted");
    await Effect.runPromise(session.interrupt);
    await waitFor(() => settled(events).settled === 1, "fallback settle");
    assert.equal(
      (
        events.find((e) => e._tag === "RunSettled") as {
          outcome: { _tag: string };
        }
      ).outcome._tag,
      "Interrupted",
    );
  });
});

// --- codex run lifecycle ---------------------------------------------------------------------

function codexRolloutPath(root: string): string {
  return path.join(
    root,
    "codex",
    "sessions",
    "2026",
    "01",
    "01",
    "rollout-01-id.jsonl",
  );
}

test("codex worker: marker prompt, rollout discovery, task_complete settle, pane closed", async () => {
  const ws = stubWorkspace();
  const root = freshSessionRoot();
  await withSession(
    "codex",
    testDeps(ws, root),
    task("fix the bug"),
    async (session, events) => {
      await waitFor(() => ws.opened.length === 1, "pane open");
      // The initial prompt rides as the FINAL positional argv of the launch
      // spec — it is never typed into the pane (no pane prompt, no race).
      const launch = ws.opened[0].launch;
      const spec = readLaunchSpec(launchSpecToken(launch));
      const initialPrompt = spec.args.at(-1)!;
      const marker = initialPrompt.split(" ")[0];
      assert.match(marker, /^herdrsub_sa-3_[0-9a-f]{6}$/);
      assert.ok(initialPrompt.endsWith("fix the bug"));
      assert.equal(
        ws.prompts.length,
        0,
        "the initial codex prompt never goes through pane submitText",
      );

      const file = codexRolloutPath(root);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        [
          cxSessionMeta("C:\\work\\proj", "019f-sess"),
          cxEvent({ type: "task_started", turn_id: "t1", started_at: 1 }),
          cxEvent({ type: "user_message", message: `${marker} fix the bug` }),
          cxEvent({
            type: "agent_message",
            message: "found it",
            phase: "commentary",
          }),
          cxEvent({
            type: "agent_message",
            message: "Fixed",
            phase: "final_answer",
          }),
          cxEvent({
            type: "token_count",
            info: {
              last_token_usage: { total_tokens: 800 },
              model_context_window: 258400,
            },
          }),
          cxEvent({
            type: "task_complete",
            turn_id: "t1",
            last_agent_message: "Fixed",
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      await waitFor(() => settled(events).settled === 1, "codex settle");
      const user = events.filter((e) => e._tag === "UserMessage");
      assert.equal(user[0].text, "fix the bug");
      const final = events.find((e) => e._tag === "RunSettled");
      assert.deepEqual(final, {
        _tag: "RunSettled",
        outcome: { _tag: "Completed", finalText: "Fixed" },
      });
      await waitFor(
        () => ws.closed.length === 1,
        "codex pane closed after settle",
      );
    },
  );
});

test("codex worker: turn_aborted settles as interrupted", async () => {
  const ws = stubWorkspace();
  const root = freshSessionRoot();
  await withSession(
    "codex",
    testDeps(ws, root),
    task("task"),
    async (session, events) => {
      await waitFor(() => ws.opened.length === 1, "pane open");
      const launch = ws.opened[0].launch;
      const spec = readLaunchSpec(launchSpecToken(launch));
      const marker = spec.args.at(-1)!.split(" ")[0];
      const file = codexRolloutPath(root);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        [
          cxSessionMeta("C:\\work\\proj", "019f-sess"),
          cxEvent({ type: "task_started", turn_id: "t2" }),
          cxEvent({ type: "user_message", message: `${marker} task` }),
          cxEvent({
            type: "agent_message",
            message: "halfway",
            phase: "commentary",
          }),
          cxEvent({ type: "turn_aborted", turn_id: "t2" }),
        ].join("\n") + "\n",
        "utf8",
      );
      await waitFor(() => settled(events).settled === 1, "aborted settle");
      assert.equal(
        (
          events.find((e) => e._tag === "RunSettled") as {
            outcome: { _tag: string };
          }
        ).outcome._tag,
        "Interrupted",
      );
    },
  );
});

test("codex worker: follow-ups while working queue locally and drain after settle", async () => {
  const ws = stubWorkspace();
  const root = freshSessionRoot();
  await withSession(
    "codex",
    testDeps(ws, root),
    task("do one"),
    async (session, events) => {
      await waitFor(() => ws.opened.length === 1, "pane open");
      const launch = ws.opened[0].launch;
      const spec = readLaunchSpec(launchSpecToken(launch));
      const marker1 = spec.args.at(-1)!.split(" ")[0];
      // The launch prompt is positional argv — nothing was typed yet.
      assert.equal(ws.prompts.length, 0, "launch prompt is not a pane prompt");
      // Queue a follow-up while the first task is still running.
      await Effect.runPromise(session.send("do two"));
      assert.equal(ws.prompts.length, 0, "follow-up is queued, not submitted");
      const file = codexRolloutPath(root);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        [
          cxSessionMeta("C:\\work\\proj", "019f-sess"),
          cxEvent({ type: "task_started", turn_id: "t1" }),
          cxEvent({ type: "user_message", message: `${marker1} do one` }),
          cxEvent({
            type: "agent_message",
            message: "first",
            phase: "final_answer",
          }),
          cxEvent({
            type: "task_complete",
            turn_id: "t1",
            last_agent_message: "first",
          }),
        ].join("\n") + "\n",
        "utf8",
      );
      await waitFor(() => settled(events).settled === 1, "first settle");

      // The first settle drains the queued follow-up into a new prompt —
      // THIS one does go through pane submitText (with a fresh marker).
      await waitFor(
        () => ws.prompts.length === 1,
        "follow-up submitted after settle",
      );
      const marker2 = ws.prompts[0].split(" ")[0];
      assert.notEqual(marker2, marker1);
    },
  );
});

// --- dispose / races -------------------------------------------------------------------------

test("scope close disposes the run, closes the pane, and ends the stream", async () => {
  const ws = stubWorkspace();
  const root = freshSessionRoot();
  const sessionDir = path.join(root, "sessions", "sa-3");
  fs.mkdirSync(sessionDir, { recursive: true });
  const program = Effect.scoped(
    Effect.gen(function* () {
      const session = yield* makeHerdrWorkerSession(
        "pi",
        task("run"),
        testDeps(ws, root),
      ).pipe(Effect.mapError((error) => new Error(error.message)));
      yield* Effect.promise(() =>
        waitFor(() => ws.opened.length === 1, "pane open"),
      );
      return session;
    }),
  );
  const exit = await Effect.runPromiseExit(program);
  assert.equal(Exit.isSuccess(exit), true);
  // The scoped effect closed the session: run interrupted + pane closed.
  assert.equal(ws.closed.length, 1);
});

test("concurrent take over on a running pi session both resolve true without interrupting", async () => {
  const ws = stubWorkspace();
  const root = freshSessionRoot();
  const sessionDir = path.join(root, "sessions", "sa-3");
  fs.mkdirSync(sessionDir, { recursive: true });
  await withSession(
    "pi",
    testDeps(ws, root),
    task("run"),
    async (session, _events) => {
      const file = path.join(sessionDir, "2026-01-01T00-00-00_sess-0ab.jsonl");
      fs.writeFileSync(file, piUserLine("u1", "run") + "\n", "utf8");
      await waitFor(() => ws.prompts.length === 1, "prompt submitted");
      const [a, b] = await Promise.all([
        Effect.runPromise(session.takeOver),
        Effect.runPromise(session.takeOver),
      ]);
      assert.equal(a, true);
      assert.equal(b, true);
      assert.equal(ws.keys.length, 0);
      await sleep(20);
      assert.equal(
        ws.closed.length,
        0,
        "pane survives after racing take-overs",
      );
    },
  );
});
