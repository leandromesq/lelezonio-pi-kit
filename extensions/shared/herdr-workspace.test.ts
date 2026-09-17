/**
 * Unit tests for the shared Herdr worker workspace module — injectable
 * runner, no-Herdr fallback, workspace/tab/pane choreography, observer
 * command quoting (Windows/POSIX), settle/take-over policy, focus races,
 * rollback, closed-resource rebuild, and disposal.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  disposeWorkerWorkspace,
  isMissingHerdrResource,
  HerdrCliError,
  observerCommand,
  setWorkerWorkspaceForTests,
  shellQuote,
  workerWorkspaceForSession,
  workspaceLabel,
  createWorkerWorkspaceController,
  type HerdrCliEnvelope,
  type HerdrRunner,
} from "./herdr-workspace.ts";

// --- stub CLI --------------------------------------------------------------------

/** Scripted herdr CLI: answers per command, records every invocation. */
function stubRunner(
  handler: (
    args: ReadonlyArray<string>,
  ) => HerdrCliEnvelope | Promise<HerdrCliEnvelope> | Error,
): { runner: HerdrRunner; calls: Array<ReadonlyArray<string>> } {
  const calls: Array<ReadonlyArray<string>> = [];
  const runner: HerdrRunner = async (args, _timeout) => {
    calls.push(args);
    const answer = handler(args);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { runner, calls };
}

/** A stateful fake herdr server that hands out ids like the real one. */
function fakeHerdr() {
  let workspaceCounter = 0;
  let paneCounter = 0;
  const callCounts = new Map<string, number>();
  const calls: Array<ReadonlyArray<string>> = [];
  /** Live panes per workspace; a workspace with no panes is closed. */
  const panesByWorkspace = new Map<string, Set<string>>();
  /** Queued failures, consumed in order by matching command key. */
  const failures: Array<{
    count: number;
    error: Error;
    command: string;
  }> = [];

  const nextPane = (workspaceId: string) => `${workspaceId}:p${++paneCounter}`;

  const answer = (args: ReadonlyArray<string>): HerdrCliEnvelope => {
    calls.push(args);
    const key = `${args[0]} ${args[1]}`;
    callCounts.set(key, (callCounts.get(key) ?? 0) + 1);
    if (failures.length > 0) {
      const failure = failures[0];
      if (failure.command === "*" || failure.command === key) {
        failure.count -= 1;
        if (failure.count <= 0) failures.shift();
        throw failure.error;
      }
    }
    switch (key) {
      case "workspace create": {
        workspaceCounter += 1;
        const ws = `w${workspaceCounter}`;
        const pane = nextPane(ws);
        panesByWorkspace.set(ws, new Set([pane]));
        return {
          result: {
            workspace: { workspace_id: ws },
            tab: { tab_id: `${ws}:t1` },
            root_pane: { pane_id: pane },
          },
        };
      }
      case "tab create": {
        const ws = args[args.indexOf("--workspace") + 1];
        // Faithful to Herdr: a workspace with no panes left is CLOSED, and
        // every later command against it fails with the real envelope error
        // (`{"code":"workspace_not_found","message":"workspace w1 not found"}`).
        // Modeling this is what keeps the stale-workspace-id regression
        // (Herdr spawning silently dead for the session) from coming back.
        if (!panesByWorkspace.has(ws)) {
          throw new HerdrCliError(
            `workspace_not_found: workspace ${ws} not found`,
            "workspace_not_found",
          );
        }
        const tabNumber = (callCounts.get("tab create") ?? 0) + 1;
        const tabId = `${ws}:t${tabNumber}`;
        const pane = nextPane(ws);
        panesByWorkspace.get(ws)?.add(pane);
        return {
          result: {
            tab: { tab_id: tabId },
            root_pane: { pane_id: pane },
          },
        };
      }
      case "pane split": {
        const target = args[2];
        const workspaceId = target.split(":")[0];
        if (!panesByWorkspace.get(workspaceId)?.has(target)) {
          throw new HerdrCliError(
            `pane_not_found: pane ${target} not found`,
            "pane_not_found",
          );
        }
        const pane = nextPane(workspaceId);
        panesByWorkspace.get(workspaceId)?.add(pane);
        return { result: { pane: { pane_id: pane } } };
      }
      case "pane close": {
        const target = args[2];
        const workspaceId = target.split(":")[0];
        const panes = panesByWorkspace.get(workspaceId);
        if (!panes) {
          throw new HerdrCliError(
            `pane_not_found: pane ${target} not found`,
            "pane_not_found",
          );
        }
        panes.delete(target);
        // Herdr closes a workspace once its last pane is gone.
        if (panes.size === 0) panesByWorkspace.delete(workspaceId);
        return {};
      }
      case "workspace close": {
        panesByWorkspace.delete(args[2]);
        return {};
      }
      default:
        return {};
    }
  };

  const runner: HerdrRunner = async (args, _timeout) => answer(args);
  return {
    runner,
    calls,
    callCount: (key: string) => callCounts.get(key) ?? 0,
    failNextOnce: (message: string) => {
      failures.push({ count: 1, error: new Error(message), command: "*" });
    },
    failNextCommand: (command: string, count: number, message: string) => {
      failures.push({ count, error: new Error(message), command });
    },
    /** Queue a PRECISE error shape (e.g. a real HerdrCliError envelope). */
    failNextError: (error: Error) => {
      failures.push({ count: 1, error, command: "*" });
    },
    /** Simulate the user closing a workspace in Herdr (its panes go with it). */
    closeWorkspace: (workspaceId: string) => {
      panesByWorkspace.delete(workspaceId);
    },
    /** Workspaces the fake server still holds (an orphan would show up here). */
    liveWorkspaces: () => [...panesByWorkspace.keys()],
  };
}

function makeController(options: {
  herdr: ReturnType<typeof fakeHerdr>;
  environment?: () => boolean;
  project?: string;
  sessionId?: string;
  platform?: NodeJS.Platform;
  runRetryDeadlineMs?: number;
  /** Wrap/replace the fake CLI (gating specific commands in race tests). */
  runner?: HerdrRunner;
}) {
  const controller = createWorkerWorkspaceController({
    project: options.project ?? "proj",
    sessionId: options.sessionId ?? "01234567-89ab-cdef",
    projectRoot: "C:\\work\\proj",
    runner: options.runner ?? options.herdr.runner,
    environment: options.environment ?? (() => true),
    platform: options.platform ?? "win32",
    runRetryDeadlineMs: options.runRetryDeadlineMs ?? 5_000,
    runRetryDelayMs: 1,
    cliTimeoutMs: 2_000,
    closeTimeoutMs: 1_000,
  });
  return controller;
}

const once = <T>(fn: () => T): (() => T) => {
  let value: T | undefined;
  let called = false;
  return () => {
    if (!called) {
      called = true;
      value = fn();
    }
    return value as T;
  };
};

// --- label + observer command quoting --------------------------------------------

test("workspaceLabel renders the agreed format with a short session", () => {
  assert.equal(
    workspaceLabel("agrofortis.mobile", "01a03c03-126a-7cd3-b082"),
    "Pi Workers · agrofortis.mobile · 01a03c03",
  );
  assert.equal(workspaceLabel("  ", "xyz"), "Pi Workers · workspace · xyz");
});

test("observer command on Windows tails both spill files via per-file Start-Job (whole script quoted)", () => {
  const args = observerCommand(
    "C:\\tmp a\\bt-1.stdout.log",
    "C:\\tmp a\\bt-1.stderr.log",
    "win32",
  );
  // One -Command token: the script joins both trails as one wait (Get-Content
  // with multiple -LiteralPath args tails them as a single stream, which
  // re-reads — so each file gets its own Start-Job). The doubled quotes are
  // pwsh escaping of the inner path literals.
  assert.deepEqual(args, [
    "powershell",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "'$paths=@(''C:\\tmp a\\bt-1.stdout.log'',''C:\\tmp a\\bt-1.stderr.log''); $jobs=@($paths | ForEach-Object { Start-Job -ScriptBlock { param($p) Get-Content -LiteralPath $p -Wait } -ArgumentList $_ }); Receive-Job -Job $jobs -Wait -AutoRemoveJob'",
  ]);
});

test("observer command on POSIX tails both spill files with --", () => {
  const args = observerCommand(
    "/tmp/a b/bt-1.stdout.log",
    "/tmp/a b/bt-1.stderr.log",
    "linux",
  );
  assert.deepEqual(args, [
    "tail",
    "-F",
    "--",
    "'/tmp/a b/bt-1.stdout.log'",
    "'/tmp/a b/bt-1.stderr.log'",
  ]);
});

test("shellQuote is platform-correct: pwsh doubles quotes, POSIX escapes them", () => {
  // Windows/pwsh: single-quoted literal, embedded single quotes doubled.
  assert.equal(shellQuote("a'b", "win32"), "'a''b'");
  assert.equal(
    shellQuote("C:\\sub agents\\sa-3", "win32"),
    "'C:\\sub agents\\sa-3'",
  );
  assert.equal(
    shellQuote("C:\\Users\\O'Neil\\.pi", "win32"),
    "'C:\\Users\\O''Neil\\.pi'",
  );
  // POSIX sh: single quotes are literal; embedded quotes close-escape-reopen.
  assert.equal(shellQuote("a'b", "linux"), "'a'\\''b'");
  assert.equal(
    shellQuote("/home/o'neil/work dir", "linux"),
    "'/home/o'\\''neil/work dir'",
  );
});

// --- no-Herdr fallback -----------------------------------------------------------

test("outside Herdr nothing is created and callers get undefined", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({
    herdr,
    environment: once(() => false),
  });
  assert.equal(controller.available(), false);
  assert.equal(await controller.ensureWorkspace(), undefined);
  assert.equal(
    await controller.openWorker({
      category: "terminals",
      title: "t",
      cwd: "C:\\work",
      launch: ["tail", "-F"],
    }),
    undefined,
  );
  assert.equal(
    await controller.openObserver({
      terminalId: "bt-1",
      title: "t",
      cwd: "C:\\work",
      stdoutPath: "a.log",
      stderrPath: "b.log",
    }),
    undefined,
  );
  assert.deepEqual(herdr.calls, []);
});

