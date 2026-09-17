/**
 * End-to-end tests: manager behavior through a real ManagedRuntime with real
 * child processes, exactly as the tool handlers drive it. Commands use
 * `node -e` one-liners for portability (node exists on any machine running
 * pi). Tests are event-driven (kill()/nextChange/settle hooks), not
 * timing-based.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import type { TerminalSnapshot } from "./src/domain.ts";
import {
  MAX_RUNNING,
  MAX_TRACKED,
  platformDefaultShell,
  setTerminalShell,
  shellInvocation,
  TerminalManager,
  terminalShell,
  type TerminalManagerShape,
} from "./src/manager.ts";
import { createTerminalRuntime, runTool } from "./src/runtime.ts";

const cwd = process.cwd();

/** Encode a `node -e` script so the same command survives cmd.exe and sh. */
function nodeCmd(script: string) {
  const encoded = Buffer.from(script).toString("base64");
  return `node -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}

async function withManager(
  run: (
    manager: TerminalManagerShape,
    runtime: ReturnType<typeof createTerminalRuntime>,
  ) => Promise<void>,
) {
  const runtime = createTerminalRuntime();
  try {
    const manager = await runtime.runPromise(TerminalManager);
    await run(manager, runtime);
  } finally {
    await runtime.dispose();
  }
}

/** Resolve when the given terminal settles (via the manager's settle hook). */
function settlement(manager: TerminalManagerShape, id: string) {
  return new Promise<{ snap: TerminalSnapshot; consumed: boolean }>(
    (resolve) => {
      const existing = manager.view.get(id);
      if (existing && existing.status !== "running") {
        resolve({ snap: existing, consumed: false });
        return;
      }
      const unsub = manager.view.subscribeTo(id, () => {
        const snap = manager.view.get(id);
        if (snap && snap.status !== "running") {
          unsub();
          resolve({ snap, consumed: false });
        }
      });
    },
  );
}

function processGone(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function pollUntil(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

test("happy path: stdout and stderr captured separately, settles done, hook fires once unconsumed", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; status: string; consumed: boolean }> =
      [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, status: snap.status, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.start({
        command: nodeCmd(
          'process.stdout.write("out-line\\n"); process.stderr.write("err-line\\n");',
        ),
        title: "happy",
        cwd,
      }),
    );
    assert.equal(snap.status, "running");
    assert.ok(snap.pid);

    const { snap: done } = await settlement(manager, snap.id);
    assert.equal(done.status, "done");
    assert.equal(done.exitCode, 0);
    assert.equal(done.signal, undefined);
    assert.equal(done.stdout.text, "out-line\n");
    assert.equal(done.stderr.text, "err-line\n");
    assert.ok(done.settledAt);
    assert.deepEqual(settled, [
      { id: snap.id, status: "done", consumed: false },
    ]);

    // Spill files hold the full capture.
    if (done.stdout.spillPath) {
      assert.equal(
        fs.readFileSync(done.stdout.spillPath, "utf8"),
        "out-line\n",
      );
      if (process.platform !== "win32") {
        assert.equal(fs.statSync(done.stdout.spillPath).mode & 0o777, 0o600);
        assert.equal(
          fs.statSync(path.dirname(done.stdout.spillPath)).mode & 0o777,
          0o700,
        );
      }
    }
    if (done.stderr.spillPath) {
      assert.equal(
        fs.readFileSync(done.stderr.spillPath, "utf8"),
        "err-line\n",
      );
    }
  });
});

test("non-zero exit settles as failed with the exit code", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.start({
        command: nodeCmd("process.exit(3)"),
        title: "fails",
        cwd,
      }),
    );
    const { snap: failed } = await settlement(manager, snap.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.exitCode, 3);
  });
});

test("kill settles a never-exiting process as killed and resolves after settle; repeat kill is a no-op", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.start({
        command: nodeCmd("setInterval(() => {}, 1000)"),
        title: "immortal",
        cwd,
      }),
    );
    assert.equal(snap.status, "running");

    const report = await runTool(runtime, manager.kill([snap.id]));
    assert.equal(report.length, 1);
    assert.equal(report[0].id, snap.id);
    assert.equal(report[0].title, "immortal");
    assert.equal(report[0].status, "killed");
    assert.equal(report[0].killed, true);
    assert.equal(report[0].wasRunning, true);
    assert.ok(report[0].exit.length > 0);
    const after = manager.view.get(snap.id);
    assert.equal(after?.status, "killed");
    // POSIX kills are signal-based (SIGTERM → SIGKILL). A Windows kill cannot
    // be: `taskkill /T /F` force-terminates the tree and the OS reports a
    // plain exit code with NO signal — the same reason the SIGTERM-grace tests
    // in this file already skip on win32. The user-facing contract (status
    // "killed", killed true, wasRunning true) is identical on both platforms;
    // only the exit detail differs. Reporting a fabricated SIGTERM here would
    // be a lie about how the process actually died.
    if (process.platform === "win32") {
      assert.equal(after?.signal, undefined);
      assert.equal(/^SIG/.test(report[0].exit), false);
    } else {
      assert.match(report[0].exit, /^SIG/);
      assert.ok(after?.signal);
    }

    const second = await runTool(runtime, manager.kill([snap.id]));
    assert.equal(second[0].killed, false);
    assert.equal(second[0].wasRunning, false);
    assert.equal(second[0].status, "killed");
  });
});

test(
  "a SIGTERM-resistant child is escalated to SIGKILL within the teardown bound",
  { skip: process.platform === "win32" },
  async () => {
    await withManager(async (manager, runtime) => {
      const snap = await runTool(
        runtime,
        manager.start({
          command: `exec ${nodeCmd(
            'process.on("SIGTERM", () => process.stdout.write("term\\n")); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);',
          )}`,
          title: "term-resistant",
          cwd,
        }),
      );
      assert.ok(
        await pollUntil(() =>
          (manager.view.get(snap.id)?.stdout.text ?? "").includes("ready"),
        ),
        "child installed its SIGTERM handler",
      );

      const startedAt = Date.now();
      const [result] = await runTool(runtime, manager.kill([snap.id]));
      const elapsed = Date.now() - startedAt;

      assert.equal(result.status, "killed");
      assert.equal(manager.view.get(snap.id)?.signal, "SIGKILL");
      assert.match(manager.view.get(snap.id)?.stdout.text ?? "", /term/);
      assert.ok(elapsed >= 1_500, `SIGKILL was not immediate (${elapsed}ms)`);
      assert.ok(
        elapsed < 4_500,
        `termination exceeded its bound (${elapsed}ms)`,
      );
    });
  },
);

test("concurrent overlapping multi-id kills observe each settlement exactly once", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );
    const [first, second] = await runTool(
      runtime,
      Effect.forEach(
        ["first", "second"],
        (title) =>
          manager.start({
            command: nodeCmd("setInterval(() => {}, 1000)"),
            title,
            cwd,
          }),
        { concurrency: "unbounded" },
      ),
    );

    const reports = await runTool(
      runtime,
      Effect.all(
        [
          manager.kill([first.id, second.id, first.id]),
          manager.kill([second.id, first.id]),
        ],
        { concurrency: "unbounded" },
      ),
    );

    assert.deepEqual(
      reports.map((report) => report.map((entry) => entry.id)),
      [
        [first.id, second.id],
        [second.id, first.id],
      ],
    );
    assert.ok(reports.flat().every((entry) => entry.status === "killed"));
    assert.deepEqual(
      settled.sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: first.id, consumed: true },
        { id: second.id, consumed: true },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});

test(
  "kill terminates the whole process tree (grandchildren die)",
  { skip: process.platform === "win32" },
  async () => {
    await withManager(async (manager, runtime) => {
      const sentinelDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "bt-tree-test-"),
      );
      const sentinel = path.join(sentinelDir, "heartbeat");
      const snap = await runTool(
        runtime,
        manager.start({
          // sh spawns node in the background and prints the grandchild pid,
          // then waits forever so the group stays alive.
          command: `node -e 'const fs = require("node:fs"); const file = ${JSON.stringify(sentinel)}; let n = 0; fs.writeFileSync(file, String(n)); setInterval(() => fs.writeFileSync(file, String(++n)), 25)' & echo "child:$!"; wait`,
          title: "tree",
          cwd,
        }),
      );

      // Wait for the grandchild pid line.
      assert.ok(
        await pollUntil(() =>
          (manager.view.get(snap.id)?.stdout.text ?? "").includes("child:"),
        ),
        "grandchild pid was printed",
      );
      const text = manager.view.get(snap.id)?.stdout.text ?? "";
      const match = /child:(\d+)/.exec(text);
      assert.ok(match, "parsed grandchild pid");
      const grandchild = Number(match[1]);
      assert.equal(processGone(grandchild), false);
      assert.ok(
        await pollUntil(() => fs.existsSync(sentinel)),
        "heartbeat exists",
      );
      const heartbeatBefore = fs.readFileSync(sentinel, "utf8");
      assert.ok(
        await pollUntil(
          () => fs.readFileSync(sentinel, "utf8") !== heartbeatBefore,
        ),
        "heartbeat belongs to the live grandchild",
      );

      await runTool(runtime, manager.kill([snap.id]));
      assert.ok(
        await pollUntil(() => processGone(grandchild)),
        "grandchild process is gone after group kill",
      );
      const stoppedAt = fs.readFileSync(sentinel, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(
        fs.readFileSync(sentinel, "utf8"),
        stoppedAt,
        "the unique grandchild heartbeat stopped",
      );
      fs.rmSync(sentinelDir, { recursive: true, force: true });
    });
  },
);

test(
  "a shell exit with inherited pipes open settles naturally and reaps descendants",
  { skip: process.platform === "win32" },
  async () => {
    await withManager(async (manager, runtime) => {
      const snap = await runTool(
        runtime,
        manager.start({
          command: `node -e "setInterval(()=>{},1e3)" & echo "child:$!"; exit 0`,
          title: "exited-shell",
          cwd,
        }),
      );
      assert.ok(
        await pollUntil(() =>
          (manager.view.get(snap.id)?.stdout.text ?? "").includes("child:"),
        ),
        "descendant pid was printed",
      );
      const match = /child:(\d+)/.exec(
        manager.view.get(snap.id)?.stdout.text ?? "",
      );
      assert.ok(match);
      const grandchild = Number(match[1]);
      assert.ok(snap.pid);
      assert.ok(await pollUntil(() => processGone(snap.pid!)), "shell exited");
      assert.equal(manager.view.get(snap.id)?.status, "running");

      assert.ok(
        await pollUntil(
          () => manager.view.get(snap.id)?.status !== "running",
          7_000,
        ),
        "entry settled after the bounded post-exit grace",
      );
      assert.equal(manager.view.get(snap.id)?.status, "done");
      assert.equal(manager.view.get(snap.id)?.exitCode, 0);
      assert.ok(
        await pollUntil(() => processGone(grandchild)),
        "surviving process-group descendant was reaped",
      );
    });
  },
);

test(
  "kill preserves a natural exit observed before the signal point",
  { skip: process.platform === "win32" },
  async () => {
    await withManager(async (manager, runtime) => {
      const snap = await runTool(
        runtime,
        manager.start({
          command: `node -e "setInterval(()=>{},1e3)" & echo "child:$!"; exit 0`,
          title: "natural-race",
          cwd,
        }),
      );
      assert.ok(
        await pollUntil(() =>
          (manager.view.get(snap.id)?.stdout.text ?? "").includes("child:"),
        ),
      );
      const match = /child:(\d+)/.exec(
        manager.view.get(snap.id)?.stdout.text ?? "",
      );
      assert.ok(match);
      const grandchild = Number(match[1]);
      assert.ok(snap.pid);
      assert.ok(await pollUntil(() => processGone(snap.pid!)));
      assert.equal(manager.view.get(snap.id)?.status, "running");

      const [result] = await runTool(runtime, manager.kill([snap.id]));
      assert.equal(result.wasRunning, true);
      assert.equal(result.killed, false);
      assert.equal(result.status, "done");
      assert.equal(result.exit, "exit 0");
      assert.ok(await pollUntil(() => processGone(grandchild)));
    });
  },
);

test("concurrency cap rejects an extra start; a failed spawn releases its slot", async () => {
  await withManager(async (manager, runtime) => {
    const spawns = await runTool(
      runtime,
      Effect.forEach(
        Array.from({ length: MAX_RUNNING }, (_, n) => n),
        (n) =>
          manager.start({
            command: nodeCmd("setInterval(() => {}, 1000)"),
            title: `filler-${n}`,
            cwd,
          }),
        { concurrency: "unbounded" },
      ),
    );
    assert.equal(spawns.length, MAX_RUNNING);
    await assert.rejects(
      runTool(runtime, manager.start({ command: "true", title: "extra", cwd })),
      new RegExp(`Max ${MAX_RUNNING} background terminals`),
    );

    // Free one slot; a bogus binary settles as failed near-instantly (the
    // 'error'/'exit' path), leaving the slot free again.
    await runTool(runtime, manager.kill([spawns[0].id]));
    const bogus = await runTool(
      runtime,
      manager.start({
        command: "definitely-not-a-real-binary-12345",
        title: "bogus",
        cwd,
      }),
    );
    const { snap: settled } = await settlement(manager, bogus.id);
    assert.equal(settled.status, "failed");
    // The settled bogus entry does not occupy a running slot.
    const again = await runTool(
      runtime,
      manager.start({
        command: nodeCmd("setInterval(() => {}, 1000)"),
        title: "refill",
        cwd,
      }),
    );
    assert.equal(again.status, "running");
  });
});

test("a settle during an in-flight kill reports consumed: true", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );
    const snap = await runTool(
      runtime,
      manager.start({
        command: nodeCmd("setInterval(() => {}, 1000)"),
        title: "consumed",
        cwd,
      }),
    );
    await runTool(runtime, manager.kill([snap.id]));
    assert.deepEqual(settled, [{ id: snap.id, consumed: true }]);
  });
});

test("UI requestKill settles as killed and is NOT consumed", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; status: string; consumed: boolean }> =
      [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, status: snap.status, consumed }),
    );
    const snap = await runTool(
      runtime,
      manager.start({
        command: nodeCmd("setInterval(() => {}, 1000)"),
        title: "ui-kill",
        cwd,
      }),
    );
    manager.view.requestKill(snap.id);
    const { snap: after } = await settlement(manager, snap.id);
    assert.equal(after.status, "killed");
    assert.deepEqual(settled, [
      { id: snap.id, status: "killed", consumed: false },
    ]);
  });
});

test("runtime.dispose kills running processes; no settle hook fires after dispose", async () => {
  const runtime = createTerminalRuntime();
  const manager = await runtime.runPromise(TerminalManager);
  const settled: string[] = [];
  manager.view.setOnSettled((snap) => settled.push(snap.id));

  const snap = await runTool(
    runtime,
    manager.start({
      command: nodeCmd("setInterval(() => {}, 1000)"),
      title: "disposed",
      cwd,
    }),
  );
  const pid = snap.pid;
  assert.ok(pid);

  await runtime.dispose();
  assert.ok(await pollUntil(() => processGone(pid)), "process killed");
  // The disposed guard suppressed the hook.
  assert.deepEqual(settled, []);
  // start after dispose is rejected (by the runtime itself, or by the
  // manager's disposed guard if the effect still runs).
  await assert.rejects(
    runTool(runtime, manager.start({ command: "true", title: "late", cwd })),
    /shutting down|disposed/,
  );
});

test("pruning drops the oldest settled entries past MAX_TRACKED, never running ones", async () => {
  await withManager(async (manager, runtime) => {
    const keeper = await runTool(
      runtime,
      manager.start({
        command: nodeCmd("setInterval(() => {}, 1000)"),
        title: "keeper",
        cwd,
      }),
    );

    const settledIds: string[] = [];
    for (let i = 0; i < MAX_TRACKED + 4; i++) {
      const snap = await runTool(
        runtime,
        manager.start({ command: "true", title: `quick-${i}`, cwd }),
      );
      settledIds.push(snap.id);
      await settlement(manager, snap.id);
    }

    const remaining = manager.view.list().map((snap) => snap.id);
    assert.equal(remaining.length <= MAX_TRACKED, true);
    // The running entry survived pruning.
    assert.equal(remaining.includes(keeper.id), true);
    // The earliest settled entries were pruned first.
    assert.equal(remaining.includes(settledIds[0]), false);
    // The latest settled entries survive.
    assert.equal(remaining.includes(settledIds[settledIds.length - 1]), true);

    const [historical] = await runTool(runtime, manager.kill([settledIds[0]]));
    assert.equal(historical.title, "quick-0");
    assert.equal(historical.status, "done");
    assert.equal(historical.wasRunning, false);
    assert.equal(historical.killed, false);
  });
});

test("runtime disposal removes the private spill directory", async () => {
  const runtime = createTerminalRuntime();
  const manager = await runtime.runPromise(TerminalManager);
  const snap = await runTool(
    runtime,
    manager.start({ command: "node --version", title: "cleanup", cwd }),
  );
  const { snap: done } = await settlement(manager, snap.id);
  assert.ok(done.stdout.spillPath);
  const spillDir = path.dirname(done.stdout.spillPath);
  assert.equal(fs.existsSync(spillDir), true);

  await runtime.dispose();

  assert.equal(fs.existsSync(spillDir), false);
});

test("an unknown command settles failed with the platform shell's non-zero exit", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.start({
        command: "definitely-not-a-real-binary-12345",
        title: "bogus",
        cwd,
      }),
    );
    const { snap: failed } = await settlement(manager, snap.id);
    assert.equal(failed.status, "failed");
    // The platform shell reports a non-zero exit and explains the failure.
    assert.notEqual(failed.exitCode, 0);
    assert.ok(failed.stderr.text.length > 0, "stderr explains the failure");
  });
});

test("a process 'error' event settles failed with errorText and no bogus exit code", async () => {
  await withManager(async (manager, runtime) => {
    // spawn() with a nonexistent cwd emits ENOENT via the 'error' event
    // (the tool layer validates cwd; the manager must still be correct).
    const snap = await runTool(
      runtime,
      manager.start({
        command: "true",
        title: "bad-cwd",
        cwd: "/definitely/not/a/real/dir-12345",
      }),
    );
    const { snap: failed } = await settlement(manager, snap.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.errorText ?? "", /ENOENT/);
    // Node's 'close' after a spawn 'error' reports the errno (e.g. -2) as
    // its code; that must not leak into exitCode.
    assert.equal(failed.exitCode, undefined);
    assert.equal(failed.signal, undefined);
  });
});

test("the spill file holds the complete capture when the settle hook fires, beyond the in-memory cap", async () => {
  await withManager(async (manager, runtime) => {
    const chunk = 1 << 16; // 64 KiB per write
    const writes = 48; // 3 MiB total > 2 MiB RETAINED_PER_STREAM
    const totalBytes = chunk * writes;

    let spillSizeAtSettle = -1;
    const settledOnce = new Promise<TerminalSnapshot>((resolve) => {
      manager.view.setOnSettled((snap) => {
        // Measured inside the hook: the full capture must already be on disk
        // when the completion follow-up (which cites this path) is queued.
        if (snap.stdout.spillPath) {
          spillSizeAtSettle = fs.statSync(snap.stdout.spillPath).size;
        }
        resolve(snap);
      });
    });

    const snap = await runTool(
      runtime,
      manager.start({
        command: nodeCmd(
          `const s = "x".repeat(${chunk}); for (let i = 0; i < ${writes}; i++) process.stdout.write(s);`,
        ),
        title: "firehose",
        cwd,
      }),
    );
    const done = await settledOnce;
    assert.equal(done.id, snap.id);
    assert.equal(done.status, "done");
    assert.equal(done.stdout.totalBytes, totalBytes);
    // In-memory retention is bounded; the head was dropped.
    assert.ok(done.stdout.truncatedBytes > 0, "head was truncated in memory");
    assert.ok(
      Buffer.byteLength(done.stdout.text) <= 2 * 1024 * 1024,
      "retained text within the cap",
    );
    if (done.stdout.spillPath) {
      assert.equal(
        spillSizeAtSettle,
        totalBytes,
        "spill file was fully flushed before the settle hook",
      );
    }
  });
});

test("aborting the kill wait does not cancel the termination", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.start({
        command:
          process.platform === "win32"
            ? nodeCmd("setInterval(() => {}, 1000)")
            : `exec ${nodeCmd(
                'process.on("SIGTERM", () => process.stdout.write("term\\n")); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);',
              )}`,
        title: "abort-race",
        cwd,
      }),
    );
    const pid = snap.pid;
    assert.ok(pid);
    if (process.platform !== "win32") {
      assert.ok(
        await pollUntil(() =>
          (manager.view.get(snap.id)?.stdout.text ?? "").includes("ready"),
        ),
        "child installed its SIGTERM handler",
      );
    }

    // Abort the tool call immediately: the kill wait is interrupted, but the
    // SIGTERM→SIGKILL teardown must continue detached in the background.
    const controller = new AbortController();
    const killPromise = runTool(runtime, manager.kill([snap.id]), {
      signal: controller.signal,
      interruptMessage: "aborted",
    });
    controller.abort();
    await assert.rejects(killPromise, /aborted/);

    const { snap: after } = await settlement(manager, snap.id);
    assert.equal(after.status, "killed");
    if (process.platform !== "win32") assert.equal(after.signal, "SIGKILL");
    assert.ok(await pollUntil(() => processGone(pid)), "process is gone");
  });
});

test("status returns the snapshot and rejects unknown ids with the known list", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.start({ command: "true", title: "status", cwd }),
    );
    const seen = await runTool(runtime, manager.status(snap.id));
    assert.equal(seen.id, snap.id);
    await assert.rejects(
      runTool(runtime, manager.status("bt-999")),
      /Unknown terminal id "bt-999"\. Known: bt-1\./,
    );
  });
});

// --- shell resolution (regression: bg_start must not use cmd.exe) ------------------

test("the configured shell is used verbatim with one -c argv", () => {
  const invocation = shellInvocation("echo $HOME && sleep 1", {
    shell: "C:\Program Files\Git\bin\bash.exe",
    args: ["-c"],
  });
  assert.equal(invocation.shell, "C:\Program Files\Git\bin\bash.exe");
  assert.deepEqual(invocation.args, ["-c", "echo $HOME && sleep 1"]);
  assert.equal(
    invocation.windowsVerbatimArguments,
    false,
    "a real executable keeps Node's argv quoting",
  );
  assert.equal(invocation.writeToStdin, undefined);
});

test("shellCommandPrefix is prepended like the built-in bash tool", () => {
  const invocation = shellInvocation("npm test", {
    shell: "/bin/bash",
    args: ["-c"],
    commandPrefix: "set -e",
  });
  assert.deepEqual(invocation.args, ["-c", "set -e\nnpm test"]);
});

test("legacy stdin-transport shells deliver the command on stdin", () => {
  const invocation = shellInvocation("echo hi", {
    shell: "bash",
    args: ["-s"],
    commandTransport: "stdin",
  });
  assert.deepEqual(invocation.args, ["-s"]);
  assert.equal(invocation.writeToStdin, "echo hi");
});

test("the platform fallback keeps cmd.exe's single verbatim payload", () => {
  const invocation = shellInvocation("echo hi", {
    shell: "cmd.exe",
    args: ["/d", "/s", "/c"],
    windowsVerbatimArguments: true,
  });
  assert.deepEqual(invocation.args, ["/d", "/s", "/c", '"echo hi"']);
  assert.equal(invocation.windowsVerbatimArguments, true);
});

test("setTerminalShell overrides the platform default and resets to it", () => {
  const previous = terminalShell();
  try {
    setTerminalShell({ shell: "/usr/bin/env", args: ["bash", "-c"] });
    assert.deepEqual(terminalShell().args, ["bash", "-c"]);
    const invocation = shellInvocation("ls");
    assert.equal(invocation.shell, "/usr/bin/env");
    assert.deepEqual(invocation.args, ["bash", "-c", "ls"]);
  } finally {
    setTerminalShell(undefined);
  }
  assert.deepEqual(terminalShell(), platformDefaultShell());
  assert.deepEqual(previous, platformDefaultShell());
});

test("a background terminal really runs in the injected shell", async () => {
  // End-to-end proof: bash-only syntax completes successfully once the shell
  // is injected, and the terminal settles instead of dying instantly.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-shell-"));
  try {
    setTerminalShell({
      shell: "bash",
      args: ["-c"],
    });
    await withManager(async (manager, runtime) => {
      const snap = await runTool(
        runtime,
        manager.start({
          command: "echo $((6 * 7))",
          title: "shell",
          cwd: dir,
        }),
      );
      const { snap: done } = await settlement(manager, snap.id);
      assert.equal(done.status, "done", done.errorText ?? "");
      const out = await runTool(runtime, manager.status(snap.id));
      assert.equal(out.stdout.text.trim(), "42");
    });
  } finally {
    setTerminalShell(undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a killed terminal leaves no orphaned grandchild behind", async () => {
  // Regression: on Windows the graceful pass used `taskkill /T` WITHOUT `/F`,
  // which cannot terminate console processes (`this process can only be
  // terminated forcefully`). It failed, the direct-kill fallback took out only
  // the shell, and the real work was reparented — unreachable by the later
  // `/F` escalation because the shell's pid was already gone. Every
  // never-exiting fixture leaked that way (~40 idle node processes per suite
  // run), and a killed dev server would have leaked the same way.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-orphan-"));
  const pidFile = path.join(dir, "pid.txt");
  try {
    await withManager(async (manager, runtime) => {
      // The GRANDCHILD writes its own pid: the shell's pid is not what leaks.
      const script =
        'const fs = require("node:fs");' +
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
        "setInterval(() => {}, 1000);";
      const snap = await runTool(
        runtime,
        manager.start({ command: nodeCmd(script), title: "orphan", cwd: dir }),
      );
      assert.equal(
        await pollUntil(() => fs.existsSync(pidFile), 10_000),
        true,
        "the fixture reported its pid",
      );
      const grandchild = Number(fs.readFileSync(pidFile, "utf8").trim());
      assert.equal(
        processGone(grandchild),
        false,
        "the fixture is alive before the kill",
      );

      const [result] = await runTool(runtime, manager.kill([snap.id]));
      assert.equal(result.killed, true);

      assert.equal(
        await pollUntil(() => processGone(grandchild), 10_000),
        true,
        "the killed terminal's grandchild must not outlive it",
      );
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
