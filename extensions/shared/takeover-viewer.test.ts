import assert from "node:assert/strict";
import test from "node:test";

// The viewer is plain JS running in a Herdr pane; tests import its pure parts.
const viewer = await import("./takeover-viewer.mjs");
const {
  applyKey,
  buildLines,
  classifyKey,
  createViewerState,
  parseIncomingLine,
  shortElapsed,
  stripAnsi,
} = viewer;

function liveState(actions: string[] = ["send", "abort"]) {
  const state = createViewerState();
  state.phase = "live";
  state.welcome = {
    kind: "subagent",
    id: "sa-1",
    title: "Fix parser",
    status: "running",
    since: Date.now() - 5000,
    actions,
  };
  state.snap = {
    status: "running",
    title: "Fix parser",
    since: Date.now() - 5000,
    text: "line one\nline two",
  };
  return state;
}

function inputState(actions: string[] = ["send", "abort"]) {
  return applyKey(liveState(actions), "i").state;
}

// --- frame parsing ---------------------------------------------------------------

test("parseIncomingLine accepts valid frames and rejects garbage", () => {
  assert.deepEqual(parseIncomingLine('{"type":"snapshot","text":"a"}'), {
    frame: { type: "snapshot", text: "a" },
  });
  assert.equal(parseIncomingLine("not json").error, "bad_json");
  assert.equal(parseIncomingLine("[]").error, "bad_frame");
  assert.equal(
    parseIncomingLine("x".repeat(70 * 1024)).error,
    "frame_too_large",
  );
});

test("stripAnsi removes CSI/OSC escapes and control chars", () => {
  assert.equal(stripAnsi("\x1b[31mred\x1b[0m"), "red");
  assert.equal(stripAnsi("\u001b]0;tab\u0007rest"), "rest");
  assert.equal(stripAnsi("a\x00b\tc"), "ab  c");
});

test("shortElapsed formats sub-minute and minutes", () => {
  const past = Date.now() - 65_000;
  assert.match(shortElapsed(past), /1m0[45]s/);
  assert.equal(shortElapsed(Date.now()), "0s");
});

// --- modes: command vs input -----------------------------------------------------

test("i and Enter enter input mode from command mode", () => {
  assert.equal(applyKey(liveState(), "i").state.mode, "input");
  assert.equal(applyKey(liveState(), "enter").state.mode, "input");
  // Command mode ignores stray printable keys.
  const stray = applyKey(liveState(), "h").state;
  assert.equal(stray.input, "");
  assert.equal(stray.mode, "command");

  // Read-only terminals must not enter a useless compose mode.
  assert.equal(applyKey(liveState(["kill"]), "enter").state.mode, "command");
  assert.equal(applyKey(liveState(["kill"]), "i").state.mode, "command");
});

test("input mode: typing, backspace, enter emits send and leaves input mode", () => {
  const s1 = applyKey(inputState(), "h").state;
  const s2 = applyKey(s1, "i").state;
  assert.equal(s2.input, "hi");
  const back = applyKey(s2, "backspace").state;
  assert.equal(back.input, "h");
  const { state, events } = applyKey(back, "enter");
  assert.deepEqual(events, [{ type: "send", text: "h" }]);
  assert.equal(state.input, "");
  assert.equal(state.mode, "command");
});

test("inside input mode q/t/r/g/G (and emoji) edit text, never commands", () => {
  let state = inputState(["send", "refresh"]);
  for (const key of ["q", "t", "r", "g", "G"]) {
    const { state: next, events } = applyKey(state, key);
    state = next;
    assert.deepEqual(events, []);
    assert.equal(next.input.endsWith(key), true);
  }
  assert.equal(state.input, "qtrgG");
  assert.equal(state.detaching, false);
  assert.equal(state.stream, "main");

  // Emoji / non-BMP code points are a single insertable unit.
  const emoji = applyKey(inputState(), "😀").state;
  assert.equal(emoji.input, "😀");
  assert.equal(Buffer.byteLength(emoji.input, "utf8"), 4);

  // Backspace removes whole code points, not surrogate halves.
  const back = applyKey(applyKey(emoji, "backspace").state, "x").state;
  assert.equal(back.input, "x");
});