// --- workspace + tab choreography ------------------------------------------------

test("workspace create uses --no-focus and the derived label", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({
    herdr,
    project: "proj",
    sessionId: "01234567-89ab",
  });
  const ws = await controller.ensureWorkspace();
  assert.equal(ws, "w1");
  assert.deepEqual(herdr.calls[0], [
    "workspace",
    "create",
    "--cwd",
    "C:\\work\\proj",
    "--label",
    "Pi Workers · proj · 01234567",
    "--no-focus",
  ]);
});

test("first category claims the initial tab; its root pane hosts the first worker", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  const pane = await controller.openWorker({
    category: "terminals",
    title: "bt-1 dev server",
    cwd: "C:\\work\\proj",
    launch: ["tail", "-F"],
    agent: { label: "bt-1 dev server", state: "idle" },
  });
  assert.ok(pane);
  assert.equal(pane.paneId, "w1:p1"); // the root pane, host of the worker
  const keys = herdr.calls.map((a) => `${a[0]} ${a[1]}`);
  // rename the initial tab, report the worker as an agent with a stable
  // name, then run it in the ROOT pane (no split yet). The report MUST
  // precede the pane run — no fallible setup step may remain after real
  // work starts (a fallible one would trigger an in-process fallback and
  // duplicate the task).
  assert.deepEqual(keys, [
    "workspace create",
    "tab rename",
    "pane rename",
    "pane report-agent",
    "agent rename",
    "pane run",
  ]);
  const run = herdr.calls.find((a) => a[1] === "run")!;
  assert.deepEqual([...run], ["pane", "run", "w1:p1", "tail", "-F"]);
  const rename = herdr.calls.find((a) => a[1] === "rename" && a[0] === "tab")!;
  assert.deepEqual([...rename], ["tab", "rename", "w1:t1", "Terminals"]);
});

test("later workers split the newest pane for the same category", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  const first = await controller.openWorker({
    category: "terminals",
    title: "one",
    cwd: "C:\\work",
    launch: ["tail", "-F", "a"],
  });
  const second = await controller.openWorker({
    category: "terminals",
    title: "two",
    cwd: "C:\\work",
    launch: ["tail", "-F", "b"],
  });
  assert.ok(first && second);
  assert.equal(second.paneId, "w1:p2");
  const split = herdr.calls.find((a) => a[1] === "split")!;
  assert.deepEqual(
    [...split],
    [
      "pane",
      "split",
      "w1:p1",
      "--direction",
      "down",
      "--ratio",
      "0.45",
      "--cwd",
      "C:\\work",
      "--no-focus",
    ],
  );
});

test("second category uses tab create with its own label", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  await controller.openWorker({
    category: "terminals",
    title: "t1",
    cwd: "C:\\work",
    launch: ["tail", "-F", "a"],
  });
  const pane = await controller.openWorker({
    category: "subagents",
    title: "reviewer",
    cwd: "C:\\work",
    launch: ["pi", "-p", "'x'"],
  });
  assert.ok(pane);
  assert.equal(pane.paneId, "w1:p2"); // root pane of the new tab
  const create = herdr.calls.find((a) => a[1] === "create" && a[0] === "tab")!;
  assert.deepEqual(
    [...create],
    [
      "tab",
      "create",
      "--workspace",
      "w1",
      "--cwd",
      "C:\\work\\proj",
      "--label",
      "Subagents",
      "--no-focus",
    ],
  );
});

test("all background-creation commands pass --no-focus", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  await controller.openWorker({
    category: "terminals",
    title: "t",
    cwd: "C:\\work",
    launch: ["tail", "-F"],
  });
  await controller.openWorker({
    category: "subagents",
    title: "s",
    cwd: "C:\\work",
    launch: ["pi", "-p", "'x'"],
  });
  for (const call of herdr.calls) {
    if (call[0] === "workspace" && call[1] === "create") {
      assert.ok(call.includes("--no-focus"), `no-focus on ${call.join(" ")}`);
    }
    if (call[0] === "tab" && call[1] === "create") {
      assert.ok(call.includes("--no-focus"), `no-focus on ${call.join(" ")}`);
    }
    if (call[0] === "pane" && call[1] === "split") {
      assert.ok(call.includes("--no-focus"), `no-focus on ${call.join(" ")}`);
    }
  }
});

test("workspace is created exactly once for many workers", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  await Promise.all([
    controller.openWorker({
      category: "terminals",
      title: "a",
      cwd: "C:\\w",
      launch: ["x"],
    }),
    controller.openWorker({
      category: "terminals",
      title: "b",
      cwd: "C:\\w",
      launch: ["x"],
    }),
  ]);
  assert.equal(herdr.callCount("workspace create"), 1);
});

// --- agent reporting --------------------------------------------------------------

test("openWorker reports the pane as an agent with session identity", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({
    herdr,
    sessionId: "01234567-89ab",
  });
  const pane = await controller.openWorker({
    category: "terminals",
    title: "dev server",
    cwd: "C:\\work",
    launch: ["tail", "-F"],
    agent: { label: "dev server", state: "idle", sessionId: "01234567-89ab" },
  });
  assert.ok(pane);
  const report = herdr.calls.find((a) => a[1] === "report-agent")!;
  // The pane id sits immediately after the subcommand; the source is the
  // worker-workspace identity, not the model process.
  assert.deepEqual(
    [...report],
    [
      "pane",
      "report-agent",
      "w1:p1",
      "--source",
      "pi-workers",
      "--agent",
      "dev server",
      "--state",
      "idle",
      "--agent-session-id",
      "01234567-89ab",
    ],
  );
  const rename = herdr.calls.find(
    (a) => a[0] === "agent" && a[1] === "rename",
  )!;
  assert.deepEqual([...rename], ["agent", "rename", "w1:p1", "dev-server"]);
});

test("agent names stay unique per session", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  const launch = () => ({
    category: "terminals" as const,
    title: "dev server",
    cwd: "C:\\w",
    launch: ["tail", "-F"],
    agent: { label: "dev server", state: "idle" as const },
  });
  await controller.openWorker(launch());
  await controller.openWorker(launch());
  const renames = herdr.calls
    .filter((a) => a[0] === "agent" && a[1] === "rename")
    .map((a) => a[3]);
  assert.deepEqual(renames, ["dev-server", "dev-server1"]);
});

