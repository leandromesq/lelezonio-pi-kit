import assert from "node:assert/strict";
import test from "node:test";
import type {
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager as TuiKeybindingsManager,
  TUI_KEYBINDINGS,
  visibleWidth,
  type KeybindingDefinitions,
  type TUI,
} from "@earendil-works/pi-tui";
import type { SubagentSnapshot } from "./src/domain.ts";
import type { SubagentReadModel } from "./src/manager.ts";
import {
  reconcileDashboardSelection,
  SubagentDashboard,
  TakeoverView,
  type DashboardSelection,
} from "./src/ui/takeover.ts";

/** Raw terminal input for the default keymap: escape and ctrl+c. */
const ESC = "\u001b";
const CTRL_C = "\u0003";

/**
 * Test keymap: the pi-tui defaults plus the `app.*` actions the pi-coding-agent
 * manager adds (its extended `KEYBINDINGS` is not exported from the root).
 */
const TEST_KEYBINDINGS: KeybindingDefinitions = {
  ...TUI_KEYBINDINGS,
  "app.interrupt": { defaultKeys: "escape", description: "Cancel / abort" },
  "app.clear": {
    defaultKeys: "ctrl+c",
    description: "Clear editor (first) / exit (second)",
  },
};

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function keybindings() {
  return new TuiKeybindingsManager(
    TEST_KEYBINDINGS,
  ) as unknown as KeybindingsManager;
}

function makeTui(rows = 30): TUI {
  return {
    terminal: { rows, cols: 100 },
    requestRender: () => undefined,
  } as unknown as TUI;
}

function makeSnapshot(options: {
  id: string;
  status?: SubagentSnapshot["status"];
  title?: string;
}): SubagentSnapshot {
  const now = Date.now();
  return {
    id: options.id,
    origin: "model",
    backend: "pi",
    title: options.title ?? `Task ${options.id}`,
    prompt: "do the thing",
    cwd: "/tmp",
    status: options.status ?? "running",
    run: 1,
    createdAt: now,
    lastEventAt: now,
    meta: { backend: "pi", modelLabel: "test/model" },
    usage: {},
    transcript: [],
    transcriptVersion: 1,
    liveTools: [],
    queued: [],
    finalText: "",
    turns: 0,
  };
}

function makeView(snapshots: SubagentSnapshot[]) {
  const aborts: string[] = [];
  const sends: Array<{ id: string; text: string }> = [];
  const view: SubagentReadModel = {
    list: () => snapshots,
    get: (id) => snapshots.find((snap) => snap.id === id),
    size: () => snapshots.length,
    subscribe: () => () => undefined,
    subscribeTo: () => () => undefined,
    requestSend: (id, text) => {
      sends.push({ id, text });
    },
    requestAbort: (id) => {
      aborts.push(id);
    },
    requestTakeOver: async () => false,
    setOnSettled: () => undefined,
  };
  return { view, aborts, sends };
}

test("dashboard selection follows its subagent id and falls back by row", () => {
  const selection: DashboardSelection = { id: "sa-7", index: 6 };

  reconcileDashboardSelection(selection, [
    { id: "sa-new" },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `sa-${index + 1}` })),
  ]);
  assert.deepEqual(selection, { id: "sa-7", index: 7 });

  reconcileDashboardSelection(selection, [
    ...Array.from({ length: 6 }, (_, index) => ({ id: `sa-${index + 1}` })),
    { id: "sa-8" },
    { id: "sa-9" },
  ]);
  assert.deepEqual(selection, { id: "sa-9", index: 7 });

  reconcileDashboardSelection(selection, [{ id: "sa-1" }, { id: "sa-2" }]);
  assert.deepEqual(selection, { id: "sa-2", index: 1 });

  reconcileDashboardSelection(selection, []);
  assert.deepEqual(selection, { id: undefined, index: 0 });
});

test("dashboard ctrl+c and escape close without aborting the worker", () => {
  for (const key of [CTRL_C, ESC]) {
    const { view, aborts } = makeView([makeSnapshot({ id: "sa-1" })]);
    const results: Array<string | null> = [];
    const dashboard = new SubagentDashboard(
      makeTui(),
      theme,
      keybindings(),
      view,
      { index: 0 },
      (value) => results.push(value),
    );
    try {
      dashboard.handleInput(key);
      assert.deepEqual(aborts, [], `abort fired for ${JSON.stringify(key)}`);
      assert.deepEqual(results, [null]);
    } finally {
      dashboard.dispose();
    }
  }
});

test("dashboard `x` arms the abort and a second `x` confirms it", () => {
  const { view, aborts } = makeView([makeSnapshot({ id: "sa-1" })]);
  const dashboard = new SubagentDashboard(
    makeTui(),
    theme,
    keybindings(),
    view,
    { index: 0 },
    () => undefined,
  );
  try {
    dashboard.handleInput("x");
    assert.deepEqual(aborts, [], "first press must only arm");
    dashboard.handleInput("x");
    assert.deepEqual(aborts, ["sa-1"], "second press must abort");
  } finally {
    dashboard.dispose();
  }
});

