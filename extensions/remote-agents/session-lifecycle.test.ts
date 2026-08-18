import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  createExtensionRuntime,
  discoverAndLoadExtensions,
  ExtensionRunner,
  SessionManager,
  type ExtensionError,
  type ExtensionUIContext,
  type ModelRegistry,
  type SessionShutdownEvent,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";

/**
 * Regression test for the stale-context crash in session_start:
 *
 * session_start kicks off getManager() as a detached promise. Its catch
 * handler captures ctx.ui. When /new or /reload shuts the session down and
 * the runner invalidates the captured ctx while initialization is still in
 * flight (widened by a slow SSH), the notify() call throws on the stale ctx
 * inside the catch handler, producing an unhandled rejection.
 *
 * The test drives the REAL extension through the REAL pi loader and
 * ExtensionRunner, with an agent dir pointing at a fake delayed ssh
 * executable, so it is deterministic, seconds-long, and needs no network.
 */

const SSH_DELAY_MS = 800;

const ENV_VARS = [
  "PI_CODING_AGENT_DIR",
  "FAKE_SSH_LOG",
  "FAKE_SSH_DELAY_S",
] as const;

interface TestEnv {
  directory: string;
  agentDir: string;
  sshLog: string;
}

async function createEnv(): Promise<TestEnv> {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "remote-agents-session-"),
  );
  const agentDir = path.join(directory, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const sshLog = path.join(directory, "ssh.log");
  const sshScript = path.join(directory, "fake-ssh.sh");
  // Delayed, failing ssh: every invocation logs its start, sleeps, and exits
  // nonzero, so the manager initialization is still in flight when the test
  // shuts the session down.
  fs.writeFileSync(
    sshScript,
    [
      "#!/bin/sh",
      'echo started >> "$FAKE_SSH_LOG"',
      'sleep "$FAKE_SSH_DELAY_S"',
      'echo "fake ssh: remote host unreachable" >&2',
      "exit 255",
      "",
    ].join("\n"),
  );
  fs.chmodSync(sshScript, 0o700);
  fs.writeFileSync(
    path.join(agentDir, "remote-agents.json"),
    JSON.stringify({
      host: "fake-host",
      sshExecutable: sshScript,
      remoteHelper: path.join(directory, "helper.py"),
      projectsRoot: "/fake/Projects",
      worktreesRoot: "/fake/Worktrees",
      pollIntervalMs: 60_000,
      maxConcurrent: 3,
    }),
  );
  setEnv("PI_CODING_AGENT_DIR", agentDir);
  setEnv("FAKE_SSH_LOG", sshLog);
  setEnv("FAKE_SSH_DELAY_S", String(SSH_DELAY_MS / 1000));
  return { directory, agentDir, sshLog };
}

function setEnv(name: string, value: string) {
  process.env[name] = value;
}

function restoreEnv(previous: Record<string, string | undefined>) {
  for (const name of ENV_VARS) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name]!;
  }
}

interface FakeUi {
  ui: ExtensionUIContext;
  notifyCalls: Array<{ message: string; type: string | undefined }>;
  statusCalls: Array<{ key: string; text: string | undefined }>;
}

function createFakeUi(): FakeUi {
  const notifyCalls: FakeUi["notifyCalls"] = [];
  const statusCalls: FakeUi["statusCalls"] = [];
  const ui: ExtensionUIContext = {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: (message, type) => {
      notifyCalls.push({ message, type });
    },
    onTerminalInput: () => () => {},
    setStatus: (key, text) => {
      statusCalls.push({ key, text });
    },
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async <T>(..._args: unknown[]) => undefined as T,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    // The extension only calls theme.fg() while jobs exist; these tests run
    // with an empty registry, so a pass-through is sufficient.
    theme: {
      fg: (_color: ThemeColor, text: string) => text,
    } as unknown as Theme,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "not available" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
  return { ui, notifyCalls, statusCalls };
}

interface RunnerHarness {
  runner: ExtensionRunner;
  ui: FakeUi;
  errors: ExtensionError[];
}

async function createHarness(env: TestEnv): Promise<RunnerHarness> {
  // Load the real extension through the real pi loader (jiti), exactly like
  // pi does for auto-discovered extensions. The factory reads the agent dir
  // config (PI_CODING_AGENT_DIR is set by createEnv) and the fake ssh it
  // points to is what makes initialization slow and failing.
  const loaded = await discoverAndLoadExtensions(
    [path.resolve(import.meta.dirname, "index.ts")],
    env.directory,
    env.agentDir,
  );
  assert.deepEqual(
    loaded.errors,
    [],
    "expected the real extension to load without errors",
  );
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    env.directory,
    SessionManager.inMemory(env.directory),
    undefined as unknown as ModelRegistry, // unused: tested paths never read ctx.modelRegistry
  );
  const ui = createFakeUi();
  runner.setUIContext(ui.ui, "tui");
  const errors: ExtensionError[] = [];
  runner.onError((error) => errors.push(error));
  return { runner, ui, errors };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await sleep(25);
  }
}