test("explicit agent.name wins over the label slug (technical naming)", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  const pane = await controller.openWorker({
    category: "subagents",
    title: "[sa-3 · pi] Refactor module",
    cwd: "C:\\w",
    launch: ["node", "cli.js"],
    agent: {
      label: "[sa-3 · pi] Refactor module",
      state: "working",
      name: "p-019e16ea-sa-3",
    },
  });
  assert.ok(pane);
  const rename = herdr.calls.find(
    (a) => a[0] === "agent" && a[1] === "rename",
  )!;
  assert.deepEqual(
    [...rename],
    ["agent", "rename", "w1:p1", "p-019e16ea-sa-3"],
  );
});

test("submitText uses the low-level transport: send-text then send-keys enter", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  const pane = await controller.openWorker({
    category: "subagents",
    title: "sa",
    cwd: "C:\\w",
    launch: ["node", "cli.js"],
    agent: { label: "sa", state: "idle" },
  });
  assert.ok(pane);
  herdr.calls.length = 0;
  await pane.submitText("do the thing");
  assert.deepEqual(herdr.calls, [
    ["pane", "send-text", "w1:p1", "do the thing"],
    ["pane", "send-keys", "w1:p1", "enter"],
  ]);
});

test("sendEnter is an Enter-only transport operation", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  const pane = await controller.openWorker({
    category: "subagents",
    title: "sa",
    cwd: "C:\\w",
    launch: ["node", "cli.js"],
    agent: { label: "sa", state: "idle" },
  });
  assert.ok(pane);
  herdr.calls.length = 0;
  await pane.sendEnter();
  assert.deepEqual(herdr.calls, [["pane", "send-keys", "w1:p1", "enter"]]);
});

test("submitText retries agent_pane_busy on the send-text only, boundedly", async () => {
  const herdr = fakeHerdr();
  let failureCount = 0;
  const original = herdr.runner;
  const runner: HerdrRunner = async (args, timeout) => {
    if (args[0] === "pane" && args[1] === "send-text" && failureCount < 2) {
      failureCount += 1;
      throw new Error("agent_pane_busy");
    }
    return original(args, timeout);
  };
  const controller = createWorkerWorkspaceController({
    project: "p",
    sessionId: "s",
    projectRoot: "C:\\w",
    runner,
    environment: () => true,
    platform: "win32",
    runRetryDeadlineMs: 2_000,
    runRetryDelayMs: 1,
    cliTimeoutMs: 2_000,
    closeTimeoutMs: 1_000,
  });
  const pane = await controller.openWorker({
    category: "subagents",
    title: "sa",
    cwd: "C:\\w",
    launch: ["node", "cli.js"],
  });
  assert.ok(pane);
  await pane.submitText("text");
  assert.equal(failureCount, 2, "send-text retried the busy errors");
});

test("submitText fails fast on non-busy errors (no infinite retry)", async () => {
  const herdr = fakeHerdr();
  let failures = 0;
  const original = herdr.runner;
  const runner: HerdrRunner = async (args, timeout) => {
    if (args[0] === "pane" && args[1] === "send-text") {
      failures += 1;
      throw new Error("agent_not_ready: no longer pane foreground process");
    }
    return original(args, timeout);
  };
  const controller = createWorkerWorkspaceController({
    project: "p",
    sessionId: "s",
    projectRoot: "C:\\w",
    runner,
    environment: () => true,
    platform: "win32",
    runRetryDeadlineMs: 2_000,
    runRetryDelayMs: 1,
    cliTimeoutMs: 2_000,
    closeTimeoutMs: 1_000,
  });
  const pane = await controller.openWorker({
    category: "subagents",
    title: "sa",
    cwd: "C:\\w",
    launch: ["node", "cli.js"],
  });
  assert.ok(pane);
  await assert.rejects(pane.submitText("text"));
  assert.equal(failures, 1, "the permanent error failed immediately");
});

test("reportState/getAgentState/reportMetadata target the allocated pane", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  const pane = await controller.openWorker({
    category: "subagents",
    title: "sa",
    cwd: "C:\\w",
    launch: ["node", "cli.js"],
    agent: { label: "sa", state: "idle" },
  });
  assert.ok(pane);
  herdr.calls.length = 0;
  await pane.reportState("working", "thinking");
  await pane.getAgentState();
  await pane.reportMetadata({ summary: "running" });
  // report-state/report-metadata take the pane id first, then options, and
  // report under the worker-workspace source (pi-workers).
  assert.deepEqual(herdr.calls[0], [
    "pane",
    "report-agent",
    "w1:p1",
    "--source",
    "pi-workers",
    "--agent",
    "sa",
    "--state",
    "working",
    "--message",
    "thinking",
  ]);
  assert.deepEqual(herdr.calls[1], ["agent", "get", "w1:p1"]);
  assert.deepEqual(herdr.calls[2], [
    "pane",
    "report-metadata",
    "w1:p1",
    "--token",
    "summary=running",
    "--source",
    "pi-workers",
  ]);
});

test("getAgentState reads the live state through the envelope", async () => {
  const herdr = fakeHerdr();
  const original = herdr;
  const runner: HerdrRunner = async (args) => {
    if (args[0] === "agent" && args[1] === "get") {
      return { result: { agent: { state: "working" } } };
    }
    return original.runner(args, 1000);
  };
  const controller = createWorkerWorkspaceController({
    project: "p",
    sessionId: "s",
    projectRoot: "C:\\w",
    runner,
    environment: () => true,
    platform: "win32",
    cliTimeoutMs: 2000,
    closeTimeoutMs: 1000,
  });
  const pane = await controller.openWorker({
    category: "subagents",
    title: "sa",
    cwd: "C:\\w",
    launch: ["node", "cli.js"],
    agent: { label: "sa", state: "idle" },
  });
  assert.ok(pane);
  assert.equal(await pane.getAgentState(), "working");
});

test("isWorkerRunning distinguishes a missing pane from probe failure", async () => {
  for (const [message, expected] of [
    ["pane not found", false],
    ["pane is gone", false],
    ["transport timed out", undefined],
    ["socket closed", undefined],
    ["workspace connection closed", undefined],
  ] as const) {
    const herdr = fakeHerdr();
    const runner: HerdrRunner = async (args, timeout) => {
      if (args[0] === "pane" && args[1] === "process-info") {
        throw new Error(message);
      }
      return herdr.runner(args, timeout);
    };
    const controller = createWorkerWorkspaceController({
      project: "p",
      sessionId: "s",
      projectRoot: "C:\\w",
      runner,
      environment: () => true,
      platform: "win32",
      cliTimeoutMs: 2000,
      closeTimeoutMs: 1000,
    });
    const pane = await controller.openWorker({
      category: "subagents",
      title: "sa",
      cwd: "C:\\w",
      launch: ["node", "cli.js"],
    });
    assert.ok(pane?.isWorkerRunning);
    assert.equal(await pane.isWorkerRunning(), expected);
  }
});

test("isWorkerRunning ignores idle POSIX and Windows shells", async () => {
  const herdr = fakeHerdr();
  const runner: HerdrRunner = async (args, timeout) => {
    if (args[0] === "pane" && args[1] === "process-info") {
      return {
        result: {
          process_info: {
            foreground_processes: [
              { name: "bash" },
              { name: "zsh" },
              { name: "pwsh.exe" },
            ],
          },
        },
      };
    }
    return herdr.runner(args, timeout);
  };
  const controller = createWorkerWorkspaceController({
    project: "p",
    sessionId: "s",
    projectRoot: "C:\\w",
    runner,
    environment: () => true,
    platform: "win32",
    cliTimeoutMs: 2000,
    closeTimeoutMs: 1000,
  });
  const pane = await controller.openWorker({
    category: "subagents",
    title: "sa",
    cwd: "C:\\w",
    launch: ["node", "cli.js"],
  });
  assert.equal(await pane?.isWorkerRunning?.(), false);
});

// --- rollback ---------------------------------------------------------------------

