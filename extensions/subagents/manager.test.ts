/**
 * End-to-end smoke tests: manager behavior through a real ManagedRuntime,
 * exactly as the tool handlers drive it. The registry is test-only: a
 * scripted Codex session (the production backend launches a real process),
 * plus the real Pi backend for its cheap registry precondition.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { BackendRegistry, type SubagentBackend } from "./src/backend.ts";
import { piBackend } from "./src/backends/pi.ts";
import { makeStubBackend } from "./src/backends/stub.ts";
import type { BackendName, ParentContext, SpawnTask } from "./src/domain.ts";
import {
  isPrunableSettled,
  makeSubagentManagerLayer,
  SubagentManager,
  type SubagentManagerShape,
} from "./src/manager.ts";
import { runTool } from "./src/runtime.ts";

const TestRegistryLive = Layer.sync(BackendRegistry, () => {
  const backends: SubagentBackend[] = [
    piBackend,
    makeStubBackend({
      backend: "codex",
      defaultModelLabel: "codex/gpt-5-codex",
      contextWindow: 272_000,
      toolName: "shell",
      cadenceMs: 30,
    }),
  ];
  return new Map<BackendName, SubagentBackend>(
    backends.map((backend) => [backend.name, backend]),
  );
});

const createTestRuntime = (maxRunning = 4) =>
  ManagedRuntime.make(
    makeSubagentManagerLayer(maxRunning).pipe(Layer.provide(TestRegistryLive)),
  );

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return { prompt, title: "test", cwd: process.cwd(), parent };
}

async function withManager(
  run: (
    manager: SubagentManagerShape,
    runtime: ReturnType<typeof createTestRuntime>,
  ) => Promise<void>,
  maxRunning = 4,
) {
  const runtime = createTestRuntime(maxRunning);
  try {
    const manager = await runtime.runPromise(SubagentManager);
    await run(manager, runtime);
  } finally {
    await runtime.dispose();
  }
}

test("stub subagent completes and delivers a final result", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("codex", task("Say hello to the tests")),
    );
    assert.equal(snap.status, "running");
    assert.equal(snap.backend, "codex");
    assert.ok(snap.meta.sessionFilePath);

    await runTool(runtime, manager.waitFor([snap.id]));
    const done = manager.view.get(snap.id);
    assert.ok(done);
    assert.equal(done.status, "done");
    assert.match(
      done.finalText,
      /\[stub:codex\] completed: Say hello to the tests/,
    );
    assert.ok(done.turns >= 2);
    assert.ok(done.transcript.some((item) => item.kind === "toolResult"));
    // The waitFor marked the settle as consumed.
    assert.deepEqual(settled, [{ id: snap.id, consumed: true }]);
  });
});

test("FAIL: prompts settle as errors; unconsumed settles are delivered", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("codex", task("FAIL: blow up please")),
    );
    // Poll without wait-interest so the settle is delivered unconsumed.
    while (manager.view.get(snap.id)?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const failed = manager.view.get(snap.id);
    assert.equal(failed?.status, "error");
    assert.match(failed?.errorText ?? "", /task failed/);
    assert.deepEqual(settled, [{ id: snap.id, consumed: false }]);
  });
});

test("cancel interrupts a running stub subagent", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("codex", task("Long running task")),
    );
    const report = await runTool(runtime, manager.cancel([snap.id]));
    assert.deepEqual(
      report.map((entry) => ({
        id: entry.id,
        title: entry.title,
        status: entry.status,
        cancelled: entry.cancelled,
      })),
      [
        {
          id: snap.id,
          title: "[sa-1 · codex] test",
          status: "error",
          cancelled: true,
        },
      ],
    );
    assert.equal(report[0]?.snapshot?.id, snap.id);
    assert.equal(report[0]?.snapshot?.status, "error");
    assert.equal(manager.view.get(snap.id)?.errorText, "Run was aborted");
  });
});

test("prune never drops a pending restart or an actively collected run", () => {
  const settled = { restarting: undefined, waitInterest: false };
  assert.equal(isPrunableSettled("error", settled), true);
  assert.equal(isPrunableSettled("done", settled), true);
  // A settled-session send reserved the slot before RunStarted folded.
  assert.equal(
    isPrunableSettled("done", { restarting: true, waitInterest: false }),
    false,
  );
  assert.equal(
    isPrunableSettled("running", { restarting: false, waitInterest: false }),
    false,
  );
  assert.equal(
    isPrunableSettled("error", { restarting: false, waitInterest: true }),
    false,
  );
});

test("the manager pre-allocates logical ids before the backend spawn", async () => {
  const seen: Array<{ logicalId?: string; profile?: string }> = [];
  const runtime = ManagedRuntime.make(
    makeSubagentManagerLayer().pipe(
      Layer.provide(
        Layer.sync(BackendRegistry, () => {
          const backends: SubagentBackend[] = [
            makeStubBackend({
              backend: "codex",
              defaultModelLabel: "codex/gpt-5-codex",
              contextWindow: 272_000,
              toolName: "shell",
              cadenceMs: 10,
              onTask: (t) =>
                seen.push({ logicalId: t.logicalId, profile: t.profile }),
            }),
          ];
          return new Map<BackendName, SubagentBackend>(
            backends.map((backend) => [backend.name, backend]),
          );
        }),
      ),
    ),
  );
  try {
    const manager = await runtime.runPromise(SubagentManager);
    const first = await runTool(
      runtime,
      manager.spawn("codex", {
        prompt: "one",
        title: "first",
        cwd: process.cwd(),
        profile: "reviewer",
        parent,
      }),
    );
    const second = await runTool(
      runtime,
      manager.spawn("codex", {
        prompt: "two",
        title: "second",
        cwd: process.cwd(),
        parent,
      }),
    );
    // Ids allocated in spawn order, pre-backend, and titles carry profile.
    assert.equal(first.id, "sa-1");
    assert.equal(second.id, "sa-2");
    assert.deepEqual(seen, [
      { logicalId: "sa-1", profile: "reviewer" },
      { logicalId: "sa-2", profile: undefined },
    ]);
    assert.equal(first.title, "[sa-1 · reviewer] first");
    assert.equal(second.title, "[sa-2 · codex] second");
  } finally {
    await runtime.dispose();
  }
});

test("spawn origin propagates to ids, snapshots, and settlement", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; origin: string }> = [];
    manager.view.setOnSettled((snap) =>
      settled.push({ id: snap.id, origin: snap.origin }),
    );

    const model = await runTool(
      runtime,
      manager.spawn("codex", task("model task")),
    );
    const btw = await runTool(
      runtime,
      manager.spawn("codex", { ...task("side question"), origin: "btw" }),
    );

    assert.match(model.id, /^sa-/);
    assert.equal(model.origin, "model");
    assert.match(btw.id, /^btw-/);
    assert.equal(btw.origin, "btw");

    await runTool(runtime, manager.cancel([model.id, btw.id]));
    assert.deepEqual(
      settled.sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: btw.id, origin: "btw" },
        { id: model.id, origin: "model" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});

test("the global concurrency cap includes by-the-way sessions", async () => {
  await withManager(async (manager, runtime) => {
    const tasks: SpawnTask[] = [
      { ...task("side question"), origin: "btw" },
      task("Task 2"),
      task("Task 3"),
      task("Task 4"),
    ];
    const spawns = await runTool(
      runtime,
      Effect.forEach(tasks, (spawnTask) => manager.spawn("codex", spawnTask), {
        concurrency: "unbounded",
      }),
    );
    assert.equal(spawns.length, 4);
    await assert.rejects(
      runTool(
        runtime,
        manager.spawn("codex", {
          ...task("another side question"),
          origin: "btw",
        }),
      ),
      /Max 4 subagents/,
    );
  });
});

test("a configured concurrency cap limits running subagents", async () => {
  await withManager(async (manager, runtime) => {
    await runTool(runtime, manager.spawn("codex", task("Task 1")));
    await runTool(runtime, manager.spawn("codex", task("Task 2")));
    await assert.rejects(
      runTool(runtime, manager.spawn("codex", task("Task 3"))),
      /Max 2 subagents/,
    );
  }, 2);
});

test("the concurrency cap rejects a fifth running subagent", async () => {
  await withManager(async (manager, runtime) => {
    const spawns = await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("codex", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    assert.equal(spawns.length, 4);
    await assert.rejects(
      runTool(runtime, manager.spawn("codex", task("Task 5"))),
      /Max 4 subagents/,
    );
  });
});

test("pi spawn fails fast without the parent model registry", async () => {
  await withManager(async (manager, runtime) => {
    await assert.rejects(
      runTool(runtime, manager.spawn("pi", task("needs a registry"))),
      /model registry/,
    );
    // The failed spawn must release its concurrency reservation.
    const snap = await runTool(runtime, manager.spawn("codex", task("ok")));
    assert.equal(snap.backend, "codex");
  });
});

test("idle restarts respect the concurrency cap", async () => {
  await withManager(async (manager, runtime) => {
    // Settle one subagent, then fill all four slots with running ones.
    const settled = await runTool(
      runtime,
      manager.spawn("codex", task("early finisher")),
    );
    await runTool(runtime, manager.waitFor([settled.id]));
    await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("codex", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    // Restarting the settled one would be a fifth concurrent run.
    await assert.rejects(
      runTool(runtime, manager.send(settled.id, "go again")),
      /Max 4 subagents/,
    );
    assert.equal(manager.view.get(settled.id)?.status, "done");
  });
});

test("cancel catches a restart before RunStarted reaches the manager", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(runtime, manager.spawn("codex", task("First")));
    await runTool(runtime, manager.waitFor([snap.id]));

    await runTool(runtime, manager.send(snap.id, "Second"));
    const report = await runTool(runtime, manager.cancel([snap.id]));

    assert.equal(report[0]?.cancelled, true);
    assert.equal(manager.view.get(snap.id)?.status, "error");
    assert.match(manager.view.get(snap.id)?.errorText ?? "", /aborted/i);
  });
});

test("a child question folds into the snapshot and clears on the next run", async () => {
  const runtime = ManagedRuntime.make(
    makeSubagentManagerLayer(4).pipe(
      Layer.provide(
        Layer.sync(BackendRegistry, () => {
          const backends: SubagentBackend[] = [
            piBackend,
            makeStubBackend({
              backend: "codex",
              defaultModelLabel: "codex/gpt-5-codex",
              contextWindow: 272_000,
              toolName: "shell",
              cadenceMs: 10,
              askQuestion: "Which API should I use?",
            }),
          ];
          return new Map<BackendName, SubagentBackend>(
            backends.map((backend) => [backend.name, backend]),
          );
        }),
      ),
    ),
  );
  try {
    const manager = await runtime.runPromise(SubagentManager);
    const snap = await runTool(runtime, manager.spawn("codex", task("ask")));
    await runTool(runtime, manager.waitFor([snap.id]));
    const settled = manager.view.get(snap.id);
    assert.equal(settled?.status, "done");
    assert.equal(settled?.question?.text, "Which API should I use?");
    assert.ok(settled?.question?.id);

    // A follow-up run clears the pending question.
    await runTool(runtime, manager.send(snap.id, "answer, then continue"));
    await runTool(runtime, manager.waitFor([snap.id]));
    assert.equal(manager.view.get(snap.id)?.question, undefined);
  } finally {
    await runtime.dispose();
  }
});

test("send steers an idle subagent into another turn", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("codex", task("First turn")),
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterFirst = manager.view.get(snap.id);
    assert.equal(afterFirst?.status, "done");

    await runTool(runtime, manager.send(snap.id, "Second turn"));
    // waitFor must observe the synchronous restarting reservation even before
    // the backend's asynchronous RunStarted event reaches the manager.
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterSecond = manager.view.get(snap.id);
    assert.equal(afterSecond?.status, "done");
    assert.match(afterSecond?.finalText ?? "", /Second turn/);
  });
});

test("adopt restores a settled subagent as an inspect-only entry", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.adopt({
        id: "sa-9",
        title: "Restored sa-9",
        backend: "pi",
        finalText: "old output",
        sessionFilePath: "/tmp/restored.jsonl",
        settledAt: 1234,
      }),
    );
    assert.equal(snap.id, "sa-9");
    assert.equal(snap.status, "done");
    assert.equal(snap.finalText, "old output");
    assert.equal(snap.settledAt, 1234);
    // Re-adopting the same id is idempotent.
    await runTool(
      runtime,
      manager.adopt({
        id: "sa-9",
        title: "Restored sa-9",
        backend: "pi",
        settledAt: 1234,
      }),
    );
    assert.equal(manager.view.size(), 1);
    // Inspect-only: send explains why resume is unavailable.
    await assert.rejects(
      runTool(runtime, manager.send("sa-9", "continue")),
      /inspect-only/,
    );
  });
});
