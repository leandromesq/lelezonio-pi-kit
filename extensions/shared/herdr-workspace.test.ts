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
  /** Queued failures, consumed in order by matching command key. */
  const failures: Array<{ count: number; message: string; command: string }> =
    [];

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
        throw new Error(failure.message);
      }
    }
    switch (key) {
      case "workspace create": {
        workspaceCounter += 1;
        const ws = `w${workspaceCounter}`;
        return {
          result: {
            workspace: { workspace_id: ws },
            tab: { tab_id: `${ws}:t1` },
            root_pane: { pane_id: nextPane(ws) },
          },
        };
      }
      case "tab create": {
        const ws = args[args.indexOf("--workspace") + 1];
        const tabNumber = (callCounts.get("tab create") ?? 0) + 1;
        const tabId = `${ws}:t${tabNumber}`;
        return {
          result: {
            tab: { tab_id: tabId },
            root_pane: { pane_id: nextPane(ws) },
          },
        };
      }
      case "pane split": {
        const workspaceId = args[2].split(":")[0];
        return { result: { pane: { pane_id: nextPane(workspaceId) } } };
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
      failures.push({ count: 1, message, command: "*" });
    },
    failNextCommand: (command: string, count: number, message: string) => {
      failures.push({ count, message, command });
    },
  };
}

function makeController(options: {
  herdr: ReturnType<typeof fakeHerdr>;
  environment?: () => boolean;
  project?: string;
  sessionId?: string;
  platform?: NodeJS.Platform;
  runRetryDeadlineMs?: number;
}) {
  const controller = createWorkerWorkspaceController({
    project: options.project ?? "proj",
    sessionId: options.sessionId ?? "01234567-89ab-cdef",
    projectRoot: "C:\\work\\proj",
    runner: options.herdr.runner,
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
  // The FIRST worker is hosted by the root pane; its pane run fails.
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
  // The category is reset: the next open creates a fresh tab (and pane)
  // instead of reusing the closed root pane.
  const recovered = await controller.openWorker({
    category: "subagents",
    title: "t2",
    cwd: "C:\\w",
    launch: ["node", "cli.js"],
  });
  assert.ok(recovered);
  assert.equal(recovered.paneId, "w1:p2");
  const created = herdr.calls.filter(
    (a) => a[0] === "tab" && a[1] === "create",
  );
  assert.equal(
    created.length,
    1,
    "a new tab is created after the root rollback",
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