test("a failed launch rolls back: the pane is closed and undefined returned", async () => {
  const herdr = fakeHerdr();
  herdr.failNextCommand("pane run", 1, "command failed");
  const controller = makeController({ herdr });
  const pane = await controller.openWorker({
    category: "terminals",
    title: "t",
    cwd: "C:\\work",
    launch: ["tail", "-F"],
  });
  assert.equal(pane, undefined);
  const keys = herdr.calls.map((a) => `${a[0]} ${a[1]}`);
  // The failed pane run (after rename) is rolled back with pane close.
  assert.ok(keys.includes("pane close"), keys.join(", "));
  assert.ok(
    keys.indexOf("pane close") > keys.indexOf("pane run"),
    keys.join(", "),
  );
});

test("a failed rollback close is swallowed (best effort)", async () => {
  const herdr = fakeHerdr();
  herdr.failNextCommand("pane run", 1, "command failed");
  herdr.failNextCommand("pane close", 1, "pane already gone");
  const controller = makeController({ herdr });
  assert.equal(
    await controller.openWorker({
      category: "terminals",
      title: "t",
      cwd: "C:\\work",
      launch: ["tail", "-F"],
    }),
    undefined,
  );
});

// --- uncertain close: ownership is retained, never forgotten ----------------------

test("a failed pane close retains workspace ownership (no orphan on the next allocation)", async () => {
  // Audit repro: close fails on the transport, the controller forgets the
  // workspace, and the next open builds a second "Pi Workers" workspace
  // beside the still-live one.
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  const first = await controller.openWorker({
    category: "terminals",
    title: "a",
    cwd: "C:\\w",
    launch: ["x"],
  });
  assert.ok(first);
  assert.equal(controller.workspaceId, "w1");
  herdr.failNextCommand("pane close", 1, "transport unavailable");
  await first.close();
  assert.equal(
    controller.workspaceId,
    "w1",
    "an unconfirmed close keeps owning the workspace",
  );
  assert.deepEqual(herdr.liveWorkspaces(), ["w1"]);
  // The next allocation reconciles the quarantine (retries the close). Once
  // the pane is confirmed gone the workspace is released and exactly one
  // fresh workspace is built — never a second one beside a live survivor.
  const second = await controller.openWorker({
    category: "terminals",
    title: "b",
    cwd: "C:\\w",
    launch: ["x"],
  });
  assert.ok(second);
  assert.deepEqual(herdr.liveWorkspaces(), [second.workspaceId]);
  assert.equal(herdr.callCount("workspace create"), 2);
});

test("dispose after an uncertain pane close still closes the workspace (no shutdown leak)", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  const first = await controller.openWorker({
    category: "terminals",
    title: "a",
    cwd: "C:\\w",
    launch: ["x"],
  });
  assert.ok(first);
  herdr.failNextCommand("pane close", 1, "transport unavailable");
  await first.close();
  await controller.dispose();
  assert.deepEqual(
    herdr.liveWorkspaces(),
    [],
    "dispose still owns (and closes) the workspace after a failed pane close",
  );
});

test("a permanently failing close is retried boundedly and keeps ownership", async () => {
  const BOUNDED_CLOSE_ATTEMPTS = 3; // initial attempt + reconciliation retries
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  const first = await controller.openWorker({
    category: "terminals",
    title: "a",
    cwd: "C:\\w",
    launch: ["x"],
  });
  assert.ok(first);
  herdr.failNextCommand("pane close", 99, "transport unavailable");
  await first.close();
  for (let index = 0; index < 4; index += 1) {
    const next = await controller.openWorker({
      category: "terminals",
      title: `n${index}`,
      cwd: "C:\\w",
      launch: ["x"],
    });
    assert.ok(next, `allocation ${index} still succeeds`);
  }
  assert.equal(
    controller.workspaceId,
    "w1",
    "the workspace stays owned while a pane may still be live",
  );
  assert.equal(herdr.callCount("workspace create"), 1, "no replacement leaks");
  assert.equal(
    herdr.callCount("pane close"),
    BOUNDED_CLOSE_ATTEMPTS,
    "close retries are bounded (never an infinite retry loop)",
  );
});

test("a close/open race does not abandon a concurrently allocated pane", async () => {
  // The first worker's launch is held until a second worker has allocated a
  // split; the first then FAILS and its rollback closes the category's ROOT
  // pane. Dropping the whole category there would silently abandon the
  // second (live) pane and forget a workspace that is still populated.
  const herdr = fakeHerdr();
  let releaseRun!: () => void;
  const runGate = new Promise<void>((resolve) => (releaseRun = resolve));
  let firstRunStarted!: () => void;
  const firstRun = new Promise<void>((resolve) => (firstRunStarted = resolve));
  const gated: HerdrRunner = async (args, timeout) => {
    if (args[0] === "pane" && args[1] === "run" && args[2] === "w1:p1") {
      firstRunStarted();
      await runGate;
      throw new Error("command failed");
    }
    return herdr.runner(args, timeout);
  };
  const controller = makeController({ herdr, runner: gated });

  const first = controller.openWorker({
    category: "terminals",
    title: "a",
    cwd: "C:\\w",
    launch: ["x"],
  });
  await firstRun; // the root pane is allocated and launching
  const second = await controller.openWorker({
    category: "terminals",
    title: "b",
    cwd: "C:\\w",
    launch: ["x"],
  });
  assert.ok(second);
  assert.equal(second.paneId, "w1:p2");

  releaseRun();
  assert.equal(await first, undefined, "the failed launch rolls back");

  assert.equal(
    controller.workspaceId,
    "w1",
    "the concurrent pane keeps the workspace owned",
  );
  assert.equal(herdr.callCount("workspace create"), 1);
  assert.deepEqual(herdr.liveWorkspaces(), ["w1"]);
  // The surviving pane is still the split target: a third worker lands there
  // instead of rebuilding/abandoning the category.
  const third = await controller.openWorker({
    category: "terminals",
    title: "c",
    cwd: "C:\\w",
    launch: ["x"],
  });
  assert.ok(third);
  assert.equal(third.paneId, "w1:p3");
  assert.equal(herdr.callCount("workspace create"), 1);
});

test("run retries agent_pane_busy until the deadline", async () => {
  const herdr = fakeHerdr();
  herdr.failNextCommand("pane run", 3, "agent_pane_busy");
  const controller = makeController({ herdr, runRetryDeadlineMs: 200 });
  const pane = await controller.openWorker({
    category: "terminals",
    title: "t",
    cwd: "C:\\work",
    launch: ["tail", "-F"],
  });
  assert.ok(pane);
  assert.equal(herdr.callCount("pane run"), 4);
});

test("a user-closed tab rebuilds only its category inside the same workspace", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  const first = await controller.openWorker({
    category: "terminals",
    title: "t",
    cwd: "C:\\work",
    launch: ["tail", "-F"],
  });
  assert.equal(first?.workspaceId, "w1");
  // The user closed the tab: the next split fails with "not found". The
  // category rebuilds in the CURRENT workspace (w1) — subagent panes in the
  // other category (and taken-over panes) keep living.
  herdr.failNextOnce("pane not found: w1:p1");
  const second = await controller.openWorker({
    category: "terminals",
    title: "t2",
    cwd: "C:\\work",
    launch: ["tail", "-F"],
  });
  assert.ok(second);
  assert.equal(second.workspaceId, "w1", "same workspace after a tab close");
  assert.equal(herdr.callCount("workspace create"), 1);
  assert.equal(herdr.callCount("tab create"), 1, "rebuilt tab in w1");
});

test("a dead workspace rebuilds fresh and closes the superseded one (no leak)", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  const first = await controller.openWorker({
    category: "terminals",
    title: "t",
    cwd: "C:\\work",
    launch: ["tail", "-F"],
  });
  assert.equal(first?.workspaceId, "w1");
  // The whole workspace is gone: the category rebuild fails too (tab create
  // in a dead workspace). The old workspace is closed and a fresh one is
  // created — no second "Pi Workers" workspace can leak behind.
  herdr.failNextOnce("pane not found: w1:p1");
  herdr.failNextOnce("workspace not found: w1");
  const second = await controller.openWorker({
    category: "terminals",
    title: "t2",
    cwd: "C:\\work",
    launch: ["tail", "-F"],
  });
  assert.ok(second);
  assert.equal(second.workspaceId, "w2");
  assert.equal(herdr.callCount("workspace create"), 2);
  const closes = herdr.calls.filter((a) => a[1] === "close").map((a) => [...a]);
  assert.deepEqual(closes, [["workspace", "close", "w1"]]);
});