test("dashboard abort is disarmed by any other key", () => {
  const { view, aborts } = makeView([makeSnapshot({ id: "sa-1" })]);
  const dashboard = new SubagentDashboard(
    makeTui(),
    theme,
    keybindings(),
    view,
    { index: 0 },
    () => undefined,
  );
  try {
    dashboard.handleInput("x");
    dashboard.handleInput("j");
    dashboard.handleInput("x");
    assert.deepEqual(aborts, [], "the disarm reset the arm state");
  } finally {
    dashboard.dispose();
  }
});

test("dashboard renders its count once and stays within the width", () => {
  const { view } = makeView([
    makeSnapshot({ id: "sa-1", status: "running" }),
    makeSnapshot({ id: "sa-2", status: "done" }),
  ]);
  const dashboard = new SubagentDashboard(
    makeTui(),
    theme,
    keybindings(),
    view,
    { index: 0 },
    () => undefined,
  );
  try {
    const lines = dashboard.render(80);
    // The settled/total count lives on the header only; the panel border is a
    // label, not a second copy of the number.
    assert.match(lines[0]!, /1\/2/);
    assert.doesNotMatch(lines[0]!, /\d+\s+agents?\b/i);
    assert.match(lines[1]!, /subagents/);
    assert.doesNotMatch(lines[1]!, /1\/2/);

    for (const width of [40, 80, 200]) {
      for (const line of dashboard.render(width)) {
        assert.ok(
          visibleWidth(line) <= width,
          `line wider than ${width}: ${JSON.stringify(line)}`,
        );
      }
    }
  } finally {
    dashboard.dispose();
  }
});

test("takeover ctrl+c arms, then confirms the abort without closing", () => {
  const { view, aborts } = makeView([makeSnapshot({ id: "sa-1" })]);
  const results: Array<null> = [];
  const takeover = new TakeoverView(
    makeTui(),
    theme,
    keybindings(),
    "sa-1",
    view,
    (value) => results.push(value),
  );
  try {
    takeover.handleInput(CTRL_C);
    assert.deepEqual(aborts, [], "first press must only arm");
    assert.deepEqual(results, [], "arming must not close the view");
    assert.match(takeover.render(80).join("\n"), /again to cancel/);

    takeover.handleInput(CTRL_C);
    assert.deepEqual(aborts, ["sa-1"]);
    assert.deepEqual(results, [], "confirming the abort keeps the view open");
  } finally {
    takeover.dispose();
  }
});

test("takeover escape closes without aborting", () => {
  const { view, aborts } = makeView([makeSnapshot({ id: "sa-1" })]);
  const results: Array<null> = [];
  const takeover = new TakeoverView(
    makeTui(),
    theme,
    keybindings(),
    "sa-1",
    view,
    (value) => results.push(value),
  );
  try {
    takeover.handleInput(ESC);
    assert.deepEqual(aborts, []);
    assert.deepEqual(results, [null]);
  } finally {
    takeover.dispose();
  }
});

test("takeover ctrl+c on a settled subagent closes without aborting", () => {
  const { view, aborts } = makeView([
    makeSnapshot({ id: "sa-1", status: "done" }),
  ]);
  const results: Array<null> = [];
  const takeover = new TakeoverView(
    makeTui(),
    theme,
    keybindings(),
    "sa-1",
    view,
    (value) => results.push(value),
  );
  try {
    takeover.handleInput(CTRL_C);
    assert.deepEqual(aborts, []);
    assert.deepEqual(results, [null]);
  } finally {
    takeover.dispose();
  }
});

test("takeover keeps printable `x` for the input instead of aborting", () => {
  const { view, aborts, sends } = makeView([makeSnapshot({ id: "sa-1" })]);
  const takeover = new TakeoverView(
    makeTui(),
    theme,
    keybindings(),
    "sa-1",
    view,
    () => undefined,
  );
  try {
    takeover.handleInput("x");
    takeover.handleInput("\r");
    assert.deepEqual(aborts, [], "`x` is typed text, not the abort key");
    assert.deepEqual(sends, [{ id: "sa-1", text: "x" }]);
  } finally {
    takeover.dispose();
  }
});

test("takeover renders within the requested width", () => {
  const { view } = makeView([makeSnapshot({ id: "sa-1" })]);
  const takeover = new TakeoverView(
    makeTui(),
    theme,
    keybindings(),
    "sa-1",
    view,
    () => undefined,
  );
  try {
    for (const width of [40, 80, 200]) {
      for (const line of takeover.render(width)) {
        assert.ok(
          visibleWidth(line) <= width,
          `line wider than ${width}: ${JSON.stringify(line)}`,
        );
      }
    }
  } finally {
    takeover.dispose();
  }
});
