import assert from "node:assert/strict";
import * as net from "node:net";
import test from "node:test";
import type { HerdrPaneApi, SplitHerdrPaneOptions } from "./herdr-pane.ts";
import {
  capBytes,
  createTakeoverHost,
  MAX_SNAPSHOT_FRAME_BYTES,
  MAX_SNAPSHOT_TEXT_BYTES,
  sanitizeForTerminal,
  takeoverKey,
  TAKE_OVER_PROTOCOL,
  type OpenTakeoverOptions,
  type TakeoverHost,
  type TakeoverTarget,
} from "./takeover-host.ts";

// --- Test plumbing ---------------------------------------------------------------

interface FakeHerdrState {
  environment: boolean;
  splits: Array<{
    cwd: string;
    env?: Record<string, string>;
    noFocus?: boolean;
  }>;
  runs: string[];
  closed: string[];
}

function fakeHerdr(options?: {
  environment?: boolean;
  splitError?: Error;
  runError?: Error;
}): { api: HerdrPaneApi; state: FakeHerdrState } {
  const state: FakeHerdrState = {
    environment: options?.environment ?? true,
    splits: [],
    runs: [],
    closed: [],
  };
  let sequence = 0;
  return {
    api: {
      environment: () => state.environment,
      split: async (opts: SplitHerdrPaneOptions) => {
        state.splits.push(opts);
        if (options?.splitError) throw options.splitError;
        return `w1:p${++sequence}`;
      },
      run: async (paneId: string) => {
        state.runs.push(paneId);
        if (options?.runError) throw options.runError;
      },
      close: async (paneId: string) => {
        state.closed.push(paneId);
      },
    },
    state,
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class TestClient {
  readonly socket: net.Socket;
  private buf = Buffer.alloc(0);
  private queue: unknown[] = [];
  private waiters: Array<(message: unknown) => void> = [];
  closed = false;

  constructor(port: number) {
    this.socket = net.createConnection({ host: "127.0.0.1", port });
    this.socket.on("data", (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      let idx: number;
      while ((idx = this.buf.indexOf(0x0a)) >= 0) {
        const line = this.buf.subarray(0, idx).toString("utf8").trim();
        this.buf = this.buf.subarray(idx + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        const waiter = this.waiters.shift();
        if (waiter) waiter(message);
        else this.queue.push(message);
      }
    });
    this.socket.on("error", () => {});
    this.socket.on("close", () => {
      this.closed = true;
    });
  }

  send(frame: unknown) {
    this.socket.write(`${JSON.stringify(frame)}\n`);
  }

  /** Drop any messages already received (e.g. a draining duplicate snapshot). */
  drain() {
    this.queue = [];
  }

  async next(): Promise<unknown> {
    if (this.queue.length) return this.queue.shift()!;
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async waitClosed(timeoutMs = 3_000): Promise<void> {
    if (this.closed) return;
    await Promise.race([
      new Promise<void>((resolve) => {
        this.socket.on("close", () => resolve());
      }),
      delay(timeoutMs).then(() => {
        throw new Error("client did not close in time");
      }),
    ]);
  }
}

const target = (overrides: Partial<TakeoverTarget> = {}): TakeoverTarget => ({
  kind: "subagent",
  id: "sa-1",
  title: "Fix the parser",
  status: "running",
  since: Date.now() - 5_000,
  text: "first line\nsecond line",
  ...overrides,
});

function openOptions(
  overrides: Partial<TakeoverTarget> = {},
  extra?: {
    actions?: OpenTakeoverOptions["actions"];
    subscribe?: () => () => void;
    cwd?: string;
  },
): OpenTakeoverOptions {
  return {
    target: () => target(overrides),
    actions: extra?.actions ?? { send: () => {}, abort: () => {} },
    cwd: extra?.cwd ?? "/tmp/work",
    subscribe: extra?.subscribe,
  };
}

type HelloFn = (env: Record<string, string>) => unknown;

const validHello: HelloFn = (env) => ({
  type: "hello",
  protocol: TAKE_OVER_PROTOCOL,
  token: env.TAKEOVER_TOKEN,
  key: env.TAKEOVER_KEY,
});

/** Wait until an in-flight open has split (publishes pane env), then attach. */
async function attachToPane(
  herdrState: FakeHerdrState,
  hello: HelloFn = validHello,
  priorSplits = 0,
) {
  const deadline = Date.now() + 2_000;
  while (herdrState.splits.length <= priorSplits) {
    if (Date.now() > deadline) throw new Error("no split happened");
    await delay(5);
  }
  const env = herdrState.splits.at(-1)!.env!;
  const conn = new TestClient(Number(env.TAKEOVER_PORT));
  conn.send(hello(env));
  return { conn, env };
}

/** Start an open and authenticate its viewer; resolves the pane id. */
async function openAttached(
  host: TakeoverHost,
  herdrState: FakeHerdrState,
  overrides: Partial<TakeoverTarget> = {},
  hello: HelloFn = validHello,
) {
  const priorSplits = herdrState.splits.length;
  const opening = host.open(openOptions(overrides));
  const { conn, env } = await attachToPane(herdrState, hello, priorSplits);
  const welcome = (await conn.next()) as { type: string };
  assert.equal(welcome.type, "welcome");
  await conn.next(); // initial snapshot
  const paneId = await opening;
  return { paneId, conn, env };
}

// --- Sanitize / bounds -----------------------------------------------------------

test("sanitizeForTerminal strips ANSI/OSC and control chars", () => {
  const dirty = "\x1b[31mred\x1b[0m \u001b]0;title\u0007 \x00tab\tend";
  const clean = sanitizeForTerminal(dirty);
  assert.equal(clean.includes("\x1b["), false);
  assert.equal(clean.includes("\u001b]"), false);
  assert.equal(clean.includes("\x00"), false);
  assert.equal(clean, "red  tab  end");
});

test("capBytes truncates by UTF-8 byte budget, marks, and keeps the newest tail", () => {
  const text = "x".repeat(16 * 1024);
  const capped = capBytes(text, 1024);
  assert.ok(Buffer.byteLength(capped, "utf8") <= 1024);
  assert.ok(capped.endsWith("…[truncated]"));
  assert.equal(capBytes("small", 1024), "small");

  // The newest tail survives; the dropped head is marked, not the other way.
  const mixed = "A".repeat(4096) + "B".repeat(4096);
  const tail = capBytes(mixed, 1024);
  assert.ok(tail.startsWith("B"));
  assert.ok(tail.endsWith("…[truncated]"));
  assert.equal(tail.includes("A"), false);
});

// --- Auth / protocol / hello gating ----------------------------------------------

test("hello with the correct token, key, and protocol gets welcome + snapshot", async () => {
  const { api, state } = fakeHerdr();
  const host = createTakeoverHost({ herdr: api });
  try {
    const { conn, env } = await openAttached(host, state);
    assert.equal(env.TAKEOVER_KEY, takeoverKey("subagent", "sa-1"));
    const snapshot = (await conn.next()) as {
      type: string;
      text: string;
      status: string;
    };
    assert.equal(snapshot.type, "snapshot");
    assert.equal(snapshot.status, "running");
    assert.equal(snapshot.text, "first line\nsecond line");
  } finally {
    await host.dispose();
  }
});

test("open() does not report success before the viewer authenticates", async () => {
  const { api, state } = fakeHerdr();
  const host = createTakeoverHost({ herdr: api });
  try {
    let resolved: unknown;
    const opening = host.open(openOptions()).then((id) => {
      resolved = id;
      return id;
    });
    await delay(30);
    assert.equal(resolved, undefined); // still waiting on the hello
    await attachToPane(state);
    const paneId = await opening;
    assert.ok(paneId);
    assert.equal(resolved, paneId);
  } finally {
    await host.dispose();
  }
});

test("open() times out without a viewer hello, closes the pane, and falls back", async () => {
  const { api, state } = fakeHerdr();
  const host = createTakeoverHost({
    herdr: api,
    helloApprovalTimeoutMs: 150,
  });
  try {
    const paneId = await host.open(openOptions());
    assert.equal(paneId, undefined);
    assert.equal(state.splits.length, 1);
    assert.equal(state.runs.length, 1);
    assert.deepEqual(state.closed, ["w1:p1"]); // half-started pane closed
  } finally {
    await host.dispose();
  }
});

test("open() cleans up when the viewer authenticates with a bad token", async () => {
  const { api, state } = fakeHerdr();
  const host = createTakeoverHost({
    herdr: api,
    helloApprovalTimeoutMs: 150,
  });
  try {
    const opening = host.open(openOptions());
    const { conn } = await attachToPane(state, (env) => ({
      type: "hello",
      protocol: TAKE_OVER_PROTOCOL,
      token: "wrong-token",
      key: env.TAKEOVER_KEY,
    }));
    const error = (await conn.next()) as { type: string; code: string };
    assert.equal(error.type, "error");
    assert.equal(error.code, "auth_failed");
    await conn.waitClosed();
    const paneId = await opening;
    assert.equal(paneId, undefined);
    assert.deepEqual(state.closed, ["w1:p1"]);
  } finally {
    await host.dispose();
  }
});

test("unknown source key is rejected", async () => {
  const { api, state } = fakeHerdr();
  const host = createTakeoverHost({
    herdr: api,
    helloApprovalTimeoutMs: 150,
  });
  try {
    const opening = host.open(openOptions());
    const { conn } = await attachToPane(state, (env) => ({
      type: "hello",
      protocol: TAKE_OVER_PROTOCOL,
      token: env.TAKEOVER_TOKEN,
      key: "terminal:nope",
    }));
    const error = (await conn.next()) as { type: string; code: string };
    assert.equal(error.code, "no_source");
    assert.equal(await opening, undefined);
  } finally {
    await host.dispose();
  }
});

test("protocol mismatch in hello is rejected", async () => {
  const { api, state } = fakeHerdr();
  const host = createTakeoverHost({
    herdr: api,
    helloApprovalTimeoutMs: 150,
  });
  try {
    const opening = host.open(openOptions());
    const { conn } = await attachToPane(state, (env) => ({
      type: "hello",
      protocol: 99,
      token: env.TAKEOVER_TOKEN,
      key: env.TAKEOVER_KEY,
    }));
    const error = (await conn.next()) as { type: string; code: string };
    assert.equal(error.code, "auth_failed");
    assert.equal(await opening, undefined);
  } finally {
    await host.dispose();
  }
});

test("malformed and oversized incoming frames destroy the connection", async () => {
  const { api, state } = fakeHerdr();
  const host = createTakeoverHost({ herdr: api });
  try {
    await openAttached(host, state);
    const env = state.splits[0].env!;
    const conn = new TestClient(Number(env.TAKEOVER_PORT));
    conn.send(validHello(env));
    await conn.next(); // welcome
    await conn.next(); // snapshot
    conn.socket.write(`${"x".repeat(70 * 1024)}\n`);
    const error = (await conn.next()) as { code: string };
    assert.equal(error.code, "frame_too_large");
    await conn.waitClosed();
  } finally {
    await host.dispose();
  }
});

test("pre-auth connections that never hello are dropped", async () => {
  const { api, state } = fakeHerdr();
  const host = createTakeoverHost({
    herdr: api,
    preAuthTimeoutMs: 120,
    helloApprovalTimeoutMs: 400,
  });
  try {
    const opening = host.open(openOptions());
    while (state.splits.length === 0) await delay(5);
    const env = state.splits[0].env!;
    const conn = new TestClient(Number(env.TAKEOVER_PORT));
    // No hello sent: the server must drop this connection on its own.
    const error = (await conn.next()) as { type: string; code: string };
    assert.equal(error.type, "error");
    assert.equal(error.code, "auth_timeout");
    await conn.waitClosed();
    assert.equal(await opening, undefined);
  } finally {
    await host.dispose();
  }
});

test("a modest connection cap rejects excess connections", async () => {
  const { api, state } = fakeHerdr();
  const host = createTakeoverHost({
    herdr: api,
    maxConns: 3,
    preAuthTimeoutMs: 300,
    helloApprovalTimeoutMs: 300,
  });
  try {
    const opening = host.open(openOptions());
    while (state.splits.length === 0) await delay(5);
    const env = state.splits[0].env!;
    const rejected: string[] = [];
    const clients: TestClient[] = [];
    for (let i = 0; i < 5; i++) {
      const conn = new TestClient(Number(env.TAKEOVER_PORT));
      clients.push(conn);
      void conn.next().then((message) => {
        const frame = message as { type: string; code?: string };
        if (frame.type === "error" && frame.code === "server_full") {
          rejected.push(frame.code);
        }
      });
    }
    await delay(250);
    assert.equal(rejected.length, 2); // 5 connections against a cap of 3
    assert.equal(await opening, undefined);
  } finally {
    await host.dispose();
  }
});

test("each source gets its own token and cannot authenticate another", async () => {
  const { api, state } = fakeHerdr();
  const host = createTakeoverHost({ herdr: api });
  try {
    const first = await openAttached(host, state);
    const second = await openAttached(host, state, {
      kind: "terminal",
      id: "bt-9",
      title: "dev",
      text: "out",
    });
    assert.notEqual(first.env.TAKEOVER_TOKEN, second.env.TAKEOVER_TOKEN);
    assert.equal(state.splits.length, 2);

    // Source A's token must not authenticate source B.
    const cross = new TestClient(Number(second.env.TAKEOVER_PORT));
    cross.send({
      type: "hello",
      protocol: TAKE_OVER_PROTOCOL,
      token: first.env.TAKEOVER_TOKEN,
      key: second.env.TAKEOVER_KEY,
    });
    const error = (await cross.next()) as { type: string; code: string };
    assert.equal(error.code, "auth_failed");
  } finally {
    await host.dispose();
  }
});

// --- Action routing --------------------------------------------------------------

test("actions route to handlers and acknowledge", async () => {
  const { api, state } = fakeHerdr();
  const host = createTakeoverHost({ herdr: api });
  const seen: Array<[string, string | undefined]> = [];
  try {
    const opening = host.open(
      openOptions(
        {},
        {
          actions: {
            send: (text) => seen.push(["send", text]),
            abort: () => seen.push(["abort", undefined]),
            kill: () => seen.push(["kill", undefined]),
            cancel: () => seen.push(["cancel", undefined]),
            refresh: () => seen.push(["refresh", undefined]),
          },
        },
      ),
    );
    await attachToPane(state); // authenticate the pane viewer
    assert.ok(await opening);
    const env = state.splits[0].env!;
    const conn = new TestClient(Number(env.TAKEOVER_PORT));
    conn.send(validHello(env));
    await conn.next(); // welcome
    await conn.next(); // snapshot
    await delay(300); // let the open-time dirty drain flush
    conn.drain();
    conn.send({ type: "action", name: "send", text: "keep going" });
    conn.send({ type: "action", name: "abort" });
    conn.send({ type: "action", name: "refresh" });
    const acks = [
      await conn.next(),
      await conn.next(),
      await conn.next(),
    ] as Array<{ type: string; action: string }>;
    assert.deepEqual(
      acks.map((ack) => [ack.type, ack.action]),
      [
        ["ack", "send"],
        ["ack", "abort"],
        ["ack", "refresh"],
      ],
    );
    assert.deepEqual(seen, [
      ["send", "keep going"],
      ["abort", undefined],
      ["refresh", undefined],
    ]);
  } finally {
    await host.dispose();
  }
});

test("unsupported action reports not_supported; unknown action errors", async () => {
  const { api, state } = fakeHerdr();
  const host = createTakeoverHost({ herdr: api });
  try {
    const opening = host.open(openOptions({}, { actions: { send: () => {} } }));
    await attachToPane(state);
    assert.ok(await opening);
    const env = state.splits[0].env!;
    const conn = new TestClient(Number(env.TAKEOVER_PORT));
    conn.send(validHello(env));
    await conn.next(); // welcome
    await conn.next(); // snapshot
    await delay(300); // flush the open-time dirty drain
    conn.drain();
    conn.send({ type: "action", name: "kill" });
    conn.send({ type: "action", name: "explode" });
    const [unsupported, unknown] = (await Promise.all([
      conn.next(),
      conn.next(),
    ])) as Array<{ type: string; error: string }>;
    assert.equal(unsupported.error, "not_supported");
    assert.equal(unknown.error, "unknown_action");
  } finally {
    await host.dispose();
  }
});

test("over-limit send text acks an error and keeps the connection", async () => {
  const { api, state } = fakeHerdr();
  const host = createTakeoverHost({ herdr: api });
  try {
    await openAttached(host, state);
    const env = state.splits[0].env!;
    const conn = new TestClient(Number(env.TAKEOVER_PORT));
    conn.send(validHello(env));
    await conn.next(); // welcome
    await conn.next(); // snapshot
    await delay(300);
    conn.drain();
    conn.send({ type: "action", name: "send", text: "x".repeat(9 * 1024) });
    const tooLong = (await conn.next()) as { type: string; error: string };
    assert.equal(tooLong.type, "ack");
    assert.equal(tooLong.error, "text_too_long");
    // The connection survives ordinary over-limit input.
    conn.send({ type: "action", name: "send", text: "fine" });
    const ok = (await conn.next()) as { type: string; error?: string };
    assert.equal(ok.type, "ack");
    assert.equal(ok.error, undefined);
    assert.equal(state.closed.length, 0); // pane untouched by big input
  } finally {
    await host.dispose();
  }
});

test("a throwing action handler acks handler_error and keeps the bridge", async () => {
  const { api, state } = fakeHerdr();
  const host = createTakeoverHost({ herdr: api });
  try {
    const opening = host.open(
      openOptions(
        {},
        {
          actions: {
            send: () => {
              throw new Error("exploded");
            },
            abort: () => {},
          },
        },
      ),
    );
    await attachToPane(state);
    assert.ok(await opening);
    const env = state.splits[0].env!;
    const conn = new TestClient(Number(env.TAKEOVER_PORT));
    conn.send(validHello(env));
    await conn.next(); // welcome
    await conn.next(); // snapshot
    await delay(300);
    conn.drain();
    conn.send({ type: "action", name: "send", text: "hi" });
    const errored = (await conn.next()) as { type: string; error: string };
    assert.equal(errored.type, "ack");
    assert.equal(errored.error, "handler_error");
    // Still functional afterwards.
    conn.send({ type: "action", name: "abort" });
    const fine = (await conn.next()) as { type: string; error?: string };
    assert.equal(fine.type, "ack");
    assert.equal(fine.error, undefined);
  } finally {
    await host.dispose();
  }
});

// --- Snapshot bounds / throttle --------------------------------------------------

test("snapshot text is bounded and sanitized", async () => {
  const { api, state } = fakeHerdr();
  const host = createTakeoverHost({ herdr: api });
  try {
    const huge = `${"\x1b[31m".repeat(10)}${"y".repeat(1024 * 1024)}`;
    const { conn } = await openAttached(host, state, { text: huge });
    const snapshot = (await conn.next()) as { type: string; text: string };
    assert.equal(snapshot.type, "snapshot");
    assert.ok(
      Buffer.byteLength(snapshot.text, "utf8") <= MAX_SNAPSHOT_TEXT_BYTES,
    );
    assert.equal(snapshot.text.includes("\x1b["), false);
    assert.ok(snapshot.text.endsWith("…[truncated]"));
  } finally {
    await host.dispose();
  }
});

test("snapshot frames stay below the viewer parse cap even when pathological", async () => {
  const { api, state } = fakeHerdr();
  const host = createTakeoverHost({ herdr: api });
  try {
    // Two full per-stream budgets of `"` — worst-case JSON escaping.
    const pathological = '"'.repeat(MAX_SNAPSHOT_TEXT_BYTES);
    const { conn } = await openAttached(host, state, {
      text: pathological,
      secondaryText: pathological,
    });
    const snapshot = (await conn.next()) as { type: string };
    const payload = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
    assert.equal(snapshot.type, "snapshot");
    assert.ok(payload <= MAX_SNAPSHOT_FRAME_BYTES);
    assert.ok(payload < 64 * 1024); // the viewer's parseIncomingLine cap
  } finally {
    await host.dispose();
  }
});

test("title and status are sanitized before reaching the viewer", async () => {
  const { api, state } = fakeHerdr();
  const host = createTakeoverHost({ herdr: api });
  try {
    const opening = host.open(
      openOptions({
        title: "\x1b[31mred\x1b[0m title",
        status: "run\u001b]0;x\u0007ning",
        id: "sa-\x1b[2msa",
      }),
    );
    const { conn } = await attachToPane(state);
    const welcome = (await conn.next()) as {
      type: string;
      title: string;
      status: string;
      id: string;
    };
    assert.equal(welcome.type, "welcome");
    assert.equal(welcome.title, "red title");
    assert.equal(welcome.status, "running");
    assert.equal(welcome.id, "sa-sa");
    const snapshot = (await conn.next()) as {
      type: string;
      title: string;
      status: string;
    };
    assert.equal(snapshot.type, "snapshot");
    assert.equal(snapshot.title, "red title");
    assert.equal(snapshot.status, "running");
    assert.ok(paneId(await opening));
  } finally {
    await host.dispose();
  }
});

function paneId(id: string | undefined): boolean {
  return typeof id === "string" && id.startsWith("w1:p");
}

test("snapshot pushes are throttled and coalesce at ~10 Hz", async () => {
  const { api, state } = fakeHerdr();
  const host = createTakeoverHost({ herdr: api });
  try {
    const { conn } = await openAttached(host, state);
    await delay(300); // let the open-time dirty drain flush
    conn.drain();
    // Two rapid changes collapse into one pushed snapshot.
    host.refresh(takeoverKey("subagent", "sa-1"));
    host.refresh(takeoverKey("subagent", "sa-1"));
    const first = (await conn.next()) as { text: string };
    assert.equal(first.text, "first line\nsecond line");
    // A later change pushes another snapshot.
    host.refresh(takeoverKey("subagent", "sa-1"));
    const second = (await conn.next()) as { text: string };
    assert.equal(second.text, "first line\nsecond line");
  } finally {
    await host.dispose();
  }
});

test("secondaryText travels for terminals", async () => {
  const { api, state } = fakeHerdr();
  const host = createTakeoverHost({ herdr: api });
  try {
    const { conn } = await openAttached(host, state, {
      kind: "terminal",
      id: "bt-1",
      text: "stdout here",
      secondaryText: "stderr here",
    });
    const snapshot = (await conn.next()) as { secondaryText?: string };
    assert.equal(snapshot.secondaryText, "stderr here");
  } finally {
    await host.dispose();
  }
});

// --- Disconnect never stops the target -------------------------------------------

test("viewer disconnect detaches without touching the target", async () => {
  const { api, state } = fakeHerdr();
  const host = createTakeoverHost({ herdr: api });
  let aborted = 0;
  let unsubscribed = 0;
  try {
    const opening = host.open({
      target: () => target(),
      actions: { abort: () => aborted++ },
      cwd: "/tmp",
      subscribe: () => () => unsubscribed++,
    });
    const { conn } = await attachToPane(state);
    await conn.next(); // welcome
    await conn.next(); // snapshot
    const paneId = await opening;
    assert.ok(paneId);
    conn.socket.destroy();
    await conn.waitClosed();
    await delay(20);
    assert.equal(aborted, 0); // closing the viewer did nothing to the target
    assert.equal(unsubscribed, 1); // but released the UI subscription
    // The source keeps working: a reopen splits a fresh pane, closing the stale one.
    const reopening = host.open({
      target: () => target(),
      actions: { abort: () => aborted++ },
      cwd: "/tmp",
    });
    await attachToPane(state, validHello, 1);
    const reopened = await reopening;
    assert.notEqual(reopened, paneId);
    assert.deepEqual(state.closed, [paneId]);
    assert.equal(state.splits.length, 2);
    assert.equal(aborted, 0);
  } finally {
    await host.dispose();
  }
});

// --- Idempotence / concurrency / fallback / rollback -----------------------------

test("reopen while attached reuses the same pane without splitting again", async () => {
  const { api, state } = fakeHerdr();
  const host = createTakeoverHost({ herdr: api });
  try {
    const { paneId } = await openAttached(host, state);
    const again = await host.open(openOptions());
    assert.equal(again, paneId);
    assert.equal(state.splits.length, 1);
  } finally {
    await host.dispose();
  }
});

test("reopening after detach rotates the source token", async () => {
  const { api, state } = fakeHerdr();
  const host = createTakeoverHost({ herdr: api });
  try {
    const first = await openAttached(host, state);
    first.conn.socket.destroy();
    await delay(25);

    const priorSplits = state.splits.length;
    const reopening = host.open(openOptions());
    const second = await attachToPane(state, validHello, priorSplits);
    await second.conn.next(); // welcome
    await second.conn.next(); // snapshot
    assert.ok(await reopening);
    assert.notEqual(
      second.env.TAKEOVER_TOKEN,
      first.env.TAKEOVER_TOKEN,
      "a detached pane token was reused",
    );
  } finally {
    await host.dispose();
  }
});

test("concurrent opens for the same key share one split", async () => {
  const { api, state } = fakeHerdr();
  const host = createTakeoverHost({ herdr: api });
  try {
    const first = host.open(openOptions());
    const second = host.open(openOptions());
    await attachToPane(state); // a single viewer authenticates
    const [a, b] = await Promise.all([first, second]);
    assert.ok(a);
    assert.equal(a, b);
    assert.equal(state.splits.length, 1); // no double split
    assert.deepEqual(state.closed, []); // nothing leaked to close later
  } finally {
    await host.dispose();
  }
});

test("dispose racing open returns undefined and closes the pane", async () => {
  const { api, state } = fakeHerdr();
  const host = createTakeoverHost({ herdr: api });
  try {
    const opening = host.open(openOptions());
    while (state.splits.length === 0) await delay(5);
    await host.dispose();
    const paneId = await opening;
    assert.equal(paneId, undefined);
    assert.deepEqual(state.closed, ["w1:p1"]);
  } finally {
    await host.dispose();
  }
});

test("a throwing subscribe closes the pane and falls back", async () => {
  const { api, state } = fakeHerdr();
  const host = createTakeoverHost({
    herdr: api,
    helloApprovalTimeoutMs: 150,
  });
  try {
    const paneId = await host.open(
      openOptions(
        {},
        {
          subscribe: () => {
            throw new Error("boom");
          },
        },
      ),
    );
    assert.equal(paneId, undefined);
    assert.equal(state.splits.length, 1);
    assert.equal(state.runs.length, 1);
    assert.deepEqual(state.closed, ["w1:p1"]);
    // Source bookkeeping is clean: a retry splits fresh.
    const retry = host.open(
      openOptions(
        {},
        {
          subscribe: () => () => {},
        },
      ),
    );
    await attachToPane(state);
    assert.equal(await retry, undefined); // no viewer attached to the retry
    assert.equal(state.splits.length, 2);
  } finally {
    await host.dispose();
  }
});

test("a throwing target getter falls back without crashing or splitting", async () => {
  const { api, state } = fakeHerdr();
  const host = createTakeoverHost({ herdr: api });
  try {
    const paneId = await host.open({
      target: () => {
        throw new Error("broken adapter");
      },
      actions: {},
      cwd: "/tmp",
    });
    assert.equal(paneId, undefined);
    assert.equal(state.splits.length, 0);
  } finally {
    await host.dispose();
  }
});

test("outside Herdr, open returns undefined and never splits", async () => {
  const { api, state } = fakeHerdr({ environment: false });
  const host = createTakeoverHost({ herdr: api });
  try {
    const paneId = await host.open(openOptions());
    assert.equal(paneId, undefined);
    assert.equal(state.splits.length, 0);
    assert.equal(host.endpoint, undefined);
  } finally {
    await host.dispose();
  }
});

test("split failure falls back to undefined with no leftover pane", async () => {
  const { api, state } = fakeHerdr({ splitError: new Error("nope") });
  const host = createTakeoverHost({ herdr: api });
  try {
    const paneId = await host.open(openOptions());
    assert.equal(paneId, undefined);
    assert.equal(state.splits.length, 1);
    assert.equal(state.runs.length, 0);
    assert.equal(state.closed.length, 0);
  } finally {
    await host.dispose();
  }
});

test("run failure rolls the pane back and falls back to undefined", async () => {
  const { api, state } = fakeHerdr({ runError: new Error("pane busy") });
  const host = createTakeoverHost({ herdr: api });
  try {
    const paneId = await host.open(openOptions());
    assert.equal(paneId, undefined);
    assert.equal(state.splits.length, 1);
    assert.equal(state.closed.length, 1); // the half-started pane was closed
  } finally {
    await host.dispose();
  }
});

test("dispose closes panes, unsubscribes, and renders the host inert", async () => {
  const { api, state } = fakeHerdr();
  const host = createTakeoverHost({ herdr: api });
  let unsubscribed = 0;
  const { paneId, conn, env } = await openAttached(host, state);
  assert.ok(paneId);
  assert.equal(env.TAKEOVER_KEY.startsWith("subagent:"), true);
  await host.dispose();
  assert.deepEqual(state.closed, [paneId]);
  assert.equal(unsubscribed, 0); // no subscribe supplied in openAttached
  await conn.waitClosed();
  const later = await host.open(openOptions());
  assert.equal(later, undefined); // disposed host is inert
  // A fresh host still works (dispose is not a process-level kill).
  const fresh = createTakeoverHost({ herdr: api });
  const prior = state.splits.length;
  const freshOpening = fresh.open(openOptions());
  await attachToPane(state, validHello, prior);
  assert.ok(await freshOpening);
  assert.equal(state.splits.length, prior + 1);
  await fresh.dispose();
});