test("a category rebuild never touches the other category's cached ids", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  const terminal = await controller.openWorker({
    category: "terminals",
    title: "bt-1",
    cwd: "C:\\w",
    launch: ["tail", "-F"],
  });
  const subagent = await controller.openWorker({
    category: "subagents",
    title: "sa",
    cwd: "C:\\w",
    launch: ["node", "cli.js"],
    agent: { label: "sa", state: "idle" },
  });
  assert.ok(terminal && subagent);
  // Kill ONLY the terminals tab (it was the initial tab — the claim must
  // move to the rebuilt tab, never double-claiming the workspace's root).
  herdr.failNextOnce("pane not found: w1:p1");
  const rebuilt = await controller.openWorker({
    category: "terminals",
    title: "bt-2",
    cwd: "C:\\w",
    launch: ["tail", "-F"],
  });
  assert.ok(rebuilt);
  // The subagents pane is untouched: still the SAME pane id, no new open.
  assert.equal(subagent.paneId, "w1:p2");
  assert.equal(
    herdr.callCount("tab create"),
    2,
    "only the terminals tab is rebuilt (w1:t2 subagents + new terminals tab)",
  );
});

test("a user-closed split target never lets a live sibling be forgotten", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  const first = await controller.openWorker({
    category: "terminals",
    title: "t1",
    cwd: "C:\\work",
    launch: ["tail", "-F"],
  });
  const second = await controller.openWorker({
    category: "terminals",
    title: "t2",
    cwd: "C:\\work",
    launch: ["tail", "-F"],
  });
  assert.ok(first && second);
  assert.equal(herdr.liveWorkspaces().length, 1);
  // The user closes the split target (the tab and its root pane survive): the
  // next split reports it missing and the category rebuilds a tab.
  herdr.failNextOnce("pane not found: w1:p2");
  const rebuilt = await controller.openWorker({
    category: "terminals",
    title: "t3",
    cwd: "C:\\work",
    launch: ["tail", "-F"],
  });
  assert.ok(rebuilt);
  // Closing the rebuilt pane must NOT forget the workspace: the sibling pane's
  // teardown was never confirmed, so it may still be live.
  await rebuilt.close();
  assert.equal(
    controller.workspaceId,
    "w1",
    "an unconfirmed sibling keeps the workspace owned",
  );
  // The next allocation reuses the owned workspace instead of leaking a second.
  const later = await controller.openWorker({
    category: "terminals",
    title: "t4",
    cwd: "C:\\work",
    launch: ["tail", "-F"],
  });
  assert.ok(later);
  assert.equal(herdr.callCount("workspace create"), 1);
});

test("an unconfirmed stale-workspace close keeps ownership (no orphan)", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  await controller.openWorker({
    category: "terminals",
    title: "t1",
    cwd: "C:\\work",
    launch: ["tail", "-F"],
  });
  // The category rebuild fails in a dead workspace, and the close of that
  // stale workspace cannot be confirmed (transport failure).
  herdr.failNextOnce("pane not found: w1:p1");
  herdr.failNextOnce("workspace not found: w1");
  herdr.failNextCommand("workspace close", 1, "transport unavailable");
  const next = await controller.openWorker({
    category: "terminals",
    title: "t2",
    cwd: "C:\\work",
    launch: ["tail", "-F"],
  });
  assert.equal(
    next,
    undefined,
    "no replacement beside a possibly-live workspace",
  );
  assert.equal(
    controller.workspaceId,
    "w1",
    "ownership survives an unconfirmed workspace close",
  );
  assert.deepEqual(herdr.liveWorkspaces(), ["w1"]);
});

// --- observer lifecycle: settle / take-over ----------------------------------------

test("observer settle stops only the tail, then closes the pane", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  const observer = await controller.openObserver({
    terminalId: "bt-1",
    title: "dev server",
    cwd: "C:\\work",
    stdoutPath: "C:\\s\\bt-1.stdout.log",
    stderrPath: "C:\\s\\bt-1.stderr.log",
  });
  assert.ok(observer);
  const run = herdr.calls.find((a) => a[1] === "run")!;
  const launch = run.slice(3);
  assert.deepEqual(
    [...launch],
    [
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "'$paths=@(''C:\\s\\bt-1.stdout.log'',''C:\\s\\bt-1.stderr.log''); $jobs=@($paths | ForEach-Object { Start-Job -ScriptBlock { param($p) Get-Content -LiteralPath $p -Wait } -ArgumentList $_ }); Receive-Job -Job $jobs -Wait -AutoRemoveJob'",
    ],
  );
  await observer.settle();
  const keys = herdr.calls.map((a) => `${a[0]} ${a[1]}`);
  const sendIdx = keys.indexOf("pane send-keys");
  const closeIdx = keys.indexOf("pane close");
  assert.ok(sendIdx >= 0 && closeIdx > sendIdx, keys.join(", "));
  const send = herdr.calls.find((a) => a[1] === "send-keys")!;
  assert.deepEqual([...send], ["pane", "send-keys", "w1:p1", "ctrl+c"]);
});

test("taken-over observer keeps its pane at the shell prompt on settle", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  const observer = await controller.openObserver({
    terminalId: "bt-1",
    title: "dev server",
    cwd: "C:\\work",
    stdoutPath: "a.log",
    stderrPath: "b.log",
  });
  assert.ok(observer);
  assert.equal(await observer.takeOver(), true);
  assert.equal(observer.takenOver, true);
  await observer.settle();
  const keys = herdr.calls.map((a) => `${a[0]} ${a[1]}`);
  assert.ok(keys.includes("pane send-keys"), keys.join(", "));
  assert.equal(keys.includes("pane close"), false, keys.join(", "));
});

test("settle is idempotent: one ctrl+c and one close", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  const observer = await controller.openObserver({
    terminalId: "bt-1",
    title: "t",
    cwd: "C:\\work",
    stdoutPath: "a.log",
    stderrPath: "b.log",
  });
  assert.ok(observer);
  await observer.settle();
  await observer.settle();
  assert.equal(herdr.callCount("pane send-keys"), 1);
  assert.equal(herdr.callCount("pane close"), 1);
});

test("takeOver focuses workspace then tab then pane", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  const observer = await controller.openObserver({
    terminalId: "bt-1",
    title: "t",
    cwd: "C:\\work",
    stdoutPath: "a.log",
    stderrPath: "b.log",
  });
  assert.ok(observer);
  await observer.takeOver();
  const focus = herdr.calls.filter((a) => a[1] === "focus");
  assert.deepEqual(
    focus.map((args) => [...args]),
    [
      ["workspace", "focus", "w1"],
      ["tab", "focus", "w1:t1"],
      ["agent", "focus", "w1:p1"],
    ],
  );
});

test("concurrent takeOver calls focus exactly once (focus race)", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  const observer = await controller.openObserver({
    terminalId: "bt-1",
    title: "t",
    cwd: "C:\\work",
    stdoutPath: "a.log",
    stderrPath: "b.log",
  });
  assert.ok(observer);
  const [a, b] = await Promise.all([observer.takeOver(), observer.takeOver()]);
  assert.equal(a, true);
  assert.equal(b, true);
  assert.equal(herdr.callCount("workspace focus"), 1);
  assert.equal(herdr.callCount("tab focus"), 1);
  assert.equal(herdr.callCount("agent focus"), 1);
});

test("takeOver after the pane was closed by settle reports false", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  const observer = await controller.openObserver({
    terminalId: "bt-1",
    title: "t",
    cwd: "C:\\work",
    stdoutPath: "a.log",
    stderrPath: "b.log",
  });
  assert.ok(observer);
  await observer.settle();
  assert.equal(await observer.takeOver(), false);
});

test("cosmetic workspace focus failures do not lose the take-over", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  const observer = await controller.openObserver({
    terminalId: "bt-1",
    title: "t",
    cwd: "C:\\work",
    stdoutPath: "a.log",
    stderrPath: "b.log",
  });
  assert.ok(observer);
  herdr.failNextOnce("workspace not found: w1");
  assert.equal(await observer.takeOver(), true);
  assert.equal(observer.takenOver, true);
});

