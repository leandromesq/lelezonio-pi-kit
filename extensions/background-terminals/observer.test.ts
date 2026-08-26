/**
 * Unit tests for the terminal observer coordinator: attach gating, no-Herdr
 * fallback, take-over routing, settle policy delegation, idempotency, and
 * disposal. The settle/take-over *policy* itself lives in the shared module
 * (herdr-workspace.test.ts); here we test that the coordinator wires the
 * terminal lifecycle to it correctly.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  createTerminalObserverCoordinator,
  type TerminalObserverCoordinator,
} from "./src/observer.ts";
import type { TerminalSnapshot } from "./src/domain.ts";
import type {
  TerminalObserverHandle,
  WorkerWorkspaceController,
} from "../shared/herdr-workspace.ts";

function makeTerminal(
  overrides: Partial<TerminalSnapshot> = {},
): TerminalSnapshot {
  return {
    id: "bt-1",
    command: "npm run dev",
    title: "dev server",
    cwd: "C:\\work\\proj",
    pid: 1234,
    status: "running",
    createdAt: Date.now() - 10_000,
    stdout: {
      text: "",
      totalBytes: 0,
      truncatedBytes: 0,
      spillPath: "C:\\spill\\bt-1.stdout.log",
    },
    stderr: {
      text: "",
      totalBytes: 0,
      truncatedBytes: 0,
      spillPath: "C:\\spill\\bt-1.stderr.log",
    },
    ...overrides,
  };
}

function fakeHandle(overrides: Partial<TerminalObserverHandle> = {}) {
  let takeOverCalls = 0;
  let settleCalls = 0;
  const handle: TerminalObserverHandle = {
    terminalId: "bt-1",
    pane: {} as TerminalObserverHandle["pane"],
    takenOver: false,
    takeOver: async () => {
      takeOverCalls += 1;
      return true;
    },
    settle: async () => {
      settleCalls += 1;
    },
    ...overrides,
  };
  return {
    handle,
    takeOverCalls: () => takeOverCalls,
    settleCalls: () => settleCalls,
  };
}

function fakeController(
  options: {
    available?: boolean;
    openResult?: TerminalObserverHandle | undefined;
  } = {},
) {
  const opened: Array<{
    terminalId: string;
    title: string;
    cwd: string;
    stdoutPath: string;
    stderrPath: string;
  }> = [];
  const controller = {
    available: () => options.available ?? true,
    openObserver: async (params: {
      terminalId: string;
      title: string;
      cwd: string;
      stdoutPath: string;
      stderrPath: string;
    }) => {
      opened.push(params);
      return options.openResult ?? fakeHandle().handle;
    },
  } as unknown as WorkerWorkspaceController;
  return { controller, opened: () => opened };
}

function makeCoordinator(
  workspaces: ReturnType<typeof fakeController> = fakeController(),
) {
  return {
    coordinator: createTerminalObserverCoordinator({
      workspace: () => workspaces.controller,
    }),
    workspaces,
  };
}

test("attach opens an observer with the terminal's spill files and cwd", async () => {
  const workspaces = fakeController();
  const { coordinator } = makeCoordinator(workspaces);
  await coordinator.attach(makeTerminal());
  assert.equal(workspaces.opened().length, 1);
  assert.deepEqual(workspaces.opened()[0], {
    terminalId: "bt-1",
    title: "[bt-1] dev server",
    cwd: "C:\\work\\proj",
    stdoutPath: "C:\\spill\\bt-1.stdout.log",
    stderrPath: "C:\\spill\\bt-1.stderr.log",
  });
});

test("settlement racing observer creation stops the late pane instead of leaking it", async () => {
  const late = fakeHandle();
  let release!: (handle: TerminalObserverHandle) => void;
  const opened = new Promise<TerminalObserverHandle>((resolve) => {
    release = resolve;
  });
  const controller = {
    available: () => true,
    openObserver: () => opened,
  } as unknown as WorkerWorkspaceController;
  const coordinator = createTerminalObserverCoordinator({
    workspace: () => controller,
  });

  const attaching = coordinator.attach(makeTerminal());
  await Promise.resolve();
  const settling = coordinator.settle(makeTerminal({ status: "done" }));
  release(late.handle);
  await Promise.all([attaching, settling]);

  assert.equal(late.settleCalls(), 1);
  assert.equal(await coordinator.takeOver("bt-1"), false);
});

test("attach outside Herdr is a silent no-op (overlay fallback preserved)", async () => {
  const workspaces = fakeController({ available: false });
  const { coordinator } = makeCoordinator(workspaces);
  await coordinator.attach(makeTerminal());
  assert.equal(workspaces.opened().length, 0);
});

test("attach without spill files is a no-op", async () => {
  const workspaces = fakeController();
  const { coordinator } = makeCoordinator(workspaces);
  await coordinator.attach(
    makeTerminal({
      stdout: { text: "", totalBytes: 0, truncatedBytes: 0 },
      stderr: { text: "", totalBytes: 0, truncatedBytes: 0 },
    }),
  );
  assert.equal(workspaces.opened().length, 0);
});

test("attach ignores settled terminals", async () => {
  const workspaces = fakeController();
  const { coordinator } = makeCoordinator(workspaces);
  await coordinator.attach(makeTerminal({ status: "done" }));
  assert.equal(workspaces.opened().length, 0);
});

test("attach never throws when observer setup fails", async () => {
  const workspaces = fakeController({ openResult: undefined });
  const { coordinator } = makeCoordinator(workspaces);
  await coordinator.attach(makeTerminal());
  assert.equal(workspaces.opened().length, 1); // attempt made...
  // ...and a throwing controller is also swallowed.
  const throwing = {
    available: () => true,
    openObserver: async () => {
      throw new Error("boom");
    },
  } as unknown as WorkerWorkspaceController;
  const coordinator2 = createTerminalObserverCoordinator({
    workspace: () => throwing,
  });
  await coordinator2.attach(makeTerminal());
  assert.ok(true);
});

test("attach is idempotent per terminal id", async () => {
  const workspaces = fakeController();
  const { coordinator } = makeCoordinator(workspaces);
  await coordinator.attach(makeTerminal());
  await coordinator.attach(makeTerminal({ title: "renamed" }));
  assert.equal(workspaces.opened().length, 1);
});

test("takeOver routes to the observer and reports true", async () => {
  const stub = fakeHandle();
  const workspaces = fakeController({ openResult: stub.handle });
  const { coordinator } = makeCoordinator(workspaces);
  await coordinator.attach(makeTerminal());
  assert.equal(await coordinator.takeOver("bt-1"), true);
});

test("takeOver for an unknown or failed terminal reports false", async () => {
  const workspaces = fakeController();
  const { coordinator } = makeCoordinator(workspaces);
  await coordinator.attach(makeTerminal());
  assert.equal(await coordinator.takeOver("bt-999"), false);
  // A takeOver failure (e.g. pane already closed) is also false.
  const { handle } = fakeHandle({ takeOver: async () => false });
  const workspaces2 = fakeController({ openResult: handle });
  const coordinator2 = createTerminalObserverCoordinator({
    workspace: () => workspaces2.controller,
  });
  await coordinator2.attach(makeTerminal({ id: "bt-2" }));
  assert.equal(await coordinator2.takeOver("bt-2"), false);
});

test("settle delegates to the observer once and forgets it", async () => {
  const stub = fakeHandle();
  const workspaces = fakeController({ openResult: stub.handle });
  const { coordinator } = makeCoordinator(workspaces);
  await coordinator.attach(makeTerminal());
  await coordinator.settle(makeTerminal({ status: "done" }));
  assert.equal(stub.settleCalls(), 1);
  // The entry is forgotten: a second settle (e.g. bg_kill raced) is a no-op.
  await coordinator.settle(makeTerminal({ status: "done" }));
  assert.equal(stub.settleCalls(), 1);
});

test("settle works even when the observer throws", async () => {
  const stub = fakeHandle({
    settle: async () => {
      throw new Error("boom");
    },
  });
  const workspaces = fakeController({ openResult: stub.handle });
  const { coordinator } = makeCoordinator(workspaces);
  await coordinator.attach(makeTerminal());
  await coordinator.settle(makeTerminal({ status: "killed" }));
  assert.ok(true);
});

test("dispose drops all observer bookkeeping", async () => {
  const stub = fakeHandle();
  const workspaces = fakeController({ openResult: stub.handle });
  const { coordinator } = makeCoordinator(workspaces);
  await coordinator.attach(makeTerminal());
  await coordinator.dispose();
  assert.equal(await coordinator.takeOver("bt-1"), false);
});

test("coordinator satisfies the interface surface for index.ts wiring", () => {
  const coordinator: TerminalObserverCoordinator =
    createTerminalObserverCoordinator({ workspace: () => undefined });
  assert.equal(typeof coordinator.attach, "function");
  assert.equal(typeof coordinator.takeOver, "function");
  assert.equal(typeof coordinator.settle, "function");
  assert.equal(typeof coordinator.dispose, "function");
});