test("Esc exits and cancels input; Ctrl+C clears the buffer and stays", () => {
  const typed = applyKey(inputState(), "x").state;
  const cancelled = applyKey(typed, "esc").state;
  assert.equal(cancelled.mode, "command");
  assert.equal(cancelled.input, "");

  const cleared = applyKey(typed, "ctrl-c").state;
  assert.equal(cleared.input, "");
  assert.equal(cleared.mode, "input"); // still composing after a clear
  assert.equal(cleared.phase, "live");
});

test("input is byte-capped with a notice, never silently exceeding the limit", () => {
  let state = inputState();
  const filler = "x".repeat(6 * 1024);
  state = applyKey(state, filler).state;
  assert.equal(Buffer.byteLength(state.input, "utf8"), 6 * 1024);
  const over = applyKey(state, "y".repeat(3 * 1024)).state;
  assert.equal(Buffer.byteLength(over.input, "utf8") > 8 * 1024, false);
  assert.match(over.notice ?? "", /input limit/);
  const fresh = applyKey(state, "z").state;
  assert.equal(Buffer.byteLength(fresh.input, "utf8") <= 8 * 1024, true);
});

test("a key press clears a stale notice", () => {
  const state = { ...liveState(), notice: "send: text_too_long" };
  const next = applyKey(state, "i").state;
  assert.equal(next.notice, undefined);
});

test("ctrl+c with empty input asks for a destructive confirm; not in input", () => {
  // In command mode with an empty buffer: dangerous-action confirm.
  const { state } = applyKey(liveState(), "ctrl-c");
  assert.equal(state.phase, "confirm");
  assert.equal(state.confirm.action, "abort");
  assert.match(state.confirm.label, /Abort this subagent/);

  // In input mode Ctrl+C clears instead of confirming.
  const mid = applyKey(inputState(), "hello").state;
  const cleared = applyKey(mid, "ctrl-c").state;
  assert.equal(cleared.phase, "live");
  assert.equal(cleared.input, "");
});

test("confirm resolves with y and cancels with any other key", () => {
  const confirmed = applyKey(applyKey(liveState(), "ctrl-c").state, "y");
  assert.deepEqual(confirmed.events, [{ type: "action", name: "abort" }]);
  assert.equal(confirmed.state.phase, "live");
  assert.equal(confirmed.state.confirm, undefined);

  const cancelled = applyKey(applyKey(liveState(), "ctrl-c").state, "esc");
  assert.deepEqual(cancelled.events, []);
  assert.equal(cancelled.state.phase, "live");
  assert.equal(cancelled.state.confirm, undefined);
});

test("terminal kill confirm uses the kill action", () => {
  const state = liveState(["kill"]);
  state.welcome.kind = "terminal";
  const { state: confirmed } = applyKey(applyKey(state, "ctrl-c").state, "y");
  assert.equal(confirmed.phase, "live");
  const confirm = applyKey(liveState(["kill"]), "ctrl-c").state;
  assert.match(confirm.confirm.label, /Kill this background terminal/);
  assert.equal(confirm.confirm.action, "kill");
});

test("q detaches in command mode only; r refreshes only when supported", () => {
  const detach = applyKey(liveState(), "q");
  assert.deepEqual(detach.events, [{ type: "detach" }]);
  assert.equal(detach.state.detaching, true);

  const closed = liveState();
  closed.phase = "closed";
  assert.deepEqual(applyKey(closed, "q").events, [{ type: "detach" }]);

  const connecting = liveState();
  connecting.phase = "connecting";
  assert.deepEqual(applyKey(connecting, "q").events, [{ type: "detach" }]);

  const noRefresh = applyKey(liveState(["send"]), "r");
  assert.deepEqual(noRefresh.events, []);

  const withRefresh = liveState(["refresh"]);
  withRefresh.welcome.kind = "remote";
  const refreshed = applyKey(withRefresh, "r");
  assert.deepEqual(refreshed.events, [{ type: "action", name: "refresh" }]);

  // While composing, q composes.
  const typing = applyKey(inputState(["send", "refresh"]), "q").state;
  assert.equal(typing.input, "q");
  assert.equal(typing.detaching, false);
});

test("t toggles stream only when a secondary stream exists (command mode)", () => {
  const state = liveState(["kill"]);
  state.welcome.kind = "terminal";
  state.snap.secondaryText = "warn";
  const toggled = applyKey(state, "t").state;
  assert.equal(toggled.stream, "secondary");
  const untoggled = applyKey(toggled, "t").state;
  assert.equal(untoggled.stream, "main");

  const noSecondary = liveState();
  assert.equal(applyKey(noSecondary, "t").state.stream, "main");

  // Composing a literal t never toggles.
  const composing = applyKey(inputState(), "t").state;
  assert.equal(composing.stream, "main");
});