test("a final pane focus failure reports takeover failure", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  const observer = await controller.openObserver({
    terminalId: "bt-1",
    title: "t",
    cwd: "C:\\work",
    stdoutPath: "a.log",
    stderrPath: "b.log",
  });
  assert.ok(observer);
  herdr.failNextCommand("agent focus", 1, "pane not found");
  assert.equal(await observer.takeOver(), false);
  assert.equal(observer.takenOver, false);
});

// --- pane handle commands -----------------------------------------------------------

test("handler run/sendKeys/rename/reportMetadata target the allocated pane", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  const pane = await controller.openWorker({
    category: "terminals",
    title: "t",
    cwd: "C:\\work",
    launch: ["tail", "-F"],
  });
  assert.ok(pane);
  herdr.calls.length = 0;
  await pane.run(["tail", "-F", "'more'"]);
  await pane.sendKeys("esc");
  await pane.rename("new title");
  await pane.reportMetadata({ title: "meta", displayAgent: "agent x" });
  assert.deepEqual(herdr.calls[0], [
    "pane",
    "run",
    "w1:p1",
    "tail",
    "-F",
    "'more'",
  ]);
  assert.deepEqual(herdr.calls[1], ["pane", "send-keys", "w1:p1", "esc"]);
  assert.deepEqual(herdr.calls[2], ["pane", "rename", "w1:p1", "new title"]);
  assert.deepEqual(herdr.calls[3], [
    "pane",
    "report-metadata",
    "w1:p1",
    "--title",
    "meta",
    "--display-agent",
    "agent x",
    "--source",
    "pi-workers",
  ]);
});

test("a failed root-pane open releases the category so the next open rebuilds", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  // The FIRST worker is hosted by the root pane; its pane run fails, so the
  // rollback closes that pane. It was the workspace's only pane, so Herdr
  // closes the workspace with it.
  herdr.failNextCommand("pane run", 1, "command failed");
  assert.equal(
    await controller.openWorker({
      category: "subagents",
      title: "t",
      cwd: "C:\\w",
      launch: ["node", "cli.js"],
    }),
    undefined,
  );
  assert.equal(
    controller.workspaceId,
    undefined,
    "the controller stops claiming the workspace the rollback killed",
  );
  // The next open builds a FRESH workspace and hosts the worker in its root
  // pane — it must never `tab create` into the closed one.
  const recovered = await controller.openWorker({
    category: "subagents",
    title: "t2",
    cwd: "C:\\w",
    launch: ["node", "cli.js"],
  });
  assert.ok(recovered);
  assert.equal(recovered.workspaceId, "w2");
  assert.equal(herdr.callCount("workspace create"), 2);
  assert.equal(
    herdr.calls.filter((a) => a[0] === "tab" && a[1] === "create").length,
    0,
    "a fresh workspace needs no extra tab for the first category",
  );
});

// --- disposal ----------------------------------------------------------------------

test("dispose closes the workspace once and is idempotent", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  await controller.ensureWorkspace();
  await controller.dispose();
  await controller.dispose();
  const closes = herdr.calls.filter((a) => a[1] === "close");
  assert.deepEqual(
    closes.map((args) => [...args]),
    [["workspace", "close", "w1"]],
  );
});

test("after dispose, openWorker refuses new work", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  await controller.ensureWorkspace();
  await controller.dispose();
  assert.equal(
    await controller.openWorker({
      category: "terminals",
      title: "t",
      cwd: "C:\\work",
      launch: ["tail", "-F"],
    }),
    undefined,
  );
});

test("a hung workspace close is bounded (times out instead of hanging disposal)", async () => {
  const runner: HerdrRunner = (args, _timeout) => {
    if (args[0] === "workspace" && args[1] === "create") {
      return Promise.resolve({
        result: {
          workspace: { workspace_id: "w1" },
          tab: { tab_id: "w1:t1" },
          root_pane: { pane_id: "w1:p1" },
        },
      });
    }
    if (args[0] === "workspace" && args[1] === "close") {
      return new Promise<HerdrCliEnvelope>(() => {}); // hangs
    }
    return Promise.resolve({});
  };
  const controller = createWorkerWorkspaceController({
    project: "p",
    sessionId: "s",
    projectRoot: "/tmp",
    environment: () => true,
    platform: "linux",
    runner,
    cliTimeoutMs: 500,
    closeTimeoutMs: 50,
  });
  await controller.ensureWorkspace();
  const started = Date.now();
  await controller.dispose();
  assert.ok(Date.now() - started < 400, "dispose returned inside the bound");
});

test("single close attempt is bounded when the runner never resolves", async () => {
  const calls: Array<ReadonlyArray<string>> = [];
  const controller = createWorkerWorkspaceController({
    project: "p",
    sessionId: "s",
    projectRoot: "/tmp",
    environment: () => true,
    platform: "linux",
    runner: (args, _timeout) => {
      calls.push(args);
      return new Promise<HerdrCliEnvelope>(() => {}); // never settles
    },
    cliTimeoutMs: 500,
    closeTimeoutMs: 50,
  });
  const started = Date.now();
  await controller.dispose(); // ensureWorkspace was never called; no close issued
  assert.equal(calls.length, 0);
  assert.ok(Date.now() - started < 1_000);
});

test("parallel openers never share a pane (allocation is serialized per category)", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  const [a, b] = await Promise.all([
    controller.openWorker({
      category: "terminals",
      title: "a",
      cwd: "C:\\w",
      launch: ["x"],
    }),
    controller.openWorker({
      category: "terminals",
      title: "b",
      cwd: "C:\\w",
      launch: ["x"],
    }),
  ]);
  assert.ok(a && b);
  assert.notEqual(a.paneId, b.paneId);
  assert.equal(a.workspaceId, b.workspaceId);
});

test("a dispose racing workspace creation closes the created workspace", async () => {
  let releaseCreate!: () => void;
  const closeCalls: string[][] = [];
  const runner: HerdrRunner = async (args) => {
    if (args[0] === "workspace" && args[1] === "create") {
      await new Promise<void>((resolve) => (releaseCreate = resolve));
      return Promise.resolve({
        result: {
          workspace: { workspace_id: "w9" },
          tab: { tab_id: "w9:t1" },
          root_pane: { pane_id: "w9:p1" },
        },
      });
    }
    if (args[0] === "workspace" && args[1] === "close") {
      closeCalls.push([...args]);
      return Promise.resolve({});
    }
    return Promise.resolve({});
  };
  const controller = createWorkerWorkspaceController({
    project: "p",
    sessionId: "s",
    projectRoot: "/tmp",
    environment: () => true,
    platform: "linux",
    runner,
    cliTimeoutMs: 2_000,
    closeTimeoutMs: 500,
  });
  const creating = controller.ensureWorkspace();
  await controller.dispose();
  releaseCreate();
  assert.equal(await creating, undefined);
  assert.deepEqual(closeCalls, [["workspace", "close", "w9"]]);
});

// --- truthful disposal: ownership survives an uncertain workspace close ------------

test("an unconfirmed workspace close keeps ownership and retries boundedly", async () => {
  // Regression: dispose() cleared every id BEFORE its bounded close and
  // ignored the outcome, so an uncertain close lost the workspace forever.
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  await controller.ensureWorkspace();
  // The next three close attempts fail on the transport.
  herdr.failNextCommand("workspace close", 3, "transport unavailable");

  await controller.dispose();
  assert.equal(
    controller.workspaceId,
    "w1",
    "an unconfirmed close keeps owning the workspace",
  );
  assert.deepEqual(herdr.liveWorkspaces(), ["w1"]);
  assert.equal(
    await controller.openWorker({
      category: "terminals",
      title: "t",
      cwd: "C:\\w",
      launch: ["x"],
    }),
    undefined,
    "no new work is allocated once disposal starts",
  );
  assert.equal(herdr.callCount("workspace create"), 1, "no replacement leaks");

  // Later dispose calls retry the retained close: ONE bounded attempt per
  // explicit call (never a loop), so a recovered transport can still confirm.
  await controller.dispose();
  await controller.dispose();
  assert.equal(
    herdr.callCount("workspace close"),
    3,
    "one close attempt per explicit dispose call",
  );
  assert.equal(
    controller.workspaceId,
    "w1",
    "ownership is retained truthfully, never reported closed",
  );

  // The transport recovers: the next explicit request confirms the close and
  // releases ownership — the retry budget is never exhausted permanently.
  await controller.dispose();
  assert.equal(herdr.callCount("workspace close"), 4);
  assert.equal(controller.workspaceId, undefined);
  assert.deepEqual(herdr.liveWorkspaces(), []);
});

