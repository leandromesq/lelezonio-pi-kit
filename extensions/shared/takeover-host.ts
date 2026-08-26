/**
 * Takeover bridge host — the deep shared module behind "take over" in a Herdr
 * pane for subagents, background terminals, and remote agents.
 *
 * One parent-owned loopback TCP JSONL bridge (127.0.0.1, ephemeral port)
 * serves thin interactive viewers running in Herdr panes. Each takeover has
 * its own crypto token (generated per source, delivered to the pane only via
 * `pane split --env`), and a source is only authenticated when a viewer hello
 * carries that token together with the source's own key. `open()` reports
 * success only after the correct viewer authenticates within a short window;
 * on timeout / auth / launch failure the half-opened pane is closed, the
 * source and its subscription are cleaned up, and the caller falls back to
 * the in-session overlay.
 *
 * The bridge only observes (snapshots) and relays user actions; the existing
 * managers stay the sole owners of the work. A viewer disconnect or pane
 * close never stops the target.
 *
 * Protocol bounds are coherent between host and viewer: snapshot text is
 * capped at 24 KB per stream (keeping the newest tail, marking dropped head
 * bytes), the serialized snapshot frame stays below 56 KB, and the viewer's
 * receive path rejects anything over 64 KB before JSON parsing. Incoming
 * frames ≤ 64 KB, send text ≤ 8 KB, snapshot pushes throttled to 10 Hz.
 * Snapshot frames to a slow socket are dropped in favor of the latest
 * (full-state, idempotent); control frames (welcome/ack/error/closed) are
 * never dropped.
 *
 * All Node-only: imports nothing from pi, so protocol/auth/rollback are
 * unit-testable without a TUI or a live Herdr server (inject a stub
 * HerdrPaneApi).
 */

import * as crypto from "node:crypto";
import * as net from "node:net";
import { fileURLToPath } from "node:url";
import {
  createHerdrPaneApi,
  shellQuote,
  tryOpenHerdrPane,
  type HerdrPaneApi,
} from "./herdr-pane.ts";

// --- Protocol + bounds -----------------------------------------------------------

export type TakeoverKind = "subagent" | "terminal" | "remote";

export interface TakeoverTarget {
  readonly kind: TakeoverKind;
  readonly id: string;
  readonly title: string;
  readonly status: string;
  /** Epoch ms when the target started; the viewer renders elapsed time. */
  readonly since: number;
  /** Main stream text (transcript / stdout / remote transcript). Unbounded here; the host caps it. */
  readonly text: string;
  /** Optional second stream the viewer can toggle to (terminal stderr). */
  readonly secondaryText?: string;
}

export interface TakeoverActions {
  readonly send?: (text: string) => void;
  readonly abort?: () => void;
  readonly kill?: () => void;
  readonly cancel?: () => void;
  /** Re-poll the source's own model (remote agents). */
  readonly refresh?: () => void;
}

/** Protocol version; the viewer's hello must carry exactly this value. */
export const TAKE_OVER_PROTOCOL = 1;
/** What a viewer may send us (hello/action frames). */
export const MAX_INCOMING_FRAME_BYTES = 64 * 1024;
/** Snapshot text cap per stream; the newest tail is kept, the head dropped. */
export const MAX_SNAPSHOT_TEXT_BYTES = 24 * 1024;
/** Hard cap on the serialized snapshot frame (< the viewer's 64 KB parse cap). */
export const MAX_SNAPSHOT_FRAME_BYTES = 56 * 1024;
export const MAX_SEND_TEXT_BYTES = 8 * 1024;
/** Slow-socket snapshot skip threshold (writableLength + frame). */
export const MAX_WRITABLE_BUFFER_BYTES = 256 * 1024;
export const PUBLISH_INTERVAL_MS = 100;
/** A connection that stays silent this long is dropped before auth. */
const PREAUTH_TIMEOUT_MS = 5_000;
/** How long `open()` waits for the correct viewer hello before falling back. */
const HELLO_APPROVAL_TIMEOUT_MS = 8_000;
/** Modest cap on simultaneous connections (pre- and post-auth). */
const MAX_CONNS = 8;
const CLOSE_PANE_TIMEOUT_MS = 3_000;

