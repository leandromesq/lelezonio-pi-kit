import assert from "node:assert/strict";
import test from "node:test";
import {
  createHerdrPaneApi,
  herdrEnvironment,
  shellQuote,
  tryOpenHerdrPane,
  type HerdrCliEnvelope,
  type HerdrRunner,
} from "./herdr-pane.ts";

/** Record every CLI invocation, then answer per-command via `handler`. */
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

const paneOf = (paneId: string): HerdrCliEnvelope => ({
  result: { pane: { pane_id: paneId } },
});

test("split passes cwd, direction, ratio, env, and current pane id", async () => {
  const { runner, calls } = stubRunner(() => paneOf("w1:p9"));
  const api = createHerdrPaneApi({
    runner,
    currentPaneId: () => "w1:p3",
  });
  const paneId = await api.split({
    cwd: "C:\\work\\proj",
    env: { TAKEOVER_PORT: "48213", TAKEOVER_TOKEN: "abc123" },
    noFocus: true,
  });
  assert.equal(paneId, "w1:p9");
  assert.deepEqual(calls[0], [
    "pane",
    "split",
    "w1:p3",
    "--direction",
    "right",
    "--ratio",
    "0.45",
    "--cwd",
    "C:\\work\\proj",
    "--env",
    "TAKEOVER_PORT=48213",
    "--env",
    "TAKEOVER_TOKEN=abc123",
    "--no-focus",
  ]);
});

test("split omits --no-focus and --env when not requested", async () => {
  const { runner, calls } = stubRunner(() => paneOf("w1:p9"));
  const api = createHerdrPaneApi({ runner, currentPaneId: () => "w1:p3" });
  await api.split({ cwd: "/tmp" });
  assert.equal(calls[0].includes("--no-focus"), false);
  assert.equal(calls[0].includes("--env"), false);
});

test("run retries on agent_pane_busy until it succeeds", async () => {
  let attempts = 0;
  const api = createHerdrPaneApi({
    runner: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("agent_pane_busy");
      return {};
    },
  });
  await api.run("w1:p9", ["node", "'C:\\viewer.mjs'"]);
  assert.equal(attempts, 3);
});

test("run stops retrying after the deadline", async () => {
  let attempts = 0;
  const api = createHerdrPaneApi({
    runner: async () => {
      attempts += 1;
      throw new Error("agent_pane_busy");
    },
    runRetryDeadlineMs: 200,
  });
  await assert.rejects(api.run("w1:p9", ["true"]), /agent_pane_busy/);
  assert.ok(attempts > 1);
});

test("rollback closes the pane when the command fails to start", async () => {
  const closed: string[] = [];
  const { runner, calls } = stubRunner((args) => {
    if (args[0] === "pane" && args[1] === "close") {
      closed.push(args[2]);
      return {};
    }
    if (args[1] === "run") throw new Error("boom");
    return paneOf("w1:p9");
  });
  const api = createHerdrPaneApi({ runner, currentPaneId: () => "w1:p3" });
  await assert.rejects(
    tryOpenHerdrPane(api, { cwd: "/tmp", command: ["node", "x"] }),
    /boom/,
  );
  assert.deepEqual(closed, ["w1:p9"]);
  // split then (failed) run then close
  assert.deepEqual(
    calls.map((args) => `${args[0]} ${args[1]}`),
    ["pane split", "pane run", "pane close"],
  );
});

test("close failure during rollback is swallowed and the error rethrown", async () => {
  const api = createHerdrPaneApi({
    runner: async (args) => {
      if (args[1] === "run") throw new Error("boom");
      if (args[1] === "close") throw new Error("close failed");
      return paneOf("w1:p9");
    },
    currentPaneId: () => "w1:p3",
  });
  await assert.rejects(
    tryOpenHerdrPane(api, { cwd: "/tmp", command: ["node", "x"] }),
    /boom/,
  );
});

test("tryOpenHerdrPane returns the pane id on success", async () => {
  const api = createHerdrPaneApi({
    runner: async () => paneOf("w1:p9"),
    currentPaneId: () => "w1:p3",
  });
  const paneId = await tryOpenHerdrPane(api, {
    cwd: "/tmp",
    env: { K: "v" },
    noFocus: true,
    command: ["node", "'C:\\viewer.mjs'"],
  });
  assert.equal(paneId, "w1:p9");
});

test("shellQuote single-quotes for pwsh and doubles embedded quotes", () => {
  assert.equal(shellQuote("pi -p 'hello'"), "'pi -p ''hello'''");
  assert.equal(shellQuote("plain"), "'plain'");
});

test("herdrEnvironment gates on Herdr env vars", () => {
  const saved = {
    HERDR_ENV: process.env.HERDR_ENV,
    HERDR_PANE_ID: process.env.HERDR_PANE_ID,
    HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
  };
  try {
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HERDR_SOCKET_PATH;
    assert.equal(herdrEnvironment(), false);
    process.env.HERDR_ENV = "1";
    assert.equal(herdrEnvironment(), false);
    process.env.HERDR_PANE_ID = "w1:p1";
    assert.equal(herdrEnvironment(), false);
    process.env.HERDR_SOCKET_PATH = "herdr.sock";
    assert.equal(herdrEnvironment(), true);
    process.env.HERDR_ENV = "0";
    assert.equal(herdrEnvironment(), false);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