test("a workspace close retry that succeeds releases ownership truthfully", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  await controller.ensureWorkspace();
  herdr.failNextCommand("workspace close", 1, "transport unavailable");

  await controller.dispose();
  assert.equal(controller.workspaceId, "w1", "attempt 1 was uncertain");

  await controller.dispose();
  assert.equal(
    controller.workspaceId,
    undefined,
    "a confirmed close releases ownership",
  );
  assert.deepEqual(herdr.liveWorkspaces(), []);
  assert.equal(herdr.callCount("workspace close"), 2);
});

test("concurrent dispose calls share one bounded close attempt", async () => {
  const herdr = fakeHerdr();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let onCloseStarted!: () => void;
  const closeStarted = new Promise<void>((resolve) => {
    onCloseStarted = resolve;
  });
  const gated: HerdrRunner = async (args, timeout) => {
    if (args[0] === "workspace" && args[1] === "close") {
      onCloseStarted();
      await gate;
    }
    return herdr.runner(args, timeout);
  };
  const controller = makeController({ herdr, runner: gated });
  await controller.ensureWorkspace();

  const first = controller.dispose();
  await closeStarted;
  const second = controller.dispose();
  release();
  await Promise.all([first, second]);

  assert.equal(
    herdr.callCount("workspace close"),
    1,
    "concurrent dispose calls never double-close",
  );
  assert.equal(controller.workspaceId, undefined);
  assert.deepEqual(herdr.liveWorkspaces(), []);
});

test("an open racing dispose abandons its pane instead of launching into the closing workspace", async () => {
  const herdr = fakeHerdr();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let onRenameStarted!: () => void;
  const renameStarted = new Promise<void>((resolve) => {
    onRenameStarted = resolve;
  });
  const gated: HerdrRunner = async (args, timeout) => {
    if (args[0] === "pane" && args[1] === "rename") {
      onRenameStarted();
      await gate;
    }
    return herdr.runner(args, timeout);
  };
  const controller = makeController({ herdr, runner: gated });

  const opening = controller.openWorker({
    category: "terminals",
    title: "a",
    cwd: "C:\\w",
    launch: ["x"],
  });
  await renameStarted; // the root pane is allocated, the open is suspended
  await controller.dispose();
  release();

  assert.equal(
    await opening,
    undefined,
    "the racing open is abandoned, not launched",
  );
  assert.equal(
    herdr.callCount("pane run"),
    0,
    "no work was launched into the closing workspace",
  );
  assert.deepEqual(
    herdr.liveWorkspaces(),
    [],
    "the abandoned pane left no orphan behind",
  );
});

test("disposeWorkerWorkspace retains an unconfirmed workspace and retries it", async () => {
  setWorkerWorkspaceForTests(undefined);
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  setWorkerWorkspaceForTests(controller);
  try {
    await controller.ensureWorkspace();
    herdr.failNextCommand("workspace close", 1, "transport unavailable");

    await disposeWorkerWorkspace();
    assert.equal(
      controller.workspaceId,
      "w1",
      "the registry retains the controller instead of discarding it",
    );
    assert.deepEqual(herdr.liveWorkspaces(), ["w1"]);

    // The next shutdown handler retries the retained controller.
    await disposeWorkerWorkspace();
    assert.equal(controller.workspaceId, undefined);
    assert.deepEqual(herdr.liveWorkspaces(), []);
    assert.equal(herdr.callCount("workspace close"), 2);
  } finally {
    setWorkerWorkspaceForTests(undefined);
  }
});

test("a replacement session reconciles an unconfirmed workspace before creating its own", async () => {
  setWorkerWorkspaceForTests(undefined);
  const herdr = fakeHerdr();
  const wiring = {
    runner: herdr.runner,
    environment: () => true,
    platform: "linux" as NodeJS.Platform,
    runRetryDeadlineMs: 5_000,
    runRetryDelayMs: 1,
    cliTimeoutMs: 2_000,
    closeTimeoutMs: 1_000,
  };
  try {
    const first = workerWorkspaceForSession(
      "p",
      "session-a",
      "/tmp/proj",
      wiring,
    );
    assert.equal(await first.ensureWorkspace(), "w1");
    herdr.failNextCommand("workspace close", 1, "transport unavailable");
    await disposeWorkerWorkspace();
    assert.equal(first.workspaceId, "w1", "session A's workspace stays owned");

    const second = workerWorkspaceForSession(
      "p",
      "session-b",
      "/tmp/proj",
      wiring,
    );
    assert.equal(
      await second.ensureWorkspace(),
      "w2",
      "the replacement session creates its own workspace",
    );
    assert.equal(
      first.workspaceId,
      undefined,
      "the previous close was retried (and confirmed) before the replacement",
    );
    assert.deepEqual(
      herdr.liveWorkspaces(),
      ["w2"],
      "no orphan survived beside the replacement",
    );
    assert.equal(herdr.callCount("workspace close"), 2);
    assert.equal(herdr.callCount("workspace create"), 2);
  } finally {
    await disposeWorkerWorkspace();
    setWorkerWorkspaceForTests(undefined);
  }
});

test("a recovered transport lets the replacement session proceed (no permanent dead-end)", async () => {
  setWorkerWorkspaceForTests(undefined);
  const herdr = fakeHerdr();
  const wiring = {
    runner: herdr.runner,
    environment: () => true,
    platform: "linux" as NodeJS.Platform,
    runRetryDeadlineMs: 5_000,
    runRetryDelayMs: 1,
    cliTimeoutMs: 2_000,
    closeTimeoutMs: 1_000,
  };
  try {
    const first = workerWorkspaceForSession(
      "p",
      "session-a",
      "/tmp/proj",
      wiring,
    );
    assert.equal(await first.ensureWorkspace(), "w1");
    // Three failed attempts (the dispose plus two reconcile passes) must not
    // exhaust the retry budget for the process lifetime.
    herdr.failNextCommand("workspace close", 3, "transport unavailable");
    await disposeWorkerWorkspace();
    assert.equal(first.workspaceId, "w1");

    const blocked = workerWorkspaceForSession(
      "p",
      "session-b",
      "/tmp/proj",
      wiring,
    );
    assert.equal(await blocked.ensureWorkspace(), undefined);
    const alsoBlocked = workerWorkspaceForSession(
      "p",
      "session-c",
      "/tmp/proj",
      wiring,
    );
    assert.equal(await alsoBlocked.ensureWorkspace(), undefined);

    // The transport recovers: the next session reconciles and creates its own
    // workspace instead of staying blocked forever.
    const second = workerWorkspaceForSession(
      "p",
      "session-d",
      "/tmp/proj",
      wiring,
    );
    assert.equal(await second.ensureWorkspace(), "w2");
    assert.equal(first.workspaceId, undefined);
    assert.deepEqual(herdr.liveWorkspaces(), ["w2"]);
  } finally {
    await disposeWorkerWorkspace();
    setWorkerWorkspaceForTests(undefined);
  }
});

test("a replacement session never builds beside an unconfirmable workspace", async () => {
  setWorkerWorkspaceForTests(undefined);
  const herdr = fakeHerdr();
  const wiring = {
    runner: herdr.runner,
    environment: () => true,
    platform: "linux" as NodeJS.Platform,
    runRetryDeadlineMs: 5_000,
    runRetryDelayMs: 1,
    cliTimeoutMs: 2_000,
    closeTimeoutMs: 1_000,
  };
  try {
    const first = workerWorkspaceForSession(
      "p",
      "session-a",
      "/tmp/proj",
      wiring,
    );
    assert.equal(await first.ensureWorkspace(), "w1");
    // Every close attempt fails on the transport: the old workspace stays owned.
    herdr.failNextCommand("workspace close", 8, "transport unavailable");
    await disposeWorkerWorkspace();
    assert.equal(first.workspaceId, "w1");

    const second = workerWorkspaceForSession(
      "p",
      "session-b",
      "/tmp/proj",
      wiring,
    );
    assert.equal(
      await second.ensureWorkspace(),
      undefined,
      "an unconfirmed predecessor blocks a replacement workspace",
    );
    assert.equal(herdr.callCount("workspace create"), 1);
    assert.deepEqual(herdr.liveWorkspaces(), ["w1"]);
  } finally {
    await disposeWorkerWorkspace();
    setWorkerWorkspaceForTests(undefined);
  }
});