function sshStarted(env: TestEnv) {
  return () =>
    fs.existsSync(env.sshLog) && fs.readFileSync(env.sshLog, "utf8").length > 0;
}

/** Wait long enough for the delayed initialization chain to fully settle. */
function settleDelay() {
  return sleep(SSH_DELAY_MS + 600);
}

for (const reason of ["new", "reload"] as const) {
  test(`session teardown during delayed initialization is silent (${reason})`, async () => {
    const previousEnv: Record<string, string | undefined> = {};
    for (const name of ENV_VARS) previousEnv[name] = process.env[name];
    const rejections: unknown[] = [];
    const onRejection = (value: unknown) => {
      rejections.push(value);
    };
    process.on("unhandledRejection", onRejection);
    const env = await createEnv();
    try {
      const { runner, ui, errors } = await createHarness(env);
      await runner.emit({ type: "session_start", reason: "startup" });
      // Make sure the delayed ssh is in flight before tearing down: this is
      // the race that used to crash (SSH delay widens it).
      await waitFor(sshStarted(env), "fake ssh to start");
      await runner.emit({ type: "session_shutdown", reason });
      // Mirrors AgentSession.dispose(): the old runner's ctx becomes stale.
      runner.invalidate();
      await settleDelay();
      // Extra margin: the rejection (if any) must have surfaced by now.
      await sleep(200);

      assert.deepEqual(
        rejections,
        [],
        `expected zero unhandled rejections after session_shutdown (${reason})`,
      );
      assert.deepEqual(
        ui.notifyCalls,
        [],
        "expected expected teardown during initialization to be silent",
      );
      assert.deepEqual(
        errors,
        [],
        "expected no errors reported through the extension runner",
      );
    } finally {
      process.removeListener("unhandledRejection", onRejection);
      restoreEnv(previousEnv);
      fs.rmSync(env.directory, { recursive: true, force: true });
    }
  });
}

test("initialization failure while current is contained and graceful shutdown stays silent", async () => {
  const previousEnv: Record<string, string | undefined> = {};
  for (const name of ENV_VARS) previousEnv[name] = process.env[name];
  const rejections: unknown[] = [];
  const onRejection = (value: unknown) => {
    rejections.push(value);
  };
  process.on("unhandledRejection", onRejection);
  const env = await createEnv();
  try {
    const { runner, ui, errors } = await createHarness(env);
    await runner.emit({ type: "session_start", reason: "startup" });
    await waitFor(sshStarted(env), "fake ssh to start");
    await settleDelay();
    await sleep(200);

    assert.deepEqual(
      rejections,
      [],
      "expected zero unhandled rejections while the session stays current",
    );
    // The manager swallows the ssh failure during reconcile and comes up
    // degraded; there is nothing to report to the user.
    assert.deepEqual(
      ui.notifyCalls,
      [],
      "expected ssh failure during reconcile not to notify",
    );
    // updateStatus() ran after initialization completed: the status line was
    // cleared because the registry is empty.
    assert.ok(
      ui.statusCalls.some(
        (call) => call.key === "remote-agents" && call.text === undefined,
      ),
      "expected initialization to complete and update the status line",
    );
    assert.deepEqual(errors, []);

    // Graceful teardown afterwards must also stay silent.
    await runner.emit({ type: "session_shutdown", reason: "quit" });
    runner.invalidate();
    await sleep(200);
    assert.deepEqual(
      rejections,
      [],
      "expected zero unhandled rejections after graceful shutdown",
    );
  } finally {
    process.removeListener("unhandledRejection", onRejection);
    restoreEnv(previousEnv);
    fs.rmSync(env.directory, { recursive: true, force: true });
  }
});
