#!/usr/bin/env node
/**
 * Takeover viewer — thin interactive terminal UI that attaches to the
 * parent-owned takeover bridge and shows/controls ONE existing target
 * (subagent, background terminal, or remote agent).
 *
 * This viewer never starts or restarts work: it only renders snapshots and
 * relays user actions over the bridge. Detaching (`q`) or losing the bridge
 * never stops the target; the existing managers stay the sole owners.
 *
 * Two explicit modes: command/navigation mode (default: q/t/r/g/G/arrows
 * act) and input mode (entered with `i` or Enter, where every printable
 * character — including q/t/r/g/G and emoji — edits the compose buffer;
 * Enter sends, Esc cancels, Ctrl+C clears). Input is byte-capped; the host
 * acks over-limit sends instead of dropping the bridge.
 *
 * Plain Node, zero deps. Pure functions are exported for unit tests; main()
 * runs only when executed directly.
 */

import net from "node:net";
import { pathToFileURL } from "node:url";

export const TAKE_OVER_PROTOCOL = 1;

// ---------------------------------------------------------------------------
// Bounds shared with the host (host constants are authoritative; mirrored
// here so the viewer can never send or buffer beyond them).
// ---------------------------------------------------------------------------

const MAX_SEND_TEXT_BYTES = 8 * 1024;
/** Viewer receive buffer bound before a newline is found. */
const MAX_RECV_BUFFER_BYTES = 96 * 1024;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested from takeover-viewer.test.ts)
// ---------------------------------------------------------------------------

/** Last line of defense against ANSI/control sequences in target output. */
export function stripAnsi(text) {
  return String(text)
    .replace(
      /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g,
      "",
    )
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g, "")
    .replaceAll("\t", "  ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

/**
 * Parse one JSONL line from the bridge. Lines over 64 KB are rejected before
 * parsing (the host never sends snapshot frames above ~56 KB).
 */
export function parseIncomingLine(line) {
  if (line.length > 64 * 1024) return { error: "frame_too_large" };
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return { error: "bad_json" };
  }
  if (typeof frame?.type !== "string") return { error: "bad_frame" };
  return { frame };
}