test("a dispose racing workspace creation retains ownership when its close is uncertain", async () => {
  let releaseCreate!: () => void;
  const closeCalls: string[][] = [];
  const runner: HerdrRunner = async (args) => {
    if (args[0] === "workspace" && args[1] === "create") {
      await new Promise<void>((resolve) => (releaseCreate = resolve));
      return Promise.resolve({
        result: {
          workspace: { workspace_id: "w9" },
          tab: { tab_id: "w9:t1" },
          root_pane: { pane_id: "w9:p1" },
        },
      });
    }
    if (args[0] === "workspace" && args[1] === "close") {
      closeCalls.push([...args]);
      if (closeCalls.length === 1) throw new Error("transport unavailable");
      return Promise.resolve({});
    }
    return Promise.resolve({});
  };
  const controller = createWorkerWorkspaceController({
    project: "p",
    sessionId: "s",
    projectRoot: "/tmp",
    environment: () => true,
    platform: "linux",
    runner,
    cliTimeoutMs: 2_000,
    closeTimeoutMs: 500,
  });
  const creating = controller.ensureWorkspace();
  await controller.dispose();
  releaseCreate();
  assert.equal(await creating, undefined);
  assert.deepEqual(closeCalls, [["workspace", "close", "w9"]]);
  assert.equal(
    controller.workspaceId,
    "w9",
    "an uncertain racing close keeps ownership instead of forgetting the workspace",
  );
  await controller.dispose();
  assert.deepEqual(closeCalls, [
    ["workspace", "close", "w9"],
    ["workspace", "close", "w9"],
  ]);
  assert.equal(
    controller.workspaceId,
    undefined,
    "the retry confirmed teardown and released ownership",
  );
});

// --- singleton ---------------------------------------------------------------------

test("workerWorkspaceForSession shares one controller; disposal resets it", async () => {
  setWorkerWorkspaceForTests(undefined);
  try {
    const first = workerWorkspaceForSession("a", "s1", "/tmp");
    const second = workerWorkspaceForSession("a", "s1", "/tmp");
    assert.equal(first, second);
    await disposeWorkerWorkspace();
    const after = workerWorkspaceForSession("a", "s1", "/tmp");
    assert.notEqual(after, first);
  } finally {
    setWorkerWorkspaceForTests(undefined);
  }
});

test("independent ESM copies share the process-global workspace registry", async () => {
  setWorkerWorkspaceForTests(undefined);
  const copy = await import(`./herdr-workspace.ts?copy=${Date.now()}`);
  try {
    const first = workerWorkspaceForSession("agent", "parent", "/tmp/project");
    const second = copy.workerWorkspaceForSession(
      "agent",
      "parent",
      "/tmp/project",
    );
    assert.equal(second, first);
  } finally {
    await disposeWorkerWorkspace();
    copy.setWorkerWorkspaceForTests(undefined);
  }
});

test("disposeWorkerWorkspace with no controller resolves immediately", async () => {
  setWorkerWorkspaceForTests(undefined);
  await disposeWorkerWorkspace();
  assert.ok(true);
});

// --- dead-resource recognition (real Herdr error shapes) ---------------------------

test("isMissingHerdrResource recognizes the real Herdr error shapes", () => {
  // The machine code alone is enough (the message may name no id at all).
  assert.equal(
    isMissingHerdrResource(new HerdrCliError("EPANEMISSING", "pane_not_found")),
    true,
  );
  // The real envelope: code + a message with the id between resource and verdict.
  assert.equal(
    isMissingHerdrResource(
      new HerdrCliError(
        "workspace_not_found: workspace w1E not found",
        "workspace_not_found",
      ),
    ),
    true,
  );
  assert.equal(
    isMissingHerdrResource(new Error("workspace w1E not found")),
    true,
  );
  assert.equal(
    isMissingHerdrResource(new Error("pane not found: w1:p1")),
    true,
  );
  assert.equal(
    isMissingHerdrResource(new Error("tab was already closed")),
    true,
  );
  assert.equal(isMissingHerdrResource(new Error("agent is gone")), true);
  // Transient and unrelated failures must NOT trigger the rebuild path.
  assert.equal(isMissingHerdrResource(new Error("agent_pane_busy")), false);
  assert.equal(isMissingHerdrResource(new Error("command failed")), false);
  assert.equal(isMissingHerdrResource(new Error("herdr exited 1")), false);
});

test("a user-closed workspace rebuilds fresh instead of retrying the stale id", async () => {
  // Regression: Herdr's real dead-workspace error names the id between the
  // resource and the verdict. The recovery matcher required them adjacent, so
  // the rebuild never ran and every later spawn silently failed against the
  // closed workspace for the rest of the session.
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  const first = await controller.openWorker({
    category: "terminals",
    title: "bt-1",
    cwd: "C:\work",
    launch: ["tail", "-F"],
  });
  assert.equal(first?.workspaceId, "w1");
  // The user closes the whole "Pi Workers" workspace in Herdr.
  herdr.closeWorkspace("w1");
  const rebuilt = await controller.openWorker({
    category: "terminals",
    title: "bt-2",
    cwd: "C:\work",
    launch: ["tail", "-F"],
  });
  assert.ok(rebuilt, "the next worker still opens after the workspace died");
  assert.equal(rebuilt.workspaceId, "w2", "a fresh workspace is built");
  assert.equal(herdr.callCount("workspace create"), 2);
});

test("closing the last pane forgets the pane-less workspace", async () => {
  // Regression: closing the observer of a terminal that settled while its
  // pane was still opening took the workspace down with it, but the
  // controller kept the dead workspace id, so the next bg_start failed
  // `tab create` against a closed workspace and never spawned again.
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  const observer = await controller.openObserver({
    terminalId: "bt-1",
    title: "t",
    cwd: "C:\work",
    stdoutPath: "a.log",
    stderrPath: "b.log",
  });
  assert.ok(observer);
  const firstWorkspace = observer.pane.workspaceId;
  await observer.settle();
  assert.equal(
    controller.workspaceId,
    undefined,
    "the controller forgets the workspace Herdr just closed",
  );
  const next = await controller.openObserver({
    terminalId: "bt-2",
    title: "t2",
    cwd: "C:\work",
    stdoutPath: "c.log",
    stderrPath: "d.log",
  });
  assert.ok(next, "the next observer opens a fresh workspace");
  assert.notEqual(next.pane.workspaceId, firstWorkspace);
  assert.equal(herdr.callCount("workspace create"), 2);
  assert.equal(
    herdr.calls.filter((a) => a[0] === "tab" && a[1] === "create").length,
    0,
    "no wasted tab create against the closed workspace",
  );
});

test("a taken-over observer pane keeps the workspace alive for the next worker", async () => {
  const herdr = fakeHerdr();
  const controller = makeController({ herdr });
  const observer = await controller.openObserver({
    terminalId: "bt-1",
    title: "t",
    cwd: "C:\work",
    stdoutPath: "a.log",
    stderrPath: "b.log",
  });
  assert.ok(observer);
  assert.equal(await observer.takeOver(), true);
  await observer.settle();
  assert.equal(
    controller.workspaceId,
    "w1",
    "a taken-over pane survives settle, so the workspace stays",
  );
  const next = await controller.openObserver({
    terminalId: "bt-2",
    title: "t2",
    cwd: "C:\work",
    stdoutPath: "c.log",
    stderrPath: "d.log",
  });
  assert.ok(next);
  assert.equal(next.pane.workspaceId, "w1", "reused workspace");
  assert.equal(herdr.callCount("workspace create"), 1);
});
