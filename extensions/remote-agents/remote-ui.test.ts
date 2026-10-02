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
import { defaultRemoteAgentsConfig } from "./src/config.ts";
import type { RemoteAgentSnapshot } from "./src/domain.ts";
import type { RemoteAgentReadModel } from "./src/manager.ts";
import {
  environmentWithoutHerdr,
  openRemoteUi,
  remoteUiArguments,
} from "./src/remote-ui.ts";
import { RemoteDashboard, RemoteTakeover } from "./src/ui/dashboard.ts";

test("remote UI opens Kitty as a detached Herdr remote client", () => {
  assert.deepEqual(remoteUiArguments("macmini", "Review API"), [
    "--detach",
    "--title",
    "Remote Herdr · Review API",
    "herdr",
    "--remote",
    "macmini",
  ]);
});

test("remote UI removes inherited Herdr context to avoid nested-client rejection", () => {
  assert.deepEqual(
    environmentWithoutHerdr({
      PATH: "/bin",
      HOME: "/home/user",
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      HERDR_WORKSPACE_ID: "w1",
    }),
    { PATH: "/bin", HOME: "/home/user" },
  );
});

test("remote UI can be disabled", async () => {
  const config = {
    ...defaultRemoteAgentsConfig(),
    openRemoteUiOnSpawn: false,
    terminalExecutable: "definitely-not-an-executable",
  };
  assert.equal(await openRemoteUi(config, "disabled"), false);
});

// --- Dashboard / takeover behavior ------------------------------------------

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
  status?: RemoteAgentSnapshot["status"];
}): RemoteAgentSnapshot {
  const now = Date.now();
  return {
    id: options.id,
    name: options.id,
    title: `Job ${options.id}`,
    host: "macmini",
    localCwd: "/local",
    remoteCwd: "/remote",
    status: options.status ?? "working",
    createdAt: now,
    updatedAt: now,
    transcript: "",
    transcriptVersion: 1,
    generation: 1,
  };
}

function makeView(snapshots: RemoteAgentSnapshot[]) {
  const cancels: string[] = [];
  const refreshes: string[] = [];
  const deletes: string[] = [];
  const view: RemoteAgentReadModel = {
    list: () => snapshots,
    get: (id) => snapshots.find((snap) => snap.id === id),
    subscribe: () => () => undefined,
    subscribeTo: () => () => undefined,
    requestRefresh: (id) => {
      refreshes.push(id);
    },
    requestSend: () => undefined,
    requestCancel: (id) => {
      cancels.push(id);
    },
    requestDelete: (id) => {
      deletes.push(id);
    },
  };
  return { view, cancels, refreshes, deletes };
}

test("remote dashboard ctrl+c and escape close without cancelling", () => {
  for (const key of [CTRL_C, ESC]) {
    const { view, cancels } = makeView([makeSnapshot({ id: "ra-1" })]);
    const results: Array<string | null> = [];
    const dashboard = new RemoteDashboard(
      makeTui(),
      theme,
      keybindings(),
      view,
      { index: 0 },
      (value) => results.push(value),
    );
    try {
      dashboard.handleInput(key);
      assert.deepEqual(cancels, [], `cancel fired for ${JSON.stringify(key)}`);
      assert.deepEqual(results, [null]);
    } finally {
      dashboard.dispose();
    }
  }
});

test("remote dashboard `x` arms the cancel and a second `x` confirms it", () => {
  const { view, cancels } = makeView([makeSnapshot({ id: "ra-1" })]);
  const dashboard = new RemoteDashboard(
    makeTui(),
    theme,
    keybindings(),
    view,
    { index: 0 },
    () => undefined,
  );
  try {
    dashboard.handleInput("x");
    assert.deepEqual(cancels, [], "first press must only arm");
    dashboard.handleInput("x");
    assert.deepEqual(cancels, ["ra-1"], "second press must cancel");
  } finally {
    dashboard.dispose();
  }
});

test("remote dashboard abort is disarmed by any other key", () => {
  const { view, cancels } = makeView([makeSnapshot({ id: "ra-1" })]);
  const dashboard = new RemoteDashboard(
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
    assert.deepEqual(cancels, [], "the disarm reset the arm state");
  } finally {
    dashboard.dispose();
  }
});

test("remote dashboard renders within the requested width", () => {
  const { view } = makeView([
    makeSnapshot({ id: "ra-1", status: "working" }),
    makeSnapshot({ id: "ra-2", status: "done" }),
  ]);
  const dashboard = new RemoteDashboard(
    makeTui(),
    theme,
    keybindings(),
    view,
    { index: 0 },
    () => undefined,
  );
  try {
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

test("remote takeover ctrl+c arms, then confirms the cancel without closing", () => {
  const { view, cancels } = makeView([makeSnapshot({ id: "ra-1" })]);
  const results: Array<null> = [];
  const takeover = new RemoteTakeover(
    makeTui(),
    theme,
    keybindings(),
    "ra-1",
    view,
    (value) => results.push(value),
  );
  try {
    takeover.handleInput(CTRL_C);
    assert.deepEqual(cancels, [], "first press must only arm");
    assert.deepEqual(results, [], "arming must not close the view");
    assert.match(takeover.render(80).join("\n"), /again to cancel/);

    takeover.handleInput(CTRL_C);
    assert.deepEqual(cancels, ["ra-1"]);
    assert.deepEqual(results, [], "confirming the cancel keeps the view open");
  } finally {
    takeover.dispose();
  }
});

test("remote takeover escape closes without cancelling", () => {
  const { view, cancels } = makeView([makeSnapshot({ id: "ra-1" })]);
  const results: Array<null> = [];
  const takeover = new RemoteTakeover(
    makeTui(),
    theme,
    keybindings(),
    "ra-1",
    view,
    (value) => results.push(value),
  );
  try {
    takeover.handleInput(ESC);
    assert.deepEqual(cancels, []);
    assert.deepEqual(results, [null]);
  } finally {
    takeover.dispose();
  }
});

test("remote takeover renders within the requested width", () => {
  const { view } = makeView([makeSnapshot({ id: "ra-1" })]);
  const takeover = new RemoteTakeover(
    makeTui(),
    theme,
    keybindings(),
    "ra-1",
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