export function shortElapsed(since) {
  const totalSeconds = Math.max(
    0,
    Math.round((Date.now() - (since ?? Date.now())) / 1000),
  );
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m${String(seconds).padStart(2, "0")}s`
    : `${seconds}s`;
}

export function truncateToWidth(line, width) {
  if (line.length <= width) return line;
  return line.slice(0, Math.max(0, width - 1)) + "…";
}

function wrapLines(text, width) {
  const out = [];
  for (const raw of stripAnsi(String(text)).split("\n")) {
    const line = raw.split("\r").at(-1) ?? "";
    if (!line) {
      out.push("");
      continue;
    }
    if (line.length <= width) {
      out.push(line);
      continue;
    }
    let rest = line;
    while (rest.length > width) {
      out.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    out.push(rest);
  }
  if (out.at(-1) === "") out.pop();
  return out.length ? out : [""];
}

// ---------------------------------------------------------------------------
// State + input (pure, testable)
// ---------------------------------------------------------------------------

export function createViewerState() {
  return {
    phase: "connecting", // connecting | live | confirm | closed
    error: undefined,
    closedReason: undefined,
    welcome: undefined, // { kind, id, title, status, since, actions }
    snap: undefined, // { status, title, since, text, secondaryText }
    scrollOffset: 0, // wrapped lines from bottom; 0 = pinned
    stream: "main", // main | secondary
    mode: "command", // command (navigation) | input (composing)
    input: "",
    notice: undefined, // transient message (e.g. ack errors)
    confirm: undefined, // { label, action }
    detaching: false,
  };
}

const DESTRUCTIVE_LABELS = {
  abort: "Abort this subagent?",
  kill: "Kill this background terminal?",
  cancel: "Cancel this remote agent?",
};

/** Keys classifyKey can return that are NOT text to be inserted. */
const SPECIAL_KEYS = new Set([
  "enter",
  "esc",
  "backspace",
  "up",
  "down",
  "pgup",
  "pgdn",
  "ctrl-c",
]);

function deleteLastCodePoint(text) {
  const chars = Array.from(text);
  chars.pop();
  return chars.join("");
}

/** Append a character to the compose buffer, byte-capping it. */
function appendInput(next, key) {
  const candidate = next.input + key;
  if (Buffer.byteLength(candidate, "utf8") > MAX_SEND_TEXT_BYTES) {
    return {
      ...next,
      notice: `input limit ${MAX_SEND_TEXT_BYTES / 1024} KB — esc to cancel`,
    };
  }
  return { ...next, input: candidate };
}

/**
 * Normalized key → new state + side-effect events. Pure.
 * q/t/r/g/G act as commands only outside input mode; inside input mode every
 * printable character (including those letters and emoji) edits the buffer.
 */
export function applyKey(state, key) {
  const next = { ...state };
  if (next.detaching) return { state: next, events: [] };

  // A real key press clears any transient notice (e.g. ack errors).
  if (next.notice) next.notice = undefined;

  // Confirm mode: y/ctrl+c confirm, anything else cancels.
  if (next.phase === "confirm" && next.confirm) {
    if (key === "y" || key === "ctrl-c") {
      return {
        state: { ...next, phase: "live", confirm: undefined },
        events: [{ type: "action", name: next.confirm.action }],
      };
    }
    return {
      state: { ...next, phase: "live", confirm: undefined },
      events: [],
    };
  }

  // Detach remains available after bridge closure and while connecting.
  if (key === "q" && next.mode === "command") {
    return {
      state: { ...next, detaching: true },
      events: [{ type: "detach" }],
    };
  }

  if (next.phase === "connecting" || next.phase === "closed") {
    return { state: next, events: [] };
  }

  if (key === "ctrl-c") {
    // Input mode: Ctrl+C clears the compose buffer (stays in input mode).
    if (next.mode === "input") {
      return { state: { ...next, input: "" }, events: [] };
    }
    const actions = next.welcome?.actions ?? [];
    const destructive = ["abort", "kill", "cancel"].find((name) =>
      actions.includes(name),
    );
    if (!destructive) return { state: next, events: [] };
    return {
      state: {
        ...next,
        phase: "confirm",
        confirm: {
          label: DESTRUCTIVE_LABELS[destructive],
          action: destructive,
        },
      },
      events: [],
    };
  }

  // --- command / navigation mode ------------------------------------------
  if (next.mode === "command") {
    if (
      (key === "i" || key === "enter") &&
      next.welcome?.actions?.includes("send")
    ) {
      return { state: { ...next, mode: "input" }, events: [] };
    }
    if (key === "up") {
      return {
        state: { ...next, scrollOffset: next.scrollOffset + 4 },
        events: [],
      };
    }
    if (key === "down") {
      return {
        state: {
          ...next,
          scrollOffset: Math.max(0, next.scrollOffset - 4),
        },
        events: [],
      };
    }
    if (key === "pgup") {
      return {
        state: { ...next, scrollOffset: next.scrollOffset + 20 },
        events: [],
      };
    }
    if (key === "pgdn") {
      return {
        state: {
          ...next,
          scrollOffset: Math.max(0, next.scrollOffset - 20),
        },
        events: [],
      };
    }
    if (key === "g") {
      return {
        state: { ...next, scrollOffset: Number.MAX_SAFE_INTEGER },
        events: [],
      };
    }
    if (key === "G") {
      return { state: { ...next, scrollOffset: 0 }, events: [] };
    }
    if (key === "t" && next.snap?.secondaryText !== undefined) {
      return {
        state: {
          ...next,
          stream: next.stream === "main" ? "secondary" : "main",
          scrollOffset: 0,
        },
        events: [],
      };
    }
    if (key === "r" && next.welcome?.actions?.includes("refresh")) {
      return { state: next, events: [{ type: "action", name: "refresh" }] };
    }
    // Anything else (including stray printable keys) is a no-op in command
    // mode — letters only compose inside input mode.
    return { state: next, events: [] };
  }

  // --- input mode ----------------------------------------------------------
  if (key === "enter") {
    const text = next.input.trim();
    if (
      text &&
      next.welcome?.actions?.includes("send") &&
      Buffer.byteLength(text, "utf8") <= MAX_SEND_TEXT_BYTES
    ) {
      return {
        state: {
          ...next,
          mode: "command",
          input: "",
          scrollOffset: 0,
        },
        events: [{ type: "send", text }],
      };
    }
    // Empty input: just leave input mode without sending.
    return { state: { ...next, mode: "command" }, events: [] };
  }
  if (key === "esc") {
    // Esc exits input mode and cancels the compose buffer.
    return { state: { ...next, mode: "command", input: "" }, events: [] };
  }
  if (key === "backspace") {
    return {
      state: { ...next, input: deleteLastCodePoint(next.input) },
      events: [],
    };
  }
  if (SPECIAL_KEYS.has(key)) {
    // Navigation keys are ignored while composing.
    return { state: next, events: [] };
  }
  if (typeof key === "string" && key.length >= 1) {
    return { state: appendInput(next, key), events: [] };
  }
  return { state: next, events: [] };
}

// ---------------------------------------------------------------------------
// Rendering (pure, testable)
// ---------------------------------------------------------------------------

/** Build the pane screen as plain lines (no ANSI). */
export function buildLines(state, width, height) {
  const header = renderHeader(state, width);
  const out = [header.line];
  if (header.sub) out.push(header.sub);
  out.push("─".repeat(Math.max(1, width)));

  const content = contentLines(state, width);
  const marker = state.scrollOffset > 0 ? 1 : 0;
  const footerLines = renderFooter(state, width);
  const bottomChrome = 1 + marker + footerLines.length; // separator + marker + footer
  const viewport = Math.max(1, height - out.length - bottomChrome);
  const maxOffset = Math.max(0, content.length - viewport);
  const offset = Math.min(Math.max(0, state.scrollOffset), maxOffset);
  const end = content.length - offset;
  out.push(...content.slice(Math.max(0, end - viewport), end));
  while (out.length < height - bottomChrome) out.push("");
  if (marker) out.push(`... ${offset} wrapped lines above · ↓/pgdn`);
  out.push("─".repeat(Math.max(1, width)));
  for (const line of footerLines) out.push(truncateToWidth(line, width));
  return out.slice(0, height);
}

/** Title/status/id are target-controlled: strip ANSI before rendering. */
function renderHeader(state, width) {
  const fallback =
    state.phase === "connecting"
      ? "connecting to takeover bridge…"
      : (state.error ?? state.closedReason ?? "take over");
  const welcome = state.welcome;
  const snap = state.snap ?? state.welcome;
  if (!welcome || !snap)
    return { line: truncateToWidth(fallback, width), sub: "" };
  const kindLabel =
    {
      subagent: "subagent",
      terminal: "terminal",
      remote: "remote",
    }[welcome.kind] ?? welcome.kind;
  const elapsed = shortElapsed(snap.since ?? welcome.since ?? Date.now());
  const sanitized = (value) => stripAnsi(String(value ?? "")) || "?";
  return {
    line: truncateToWidth(
      `[${kindLabel}] ${sanitized(welcome.id)} · ${sanitized(snap.title ?? welcome.title)} · ${sanitized(snap.status ?? welcome.status)} · ${elapsed}`,
      width,
    ),
    sub: state.stream === "secondary" ? "stderr stream (t to toggle)" : "",
  };
}

function contentLines(state, width) {
  const snap = state.snap;
  if (!snap) return ["(no output yet)"];
  const text =
    state.stream === "secondary" && snap.secondaryText !== undefined
      ? snap.secondaryText
      : snap.text;
  return wrapLines(text, width);
}

function renderFooter(state, width) {
  const out = [];
  if (state.notice) out.push(`  ${state.notice}`);
  if (state.phase === "confirm" && state.confirm) {
    out.push(
      ` ${state.confirm.label}  y/ctrl+c confirm · any other key cancels`,
    );
    return out;
  }
  if (state.mode === "input") {
    const canSend = state.welcome?.actions?.includes("send");
    out.push(
      `> ${state.input}█${canSend ? "" : "  (send unsupported — esc to cancel)"}`,
    );
    return out;
  }
  if (!state.welcome) {
    out.push(
      state.phase === "connecting"
        ? "  connecting to takeover bridge…"
        : `  ${state.closedReason ?? "closed — target keeps running"}`,
    );
    return out;
  }
  const actions = state.welcome?.actions ?? [];
  const hints = ["q detach"];
  if (["abort", "kill", "cancel"].some((name) => actions.includes(name))) {
    hints.push("ctrl+c destructive (confirm)");
  }
  if (actions.includes("send")) hints.push("i/enter type");
  if (actions.includes("refresh")) hints.push("r refresh");
  if (state.snap?.secondaryText !== undefined) hints.push("t stderr");
  hints.push("↑/↓ scroll");
  out.push(`  ${hints.join(" · ")}`);
  return out;
}

// ---------------------------------------------------------------------------
// Raw-TTY entry point
// ---------------------------------------------------------------------------

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
}

const CSI_KEYS = {
  "\u001b[A": "up",
  "\u001b[B": "down",
  "\u001b[5~": "pgup",
  "\u001b[6~": "pgdn",
};

/** Classify decoded characters; `esc` box holds an in-progress escape seq. */
export function classifyKey(ch, esc) {
  if (ch === "\u001b") {
    esc.part = "\u001b";
    return undefined;
  }
  if (esc.part) {
    const prev = esc.part;
    esc.part += ch;
    const seq = esc.part;
    if (seq === "\u001b[") return undefined; // waiting for the rest
    if (prev === "\u001b") {
      // Second byte: only '[' starts a CSI sequence; anything else is a bare
      // escape (Esc key) or a private/vendor sequence we ignore.
      if (ch !== "[") {
        esc.part = "";
        return "esc";
      }
      return undefined;
    }
    // CSI: consume parameter/intermediate bytes, finish on a final byte.
    const isParamOrIntermediate =
      (ch >= "0" && ch <= "?") || (ch >= " " && ch <= "/");
    if (isParamOrIntermediate) return undefined;
    if (ch >= "@" && ch <= "~") {
      esc.part = "";
      return CSI_KEYS[seq] ?? undefined;
    }
    esc.part = "";
    return undefined;
  }
  if (ch === "\r" || ch === "\n") return "enter";
  if (ch === "\x7f" || ch === "\b") return "backspace";
  if (ch === "\x03") return "ctrl-c";
  return ch;
}

export function mainViewer() {
  const port = Number(process.env.TAKEOVER_PORT ?? "");
  const token = process.env.TAKEOVER_TOKEN ?? "";
  const key = process.env.TAKEOVER_KEY ?? "";
  if (!port || !token || !key) {
    process.stderr.write(
      "takeover viewer: TAKEOVER_PORT/TAKEOVER_TOKEN/TAKEOVER_KEY not set.\n",
    );
    process.exit(1);
  }

  const state = createViewerState();
  let socket = net.createConnection({ host: "127.0.0.1", port });
  let screen = "";
  let buf = Buffer.alloc(0);
  const esc = { part: "" };

  const redraw = () => {
    const width = Math.max(20, process.stdout.columns || 80);
    const height = Math.max(8, process.stdout.rows || 24);
    const lines = buildLines(state, width, height);
    const next = `\x1b[2J\x1b[H${lines.join("\r\n")}`;
    if (next !== screen) {
      screen = next;
      process.stdout.write(next);
    }
  };

  const send = (frame) => {
    if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
  };

  const detach = () => {
    state.detaching = true;
    try {
      process.stdin.setRawMode(false);
    } catch {
      // stdin may already be gone
    }
    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(
      `detached — ${state.welcome?.id ?? "target"} keeps running (close this pane when done)\n`,
    );
    try {
      socket.end();
    } catch {
      // ignore
    }
    process.exit(0);
  };

  const emitEvents = (events) => {
    for (const event of events) {
      if (event.type === "send") {
        // Input is byte-capped while composing; never exceed the host cap.
        send({ type: "action", name: "send", text: String(event.text) });
      } else if (event.type === "action") {
        send({ type: "action", name: event.name });
      } else if (event.type === "detach") {
        detach();
      }
    }
    redraw();
  };

  // Transport ---------------------------------------------------------------
  socket.on("connect", () =>
    send({ type: "hello", protocol: TAKE_OVER_PROTOCOL, token, key }),
  );
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    // Bound the receive buffer before a newline: a pathological frame must
    // not grow unbounded memory, and any frame beyond the protocol bound is
    // fatal on this side (the host never sends frames that large).
    if (buf.length > MAX_RECV_BUFFER_BYTES) {
      state.phase = "closed";
      state.closedReason = "bridge protocol error: oversized frame";
      redraw();
      socket.destroy();
      return;
    }
    let idx;
    while ((idx = buf.indexOf(0x0a)) >= 0) {
      const line = buf.subarray(0, idx).toString("utf8").trim();
      buf = buf.subarray(idx + 1);
      if (line) onLine(line);
    }
  });
  socket.on("error", () => {
    if (!state.detaching) {
      state.phase = "closed";
      state.closedReason = "bridge unavailable — target keeps running";
      redraw();
    }
  });
  socket.on("close", () => {
    if (!state.detaching && state.phase !== "closed") {
      state.phase = "closed";
      state.closedReason = "bridge closed — target keeps running";
      redraw();
    }
  });

  const onLine = (line) => {
    const { frame, error } = parseIncomingLine(line);
    if (error) {
      state.phase = "closed";
      state.error = `bridge error: ${error}`;
      redraw();
      return;
    }
    switch (frame.type) {
      case "welcome":
        state.welcome = frame;
        state.phase = "live";
        break;
      case "snapshot":
        state.snap = frame;
        if (state.phase === "connecting") state.phase = "live";
        break;
      case "closed":
        state.phase = "closed";
        state.closedReason =
          frame.reason === "target_gone"
            ? "target finished — q to leave"
            : frame.reason;
        break;
      case "ack":
        if (frame.error) {
          state.notice = `${frame.action}: ${frame.error}`;
        }
        break;
      case "error":
        state.phase = "closed";
        state.error = `bridge error: ${frame.code ?? "unknown"}`;
        break;
      default:
        break;
    }
    redraw();
  };

  // Input ------------------------------------------------------------------
  try {
    process.stdin.setRawMode(true);
  } catch {
    // Not a TTY: render only, no input.
  }
  process.stdin.resume();
  const decoder = new TextDecoder("utf-8");
  let escapeTimer;
  const dispatchKey = (key) => {
    const { state: next, events } = applyKey(state, key);
    Object.assign(state, next);
    if (events.length) emitEvents(events);
  };
  process.stdin.on("data", (chunk) => {
    if (escapeTimer) {
      clearTimeout(escapeTimer);
      escapeTimer = undefined;
    }
    const text = decoder.decode(Buffer.from(chunk), { stream: true });
    for (const ch of text) {
      const key = classifyKey(ch, esc);
      if (key !== undefined) dispatchKey(key);
    }
    // A bare Escape has no terminating byte. Wait briefly so CSI arrow/page
    // sequences can arrive, then deliver Esc without swallowing the next key.
    if (esc.part === "\u001b") {
      escapeTimer = setTimeout(() => {
        escapeTimer = undefined;
        if (esc.part !== "\u001b") return;
        esc.part = "";
        dispatchKey("esc");
        redraw();
      }, 35);
      escapeTimer.unref?.();
    }
    redraw();
  });

  process.stdout.on("resize", redraw);
  const ticker = setInterval(redraw, 1_000);
  ticker.unref?.();

  redraw();
}

if (isMain()) {
  mainViewer();
}