test("scrolling keys move the offset and g/G jump to top/bottom", () => {
  assert.equal(applyKey(liveState(), "up").state.scrollOffset, 4);
  assert.equal(applyKey(liveState(), "down").state.scrollOffset, 0);
  assert.equal(applyKey(liveState(), "G").state.scrollOffset, 0);
  assert.equal(
    applyKey(liveState(), "g").state.scrollOffset,
    Number.MAX_SAFE_INTEGER,
  );
});

// --- key classification ----------------------------------------------------------

test("classifyKey decodes arrows, pgup/pgdn, enter, ctrl-c, and esc", () => {
  const esc = { part: "" };
  assert.equal(classifyKey("\x1b", esc), undefined);
  assert.equal(classifyKey("[", esc), undefined);
  assert.equal(classifyKey("A", esc), "up");
  assert.equal(classifyKey("\x1b", esc), undefined);
  assert.equal(classifyKey("[", esc), undefined);
  assert.equal(classifyKey("5", esc), undefined);
  assert.equal(classifyKey("~", esc), "pgup");
  assert.equal(classifyKey("\r", esc), "enter");
  assert.equal(classifyKey("\x03", esc), "ctrl-c");
  assert.equal(classifyKey("\x7f", esc), "backspace");
  assert.equal(classifyKey("x", esc), "x");
  // Bare escape cancels.
  const esc2 = { part: "" };
  assert.equal(classifyKey("\x1b", esc2), undefined);
  assert.equal(classifyKey("x", esc2), "esc");
});

// --- rendering -------------------------------------------------------------------

test("buildLines shows header, content, and an input prompt when composing", () => {
  const lines = buildLines(inputState(), 60, 12);
  const joined = lines.join("\n");
  assert.match(joined, /\[subagent\] sa-1/);
  assert.match(joined, /running/);
  assert.match(joined, /line one/);
  assert.match(joined, /^> █/m);
  assert.equal(lines.length, 12);
});

test("buildLines command-mode footer lists enter-type instead of a prompt", () => {
  const lines = buildLines(liveState(), 60, 12);
  assert.match(lines.join("\n"), /i\/enter type/);
  assert.doesNotMatch(lines.join("\n"), /^> /m);
});

test("buildLines shows a notice line above the footer", () => {
  const state = { ...liveState(), notice: "send: text_too_long" };
  const lines = buildLines(state, 60, 12);
  assert.match(lines.join("\n"), /send: text_too_long/);
  assert.equal(lines.length, 12);
});

test("buildLines confirm overlay replaces the prompt line", () => {
  const state = applyKey(liveState(), "ctrl-c").state;
  const lines = buildLines(state, 60, 12);
  assert.match(lines.join("\n"), /Abort this subagent\?/);
  assert.doesNotMatch(lines.join("\n"), /^> /m);
});

test("buildLines read-only terminal shows hints, not an input line", () => {
  const state = liveState(["kill"]);
  state.welcome.kind = "terminal";
  const lines = buildLines(state, 60, 12);
  assert.match(lines.join("\n"), /q detach/);
  assert.match(lines.join("\n"), /ctrl\+c destructive/);
  assert.doesNotMatch(lines.join("\n"), /^> /m);
});

test("buildLines sanitizes target-controlled header fields", () => {
  const state = liveState();
  state.welcome.id = "sa-\x1b[31m1\x1b[0m";
  state.welcome.title = "\x1b[32mFix\x1b[0m parser";
  state.welcome.status = "run\x1b[3mning";
  const lines = buildLines(state, 60, 12);
  const joined = lines.join("\n");
  assert.equal(joined.includes("\x1b["), false);
  assert.match(joined, /sa-1/);
  assert.match(joined, /running/);
});

test("buildLines caps a huge transcript to the viewport", () => {
  const state = liveState();
  state.snap.text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join(
    "\n",
  );
  const lines = buildLines(state, 60, 12);
  assert.equal(lines.length, 12);
  // Scrolled up shows the marker; pinned shows the tail.
  const scrolled = applyKey(state, "up").state;
  assert.match(buildLines(scrolled, 60, 12).join("\n"), /wrapped lines above/);
});