export interface OpenTakeoverOptions {
  /** Fresh snapshot getter; undefined once the target is gone/missing. */
  readonly target: () => TakeoverTarget | undefined;
  readonly actions: TakeoverActions;
  /** Working directory for the new pane. */
  readonly cwd: string;
  /**
   * Subscribe to source changes; the host calls it while a pane is attached
   * and invokes the returned unsubscribe on detach/dispose.
   */
  readonly subscribe?: () => () => void;
}

/** Stable registry key for a target; also the viewer's hello `key`. */
export function takeoverKey(kind: TakeoverKind, id: string): string {
  return `${kind}:${id}`;
}

// --- Define frame types shared between host and viewer ---------------------------

export interface HelloFrame {
  readonly type: "hello";
  readonly protocol: number;
  /** The per-source token this viewer's pane was launched with. */
  readonly token: string;
  /** `kind:id` of the target this viewer belongs to. */
  readonly key: string;
}

export interface ActionFrame {
  readonly type: "action";
  readonly name: "send" | "abort" | "kill" | "cancel" | "refresh";
  readonly text?: string;
}

// --- Sanitize + bound ------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const OSC_PATTERN =
  /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g;
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;

/** Strip control sequences so raw target output cannot hijack the pane TTY. */
export function sanitizeForTerminal(text: string): string {
  return text
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESCAPE_PATTERN, "")
    .replaceAll("\t", "  ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

/**
 * Trim `text` to `maxBytes` bytes of UTF-8, keeping the NEWEST tail (live
 * transcripts: the end matters) and marking the dropped head with an
 * omission marker.
 */
export function capBytes(text: string, maxBytes: number): string {
  const suffix = "\n…[truncated]";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  if (budget <= 0) return suffix.trimStart();
  if (Buffer.byteLength(text, "utf8") <= budget) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (Buffer.byteLength(text.slice(text.length - mid), "utf8") <= budget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return text.slice(text.length - low) + suffix;
}

// --- Frames ----------------------------------------------------------------------

interface WelcomeFrame {
  readonly type: "welcome";
  readonly ok: true;
  readonly protocol: number;
  readonly kind: TakeoverKind;
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly since: number;
  readonly actions: ReadonlyArray<
    "send" | "abort" | "kill" | "cancel" | "refresh"
  >;
}

interface SnapshotFrame {
  readonly type: "snapshot";
  readonly status: string;
  readonly title: string;
  readonly since: number;
  readonly text: string;
  readonly secondaryText?: string;
}

type ServerFrame =
  | WelcomeFrame
  | SnapshotFrame
  | { readonly type: "closed"; readonly reason: string }
  | { readonly type: "ack"; readonly action: string; readonly error?: string }
  | { readonly type: "error"; readonly code: string };

// --- Host ------------------------------------------------------------------------

export interface TakeoverHost {
  /**
   * Open (or reuse) a Herdr pane that shows and controls this target.
   * Resolves the pane id only after the correct viewer authenticates; returns
   * undefined when Herdr is unavailable, authentication times out or fails,
   * or the pane could not be opened — callers then fall back to the
   * in-session overlay. Concurrent opens for the same key share one attempt.
   */
  open(options: OpenTakeoverOptions): Promise<string | undefined>;
  /** Mark a source dirty; the host pulls its getter at most every 100 ms. */
  refresh(key: string): void;
  /** Close panes, sockets, and the server; unsubscribe sources. Idempotent. */
  dispose(): Promise<void>;
  /** Bridge endpoint (port only; tokens are per-source), for observability. */
  readonly endpoint: { readonly port: number } | undefined;
}

export interface Source {
  readonly key: string;
  readonly kind: TakeoverKind;
  readonly getTarget: () => TakeoverTarget | undefined;
  readonly actions: TakeoverActions;
  readonly cwd: string;
  subscribe?: () => () => void;
  unsub?: () => void;
  /** Pane we opened for this source; kept after detach so a stale pane can be closed on reopen. */
  paneId?: string;
  /** Unique per-source token; the viewer can only authenticate its own source. */
  readonly token: string;
  readonly conns: Set<net.Socket>;
  dirty: boolean;
  goneNotified: boolean;
  /** `open()` waiters, resolved when the first authenticated hello lands. */
  readonly attachWaiters: Array<() => void>;
}

interface Conn {
  source?: Source;
  readonly socket: net.Socket;
  helloDone: boolean;
  lineBuffer: Buffer;
  preAuthTimer?: ReturnType<typeof setTimeout>;
  pendingSnapshot?: SnapshotFrame;
}

export interface TakeoverHostOptions {
  /** Injectable Herdr pane API (tests). Defaults to the real CLI. */
  readonly herdr?: HerdrPaneApi;
  /** Pre-auth per-connection timeout (tests pass a small value). */
  readonly preAuthTimeoutMs?: number;
  /** How long open() waits for the viewer hello (tests pass a small value). */
  readonly helloApprovalTimeoutMs?: number;
  /** Connection cap (tests pass a small value). */
  readonly maxConns?: number;
}

export function createTakeoverHost(
  options?: TakeoverHostOptions,
): TakeoverHost {
  const herdr = options?.herdr ?? createHerdrPaneApi();
  const preAuthTimeoutMs = options?.preAuthTimeoutMs ?? PREAUTH_TIMEOUT_MS;
  const helloApprovalTimeoutMs =
    options?.helloApprovalTimeoutMs ?? HELLO_APPROVAL_TIMEOUT_MS;
  const maxConns = options?.maxConns ?? MAX_CONNS;
  const sources = new Map<string, Source>();
  const conns = new Set<Conn>();
  /** One in-flight open per key so concurrent opens cannot double-split. */
  const opening = new Map<string, Promise<string | undefined>>();
  const viewerPath = fileURLToPath(
    new URL("./takeover-viewer.mjs", import.meta.url),
  );
  let server: net.Server | undefined;
  let serverPromise: Promise<void> | undefined;
  let port = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  /** Lazily create the listener on first open (concurrent calls share it). */
  const ensureServer = (): Promise<void> => {
    if (serverPromise) return serverPromise;
    serverPromise = new Promise<void>((resolve, reject) => {
      const next = net.createServer((socket) => {
        const conn: Conn = {
          socket,
          helloDone: false,
          lineBuffer: Buffer.alloc(0),
        };
        if (conns.size >= maxConns) {
          failConn(conn, "server_full");
          return;
        }
        conns.add(conn);
        conn.preAuthTimer = setTimeout(() => {
          if (!conn.helloDone) failConn(conn, "auth_timeout");
        }, preAuthTimeoutMs);
        conn.preAuthTimer.unref?.();
        socket.on("data", (chunk: Buffer) => onData(conn, chunk));
        socket.on("error", () => {});
        socket.on("close", () => detachConn(conn));
        socket.on("drain", () => flushPending(conn));
        socket.setNoDelay(true);
      });
      next.on("error", reject);
      next.listen(0, "127.0.0.1", () => {
        server = next;
        const address = next.address();
        port = typeof address === "object" && address ? address.port : 0;
        timer ??= setInterval(() => drainDirty(), PUBLISH_INTERVAL_MS);
        timer.unref?.();
        resolve();
      });
    });
    return serverPromise;
  };

  // --- incoming -------------------------------------------------------------------

  const onData = (conn: Conn, chunk: Buffer) => {
    conn.lineBuffer = Buffer.concat([conn.lineBuffer, chunk]);
    // Flood guard: refuse to buffer more than a few frames worth.
    if (conn.lineBuffer.length > MAX_INCOMING_FRAME_BYTES * 4) {
      failConn(conn, "buffer_overflow");
      return;
    }
    let idx: number;
    while ((idx = conn.lineBuffer.indexOf(0x0a)) >= 0) {
      const raw = conn.lineBuffer.subarray(0, idx).toString("utf8").trim();
      conn.lineBuffer = conn.lineBuffer.subarray(idx + 1);
      if (!raw) continue;
      if (!handleLine(conn, raw)) break; // conn destroyed
    }
  };

  const failConn = (conn: Conn, code: string) => {
    if (conn.preAuthTimer) clearTimeout(conn.preAuthTimer);
    try {
      conn.socket.write(`${JSON.stringify({ type: "error", code })}\n`);
    } catch {
      // socket already gone
    }
    conn.socket.destroy();
  };

  const handleLine = (conn: Conn, raw: string): boolean => {
    if (Buffer.byteLength(raw, "utf8") > MAX_INCOMING_FRAME_BYTES) {
      failConn(conn, "frame_too_large");
      return false;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      failConn(conn, "bad_json");
      return false;
    }
    if (!conn.helloDone) return handleHello(conn, frame);
    handleAction(conn, frame);
    return true;
  };

  /** Authenticate the viewer: protocol, per-source token, and its own key. */
  const handleHello = (conn: Conn, frame: unknown): boolean => {
    const hello = frame as Partial<HelloFrame>;
    if (
      hello?.type !== "hello" ||
      hello.protocol !== TAKE_OVER_PROTOCOL ||
      typeof hello.token !== "string" ||
      typeof hello.key !== "string"
    ) {
      failConn(conn, "auth_failed");
      return false;
    }
    const source = sources.get(hello.key);
    if (!source) {
      failConn(conn, "no_source");
      return false;
    }
    // The token only authenticates its own source: a leaked token cannot
    // impersonate a different takeover.
    if (!verifyToken(hello.token, source.token)) {
      failConn(conn, "auth_failed");
      return false;
    }
    conn.helloDone = true;
    conn.source = source;
    if (conn.preAuthTimer) clearTimeout(conn.preAuthTimer);
    source.conns.add(conn.socket);
    source.dirty = true; // fresh snapshot right after attach
    for (const waiter of source.attachWaiters.splice(0)) waiter();
    writeLine(conn.socket, JSON.stringify(buildWelcome(source)));
    pushSnapshot(conn, source);
    return true;
  };

  /** A faulty adapter must degrade to target-gone, never crash the parent. */
  const readTarget = (source: Source): TakeoverTarget | undefined => {
    try {
      return source.getTarget();
    } catch {
      return undefined;
    }
  };

  /** Welcome title/status/id are target-controlled: sanitize before the wire. */
  const buildWelcome = (source: Source): WelcomeFrame => {
    const target = readTarget(source);
    const actions = (
      Object.keys(source.actions).filter(
        (name) => source.actions[name as keyof TakeoverActions] !== undefined,
      ) as Array<"send" | "abort" | "kill" | "cancel" | "refresh">
    ).sort();
    const id = target?.id ?? source.key.split(":")[1] ?? "take over";
    return {
      type: "welcome",
      ok: true,
      protocol: TAKE_OVER_PROTOCOL,
      kind: source.kind,
      id: sanitizeForTerminal(id) || "take over",
      title: sanitizeForTerminal(target?.title ?? "take over") || "take over",
      status: sanitizeForTerminal(target?.status ?? "gone") || "gone",
      since: target?.since ?? Date.now(),
      actions,
    };
  };

  const verifyToken = (candidate: string, expected: string): boolean => {
    const a = Buffer.from(candidate);
    const b = Buffer.from(expected);
    if (a.length !== b.length || a.length === 0) return false;
    return crypto.timingSafeEqual(a, b);
  };

  // --- actions -------------------------------------------------------------------

  /** Relay a viewer action; handlers may throw — never corrupt the host. */
  const handleAction = (conn: Conn, frame: unknown) => {
    const action = frame as Partial<ActionFrame>;
    const source = conn.source;
    if (action?.type !== "action" || typeof action.name !== "string") {
      failConn(conn, "bad_frame");
      return;
    }
    if (!source) {
      failConn(conn, "no_source");
      return;
    }
    switch (action.name) {
      case "send": {
        if (!source.actions.send)
          return ack(conn, action.name, "not_supported");
        const text = typeof action.text === "string" ? action.text : "";
        if (!text) return ack(conn, action.name, "empty_text");
        // Ordinary over-limit input must not kill the bridge connection.
        if (Buffer.byteLength(text, "utf8") > MAX_SEND_TEXT_BYTES) {
          return ack(conn, action.name, "text_too_long");
        }
        try {
          source.actions.send(text);
        } catch {
          return ack(conn, action.name, "handler_error");
        }
        return ack(conn, action.name);
      }
      case "abort":
      case "kill":
      case "cancel":
      case "refresh": {
        const handler = source.actions[action.name];
        if (!handler) return ack(conn, action.name, "not_supported");
        try {
          handler();
        } catch {
          return ack(conn, action.name, "handler_error");
        }
        return ack(conn, action.name);
      }
      default:
        return ack(conn, "unknown", "unknown_action");
    }
  };

  const ack = (conn: Conn, action: string, error?: string) => {
    writeLine(
      conn.socket,
      JSON.stringify({
        type: "ack",
        action,
        ...(error ? { error } : {}),
      } as ServerFrame),
    );
  };

  // --- snapshots -----------------------------------------------------------------

  const snapshotOf = (target: TakeoverTarget): SnapshotFrame => {
    // Title/status are target-controlled strings that reach the viewer header.
    const frame: SnapshotFrame = {
      type: "snapshot",
      status: sanitizeForTerminal(target.status),
      title: sanitizeForTerminal(target.title),
      since: target.since,
      text: capBytes(sanitizeForTerminal(target.text), MAX_SNAPSHOT_TEXT_BYTES),
      ...(target.secondaryText !== undefined
        ? {
            secondaryText: capBytes(
              sanitizeForTerminal(target.secondaryText),
              MAX_SNAPSHOT_TEXT_BYTES,
            ),
          }
        : {}),
    };
    return boundSnapshotFrame(frame);
  };

  /**
   * Guarantee the serialized snapshot stays below the viewer's parse cap even
   * under pathological JSON escaping (runs of `"` / `\`), shrinking text
   * budgets until the frame fits.
   */
  const boundSnapshotFrame = (frame: SnapshotFrame): SnapshotFrame => {
    let current = frame;
    let payload = Buffer.byteLength(JSON.stringify(current), "utf8");
    let budget = MAX_SNAPSHOT_TEXT_BYTES;
    while (payload > MAX_SNAPSHOT_FRAME_BYTES && budget >= 1024) {
      budget = Math.floor(budget / 2);
      current = {
        ...frame,
        text: capBytes(frame.text, budget),
        ...(frame.secondaryText !== undefined
          ? { secondaryText: capBytes(frame.secondaryText, budget) }
          : {}),
      };
      payload = Buffer.byteLength(JSON.stringify(current), "utf8");
    }
    return current;
  };

  const pushSnapshot = (conn: Conn, source: Source) => {
    const target = readTarget(source);
    if (!target) {
      if (!source.goneNotified) {
        source.goneNotified = true;
        writeLine(
          conn.socket,
          JSON.stringify({
            type: "closed",
            reason: "target_gone",
          } as ServerFrame),
        );
      }
      return;
    }
    writeSnapshot(conn, snapshotOf(target));
  };

  /** Snapshot frames are dropped when the socket is backed up; latest wins. */
  const writeSnapshot = (conn: Conn, frame: SnapshotFrame) => {
    const payload = Buffer.byteLength(JSON.stringify(frame), "utf8");
    if (conn.socket.writableLength + payload > MAX_WRITABLE_BUFFER_BYTES) {
      conn.pendingSnapshot = frame;
      return;
    }
    conn.pendingSnapshot = undefined;
    writeLine(conn.socket, JSON.stringify(frame));
  };

  const flushPending = (conn: Conn) => {
    if (!conn.pendingSnapshot) return;
    const frame = conn.pendingSnapshot;
    conn.pendingSnapshot = undefined;
    writeSnapshot(conn, frame);
  };

  const writeLine = (socket: net.Socket, line: string) => {
    try {
      socket.write(`${line}\n`);
    } catch {
      // Socket already destroyed; viewer connection is gone. The target is
      // never affected — detach is handled by the close handler.
    }
  };

  const drainDirty = () => {
    if (disposed) return;
    for (const source of sources.values()) {
      if (!source.dirty || source.conns.size === 0) continue;
      source.dirty = false;
      const target = readTarget(source);
      if (!target) {
        if (!source.goneNotified) {
          source.goneNotified = true;
          for (const socket of source.conns) {
            writeLine(
              socket,
              JSON.stringify({
                type: "closed",
                reason: "target_gone",
              } as ServerFrame),
            );
          }
        }
        continue;
      }
      const frame = snapshotOf(target);
      for (const socket of source.conns) {
        const conn = connOf(socket);
        if (conn) writeSnapshot(conn, frame);
      }
    }
  };

  const connOf = (socket: net.Socket): Conn | undefined =>
    [...conns].find((conn) => conn.socket === socket);

  const detachConn = (conn: Conn) => {
    conns.delete(conn);
    if (conn.preAuthTimer) clearTimeout(conn.preAuthTimer);
    const source = conn.source;
    if (!source) return;
    source.conns.delete(conn.socket);
    // Viewer/pane gone: release the UI subscription but never touch the target.
    if (source.conns.size === 0 && source.unsub) {
      const unsub = source.unsub;
      source.unsub = undefined;
      try {
        unsub();
      } catch {
        // UI subscription teardown must never corrupt bridge state.
      }
    }
  };

  // --- lifecycle ------------------------------------------------------------------

  const sourceSubscribed = (source: Source) => {
    if (!source.subscribe) return;
    source.unsub = source.subscribe();
  };

  const closePaneBestEffort = async (paneId: string): Promise<void> => {
    await Promise.race([
      herdr.close(paneId),
      new Promise<void>((resolve) => {
        const pending = setTimeout(resolve, CLOSE_PANE_TIMEOUT_MS);
        pending.unref?.();
      }),
    ]).catch(() => {});
  };

  const cleanupSource = (source: Source) => {
    source.dirty = false;
    source.paneId = undefined;
    if (source.unsub) {
      const unsub = source.unsub;
      source.unsub = undefined;
      try {
        unsub();
      } catch {
        // Ignore.
      }
    }
    sources.delete(source.key);
  };

  /** Resolve once a viewer with this source's token has authenticated. */
  const waitForAttach = (source: Source, timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (source.conns.size > 0) {
        resolve(true);
        return;
      }
      let settled = false;
      const finish = (attached: boolean) => {
        if (settled) return;
        settled = true;
        const idx = source.attachWaiters.indexOf(onAttach);
        if (idx >= 0) source.attachWaiters.splice(idx, 1);
        clearTimeout(timer);
        resolve(attached);
      };
      const onAttach = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      source.attachWaiters.push(onAttach);
    });

  const openInner = async (
    key: string,
    options: OpenTakeoverOptions,
    initialTarget: TakeoverTarget,
  ): Promise<string | undefined> => {
    if (disposed) return undefined;
    const createSource = (): Source => ({
      key,
      kind: initialTarget.kind,
      getTarget: options.target,
      actions: options.actions,
      cwd: options.cwd,
      subscribe: options.subscribe,
      token: crypto.randomBytes(24).toString("hex"),
      conns: new Set(),
      dirty: true,
      goneNotified: false,
      attachWaiters: [],
    });
    let source = sources.get(key);
    if (!source) {
      source = createSource();
      sources.set(key, source);
    }

    // Idempotent: one pane per kind/id while a viewer is attached.
    if (source.paneId && source.conns.size > 0) {
      source.dirty = true;
      return source.paneId;
    }
    // A detached viewer leaves a shell pane behind. Close it and replace the
    // source so the next takeover gets a fresh, independently scoped token.
    if (source.paneId) {
      const stale = source.paneId;
      source.paneId = undefined;
      await closePaneBestEffort(stale);
      cleanupSource(source);
      source = createSource();
      sources.set(key, source);
    }

    if (!herdr.environment()) {
      cleanupSource(source);
      return undefined;
    }

    try {
      await ensureServer();
      const paneId = await tryOpenHerdrPane(herdr, {
        cwd: source.cwd,
        env: {
          TAKEOVER_PORT: String(port),
          TAKEOVER_TOKEN: source.token,
          TAKEOVER_KEY: key,
        },
        noFocus: true,
        command: ["node", shellQuote(viewerPath)],
      });
      if (disposed) {
        // dispose() raced this open: never leave the pane behind.
        await closePaneBestEffort(paneId);
        return undefined;
      }
      source.paneId = paneId;
      try {
        sourceSubscribed(source);
      } catch {
        // A throwing subscription must not strand the pane we just opened.
        await closePaneBestEffort(paneId);
        cleanupSource(source);
        return undefined;
      }

      // Do not report success until the correct viewer authenticates.
      const attached = await waitForAttach(source, helloApprovalTimeoutMs);
      if (disposed || !attached) {
        if (!disposed) await closePaneBestEffort(paneId);
        cleanupSource(source);
        return undefined;
      }
      return paneId;
    } catch {
      // tryOpenHerdrPane already rolled back its own pane; drop the source
      // bookkeeping so a later open starts clean.
      if (source.paneId) {
        await closePaneBestEffort(source.paneId);
        source.paneId = undefined;
      }
      if (source.conns.size === 0) cleanupSource(source);
      return undefined;
    }
  };

  return {
    get endpoint() {
      return server ? { port } : undefined;
    },

    async open(options: OpenTakeoverOptions): Promise<string | undefined> {
      if (disposed) return undefined;
      let target: TakeoverTarget | undefined;
      try {
        target = options.target();
      } catch {
        return undefined;
      }
      if (!target) return undefined;
      const key = takeoverKey(target.kind, target.id);

      // Concurrent opens for the same key share one split/launch attempt.
      const inflight = opening.get(key);
      if (inflight) return inflight;
      const promise = openInner(key, options, target);
      opening.set(key, promise);
      try {
        return await promise;
      } finally {
        opening.delete(key);
      }
    },

    refresh(key: string): void {
      const source = sources.get(key);
      if (source) source.dirty = true;
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      for (const source of sources.values()) {
        source.dirty = false;
        // Wake any pending open() so it sees `disposed` and returns promptly.
        for (const waiter of source.attachWaiters.splice(0)) waiter();
        if (source.unsub) {
          const unsub = source.unsub;
          source.unsub = undefined;
          try {
            unsub();
          } catch {
            // Ignore UI teardown errors.
          }
        }
      }
      const paneIds = [...sources.values()]
        .map((source) => source.paneId)
        .filter((paneId): paneId is string => !!paneId);
      sources.clear();
      for (const conn of [...conns]) {
        if (conn.preAuthTimer) clearTimeout(conn.preAuthTimer);
        conn.socket.destroy();
      }
      conns.clear();
      if (server) {
        server.close();
        server = undefined;
        serverPromise = undefined;
      }
      // Close panes we opened, best effort and bounded — never the target.
      for (const paneId of paneIds) {
        await closePaneBestEffort(paneId);
      }
    },
  };
}

// --- Process-wide singleton -------------------------------------------------------

let singleton: TakeoverHost | undefined;

/** Shared host for all extensions; lazily created on first takeover attempt. */
export function takeoverHost(): TakeoverHost {
  return (singleton ??= createTakeoverHost());
}

/** Parent shutdown cleanup: close panes, sockets, and the server. */
export function disposeTakeoverHost(): Promise<void> {
  const host = singleton;
  singleton = undefined;
  return host ? host.dispose() : Promise.resolve();
}

/** Test seam: replace the singleton so UI entry points are testable. */
export function setTakeoverHostForTests(host: TakeoverHost | undefined): void {
  singleton = host;
}
