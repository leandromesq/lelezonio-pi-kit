/**
 * Unit tests for the Herdr-native subagent workers' pure surface: pi session
 * JSONL parsing, Codex rollout parsing, launch commands, session discovery
 * (codex rollout markers + cwd matching), and technical naming. No Herdr
 * server, no TUI, no Effect runtime — fixture files where needed.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { SpawnTask } from "./src/domain.ts";
import {
  CodexRolloutReader,
  PiSessionFileReader,
  cleanupWorkerLaunchSpec,
  codexPromptText,
  codexResumeLaunch,
  codexRunMarker,
  codexWorkerLaunch,
  findCodexRolloutFiles,
  piResumeLaunch,
  piWorkerLaunch,
  quotePaneArg,
  rolloutMatches,
  selectCodexRollout,
  stripCodexMarker,
  technicalAgentName,
  writeWorkerLaunchSpec,
} from "./src/backends/herdr-worker.ts";

const CWD = "C:\\work\\proj";

function task(overrides: Partial<SpawnTask> = {}): SpawnTask {
  return {
    logicalId: "sa-3",
    prompt: "Do the thing",
    title: "Refactor module",
    cwd: CWD,
    parent: {
      parentCwd: CWD,
      projectTrusted: true,
      parentSessionId: "019e16ea-bbb6-721d",
      inheritedThinkingLevel: "high",
    },
    ...overrides,
  } as SpawnTask;
}

// --- launch commands ----------------------------------------------------------------

test("piWorkerLaunch passes a private deterministic session and child exclusions, RAW argv", () => {
  const plan = piWorkerLaunch(task(), {
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    piCliPath: "C:\\pi\\cli.js",
    sessionDir: "C:\\subs\\sa-3",
    sessionId: "019f1234-0000-0000-0000-000000000000",
  });
  // RAW argv: quotes/spaces/unicode are the spec file's problem now, never
  // the pane command line's (the launcher spawns this verbatim).
  assert.deepEqual(plan.argv, [
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\pi\\cli.js",
    "--session-dir",
    "C:\\subs\\sa-3",
    "--session-id",
    "019f1234-0000-0000-0000-000000000000",
    "--name",
    "[sa-3 · pi] Refactor module",
    "--thinking",
    "high",
    "--approve",
    "--exclude-tools",
    "subagent_spawn,subagent_wait,subagent_cancel,subagent_check,subagent_list,workflow,ask_user",
  ]);
});

test("piWorkerLaunch omits model/thinking when unset and flips trust when untrusted", () => {
  const plan = piWorkerLaunch(
    task({
      model: "openai/gpt-5.4",
      parent: {
        ...task().parent,
        projectTrusted: false,
        inheritedThinkingLevel: undefined,
      },
    }),
    {
      nodePath: "node",
      piCliPath: "cli.js",
      sessionDir: "s",
      sessionId: "id",
    },
  );
  assert.ok(plan.argv.includes("--model"));
  assert.ok(plan.argv.includes("openai/gpt-5.4"));
  assert.ok(plan.argv.includes("--no-approve"));
  assert.ok(!plan.argv.includes("--thinking"));
});

test("piResumeLaunch preserves the FULL launch policy: session, model, thinking, exclusions, trust, name", () => {
  const argv = piResumeLaunch(
    task({
      model: "openai/gpt-5.4",
      parent: { ...task().parent, inheritedThinkingLevel: "high" },
    }),
    {
      nodePath: "node",
      piCliPath: "cli.js",
      sessionDir: "C:\\subs\\sa-3",
      sessionFilePath:
        "C:\\subs\\sa-3\\C--work--proj--\\2026-01-01T00-00-00_019f1234.jsonl",
    },
  );
  assert.ok(argv.includes("--session"));
  assert.ok(
    argv.includes(
      "C:\\subs\\sa-3\\C--work--proj--\\2026-01-01T00-00-00_019f1234.jsonl",
    ),
  );
  assert.ok(argv.includes("--session-dir"));
  assert.ok(argv.includes("--model"));
  assert.ok(argv.includes("openai/gpt-5.4"));
  assert.ok(argv.includes("--thinking"));
  assert.ok(argv.includes("high"));
  assert.ok(argv.includes("--exclude-tools"));
  assert.ok(argv.includes("--approve"));
  assert.ok(argv.includes("--name"));
  assert.ok(argv.includes("[sa-3 · pi] Refactor module"));
});

test("codexWorkerLaunch launches the TUI via the explicit node entrypoint", () => {
  const plan = codexWorkerLaunch(task({ model: "gpt-5.4" }), {
    nodePath: "node",
    codexCliPath: "codex.js",
  });
  assert.deepEqual(plan.argv, [
    "node",
    "codex.js",
    "--cd",
    CWD,
    "-s",
    "danger-full-access",
    "-a",
    "never",
    "-m",
    "gpt-5.4",
  ]);
  assert.equal(plan.marker, undefined); // marker is per-run, not per-launch
});

test("codexWorkerLaunch passes the initial prompt as final positional argv (regression)", () => {
  const prompt = "herdrsub_sa-3_a1b2c3 fix the bug";
  const plan = codexWorkerLaunch(task(), {
    nodePath: "node",
    codexCliPath: "codex.js",
    prompt,
  });
  // The marker-carrying prompt is the LAST argv token: the pane starts the
  // TUI with it at launch — nothing is typed into the pane afterwards.
  assert.equal(plan.argv.at(-1), prompt);
  assert.equal(plan.argv.length, 9);
  assert.deepEqual(plan.argv.slice(0, -1), [
    "node",
    "codex.js",
    "--cd",
    CWD,
    "-s",
    "danger-full-access",
    "-a",
    "never",
  ]);
});

test("codexWorkerLaunch includes the reasoning effort slug when set", () => {
  const plan = codexWorkerLaunch(task({ reasoningEffort: "high" }), {
    nodePath: "node",
    codexCliPath: "codex.js",
  });
  // Effort rides as a single -c config token with the slug double-quoted.
  assert.ok(
    plan.argv.includes("-c") &&
      plan.argv.includes('model_reasoning_effort="high"'),
    plan.argv.join(" "),
  );
});

test("codexResumeLaunch preserves cwd/model/reasoning effort/sandbox/approval", () => {
  const argv = codexResumeLaunch(
    task({ model: "gpt-5.4", reasoningEffort: "xhigh" }),
    {
      nodePath: "node",
      codexCliPath: "codex.js",
      sessionId: "019f1234-abc",
    },
  );
  assert.deepEqual(argv, [
    "node",
    "codex.js",
    "resume",
    "019f1234-abc",
    "--cd",
    CWD,
    "-s",
    "danger-full-access",
    "-a",
    "never",
    "-m",
    "gpt-5.4",
    "-c",
    'model_reasoning_effort="xhigh"',
  ]);
});

// --- pane-run token quoting -------------------------------------------------------

test("quotePaneArg follows pwsh semantics on Windows and POSIX semantics elsewhere", () => {
  // Safe bare tokens are never quoted.
  assert.equal(quotePaneArg("node", "win32"), "node");
  assert.equal(quotePaneArg("C:\\pi\\cli.js", "win32"), "C:\\pi\\cli.js");
  // Spaces (or unicode) force single quotes; pwsh doubles embedded quotes.
  assert.equal(
    quotePaneArg("C:\\Program Files\\nodejs\\node.exe", "win32"),
    "'C:\\Program Files\\nodejs\\node.exe'",
  );
  assert.equal(quotePaneArg("a'quoted'path", "win32"), "'a''quoted''path'");
  // POSIX sh needs close-escape-reopen for embedded quotes.
  assert.equal(
    quotePaneArg("C:\\Program Files\\nodejs\\node.exe", "linux"),
    "'C:\\Program Files\\nodejs\\node.exe'",
  );
  assert.equal(
    quotePaneArg("a'quoted'path", "linux"),
    "'a'\\''quoted'\\''path'",
  );
});

// --- launch spec writer -----------------------------------------------------------

test("writeWorkerLaunchSpec splits command=argv[0]/args=argv.slice(1) and the pane line carries the Windows call operator", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-spec-extra-"));
  const launcher = path.join(dir, "worker-launcher.mjs");
  const specDir = path.join(dir, "specs");
  const tricky = ["--name", "[spike · pi] native", "日本語", "a'b"];
  const { specPath, paneLaunch } = writeWorkerLaunchSpec(
    specDir,
    "w-1",
    launcher,
    process.execPath,
    tricky,
    "C:\\work\\proj",
  );
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  // The launcher spawns command=argv[0] with args=argv.slice(1) verbatim.
  assert.equal(spec.command, tricky[0]);
  assert.deepEqual(spec.args, tricky.slice(1), "raw argv is stored byte-exact");
  assert.equal(spec.cwd, "C:\\work\\proj");
  assert.equal(spec.env.PI_SUBAGENT, "1");
  // Windows prefixes the `&` call operator so the quoted node path executes
  // (without it the path parses as a string expression); POSIX executes a
  // quoted command path directly — the plain 3-token line.
  const core = [
    quotePaneArg(process.execPath),
    quotePaneArg(launcher),
    quotePaneArg(specPath),
  ];
  assert.deepEqual(
    [...paneLaunch],
    process.platform === "win32" ? ["&", ...core] : core,
  );
  cleanupWorkerLaunchSpec(specPath);
  assert.equal(fs.existsSync(specPath), false);
});

test("technicalAgentName is collision-safe across parent sessions", () => {
  assert.equal(
    technicalAgentName("019e16ea-bbb6-721d-bf6a-0efbbf4c74aa", "sa-3"),
    "p-019e16ea-sa-3",
  );
  assert.equal(technicalAgentName("", "btw-1"), "p-sess-btw-1");
  assert.match(
    technicalAgentName("019e16ea", "sa-3"),
    /^[a-z][a-z0-9_-]{0,31}$/,
  );
});

test("codexRunMarker is unique per logical id and prompt carries it", () => {
  const a = codexRunMarker("sa-3");
  const b = codexRunMarker("sa-3");
  assert.notEqual(a, b);
  assert.match(a, /^herdrsub_sa-3_[0-9a-f]{6}$/);
  assert.equal(codexPromptText(a, "read the files"), `${a} read the files`);
  assert.equal(stripCodexMarker(`${a} read the files`, a), "read the files");
  assert.equal(stripCodexMarker("plain text", a), "plain text");
});

// --- pi session parsing --------------------------------------------------------------

function piLine(id: string, body: Record<string, unknown>): string {
  return JSON.stringify({ type: "message", id, ...body });
}

test("pi reader translates a full run: user, tool cycle, terminal stop", () => {
  const reader = new PiSessionFileReader();
  const out = (raw: string) => reader.consume(raw).events;

  assert.deepEqual(
    reader.consume(JSON.stringify({ type: "session", id: "sess-1" })).state
      .sessionId,
    "sess-1",
  );

  // model change surfaces model metadata
  let events = reader.consume(
    JSON.stringify({
      type: "model_change",
      provider: "openai",
      modelId: "gpt-5.4",
    }),
  ).events;
  assert.deepEqual(events, [
    { _tag: "MetaChanged", meta: { modelLabel: "openai/gpt-5.4" } },
  ]);

  // user message
  events = out(
    piLine("u1", {
      message: { role: "user", content: [{ type: "text", text: "go" }] },
    }),
  );
  assert.deepEqual(events, [{ _tag: "UserMessage", text: "go" }]);

  // assistant message with a tool call
  events = out(
    piLine("a1", {
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          {
            type: "toolCall",
            id: "call_abc",
            name: "bash",
            arguments: { command: "ls" },
          },
        ],
      },
    }),
  );
  assert.deepEqual(events, [
    {
      _tag: "ToolStart",
      toolId: "call_abc",
      name: "bash",
      argsPreview: '{"command":"ls"}',
    },
    {
      _tag: "AssistantMessage",
      parts: [
        { type: "text", text: "checking" },
        {
          type: "toolCall",
          toolId: "call_abc",
          name: "bash",
          argsPreview: '{"command":"ls"}',
        },
      ],
    },
  ]);

  // tool result linked by the assistant call id (strips the |suffix)
  events = out(
    piLine("t1", {
      message: {
        role: "toolResult",
        toolCallId: "call_abc|fc_xyz",
        toolName: "bash",
        content: [{ type: "text", text: "src docs\npackage.json" }],
        isError: false,
      },
    }),
  );
  assert.deepEqual(events, [
    {
      _tag: "ToolEnd",
      toolId: "call_abc",
      name: "bash",
      isError: false,
      outputPreview: "src docs",
    },
  ]);

  // terminal assistant message completes the run — stopReason AND usage live
  // on the MESSAGE (the real session format), not the entry top level.
  const terminal = out(
    piLine("a2", {
      message: {
        role: "assistant",
        stopReason: "stop",
        usage: { totalTokens: 1234, input: 500, output: 734 },
        content: [{ type: "text", text: "done" }],
      },
    }),
  );
  assert.deepEqual(terminal, [
    { _tag: "AssistantMessage", parts: [{ type: "text", text: "done" }] },
    { _tag: "UsageChanged", tokens: 1234 },
  ]);
  assert.equal(reader.state.terminalStop, "stop");
  assert.equal(reader.state.finalText, "done");
});

test("pi reader usage: message.usage wins, component-sum fallback, legacy top-level", () => {
  // 1) message.usage.totalTokens is used directly.
  let reader = new PiSessionFileReader();
  reader.consume(
    piLine("a1", {
      message: {
        role: "assistant",
        usage: { totalTokens: 999 },
        content: [{ type: "text", text: "x" }],
      },
    }),
  );
  assert.equal(reader.state.usageTokens, 999);

  // 2) No native totalTokens: the component sum is computed.
  reader = new PiSessionFileReader();
  let events = reader.consume(
    piLine("a2", {
      message: {
        role: "assistant",
        usage: { input: 10, output: 20, cacheRead: 5, cacheWrite: 0 },
        content: [{ type: "text", text: "x" }],
      },
    }),
  ).events;
  assert.deepEqual(
    events.find((e) => e._tag === "UsageChanged"),
    { _tag: "UsageChanged", tokens: 35 },
  );

  // 3) Legacy top-level usage is still honored when the message has none.
  reader = new PiSessionFileReader();
  events = reader.consume(
    piLine("a3", {
      stopReason: "stop",
      usage: { totalTokens: 77 },
      message: { role: "assistant", content: [{ type: "text", text: "x" }] },
    }),
  ).events;
  assert.deepEqual(
    events.find((e) => e._tag === "UsageChanged"),
    { _tag: "UsageChanged", tokens: 77 },
  );

  // 4) All-zero usage emits nothing (compaction semantics).
  reader = new PiSessionFileReader();
  events = reader.consume(
    piLine("a4", {
      message: {
        role: "assistant",
        usage: { input: 0, output: 0 },
        content: [{ type: "text", text: "x" }],
      },
    }),
  ).events;
  assert.equal(
    events.some((e) => e._tag === "UsageChanged"),
    false,
  );
});

test("pi stopReason under the message settles the run (regression)", () => {
  // The real session JSONL carries stopReason on message.stopReason.
  const reader = new PiSessionFileReader();
  const events = reader.consume(
    piLine("a1", {
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "done" }],
      },
    }),
  ).events;
  assert.equal(reader.state.terminalStop, "stop");
  assert.equal(reader.state.finalText, "done");
  // The entry-level fallback still settles older session files.
  const legacy = new PiSessionFileReader();
  legacy.consume(
    piLine("a2", {
      stopReason: "aborted",
      message: { role: "assistant", content: [{ type: "text", text: "cut" }] },
    }),
  );
  assert.equal(legacy.state.terminalStop, "aborted");
});

test("pi reader marks error/aborted terminals and dedupes replay", () => {
  const reader = new PiSessionFileReader();
  reader.consume(
    piLine("e1", {
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "provider rejected",
        content: [{ type: "text", text: "oops" }],
      },
    }),
  );
  assert.equal(reader.state.terminalStop, "error");
  assert.equal(reader.state.errorMessage, "provider rejected");

  reader.resetRun();
  reader.consume(
    piLine("x1", {
      message: {
        role: "assistant",
        stopReason: "aborted",
        content: [{ type: "text", text: "cut" }],
      },
    }),
  );
  assert.equal(reader.state.terminalStop, "aborted");

  // Replaying the same line (compaction rewrite) emits nothing new.
  const before = reader.state.finalText;
  reader.consume(
    piLine("x1", {
      message: {
        role: "assistant",
        stopReason: "aborted",
        content: [{ type: "text", text: "cut" }],
      },
    }),
  );
  assert.equal(reader.state.finalText, before);
});

// --- codex rollout parsing --------------------------------------------------------------

const ROLLOUT_DIR = path.join(os.tmpdir(), `herdr-rollout-${process.pid}`);

function rollout(...entries: Array<Record<string, unknown>>): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

function sessionMeta(cwd: string, id = "019f-sess"): Record<string, unknown> {
  return { type: "session_meta", payload: { id, cwd } };
}

function eventMsg(payload: Record<string, unknown>): Record<string, unknown> {
  return { type: "event_msg", payload };
}

test.beforeEach(() => {
  fs.rmSync(ROLLOUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(ROLLOUT_DIR, { recursive: true });
});
test.afterEach(() => {
  fs.rmSync(ROLLOUT_DIR, { recursive: true, force: true });
});

test("codex reader translates a full task: user, tool cycle, final answer", () => {
  const reader = new CodexRolloutReader("herdrsub_sa-3_abc123");
  const line = (entry: Record<string, unknown>) =>
    reader.consume(JSON.stringify(entry));

  let parsed = line(sessionMeta(CWD));
  assert.equal(parsed.sessionId, "019f-sess");

  // The marked user message is the FIRST transcript entry — injected
  // pre-marker context is suppressed, so it must precede lifecycle events.
  parsed = line(
    eventMsg({
      type: "user_message",
      message: "herdrsub_sa-3_abc123 fix the bug",
    }),
  );
  assert.deepEqual(parsed.events, [
    { _tag: "UserMessage", text: "fix the bug" },
  ]);

  parsed = line(eventMsg({ type: "task_started", turn_id: "t1" }));
  assert.equal(parsed.taskStarted, "t1");

  parsed = line({
    type: "response_item",
    payload: {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "shell_command",
      arguments: '{"command":"rg bug"}',
    },
  });
  assert.deepEqual(parsed.events, [
    {
      _tag: "ToolStart",
      toolId: "call_1",
      name: "shell",
      argsPreview: "rg bug",
    },
  ]);

  parsed = line({
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: "call_1",
      output: "src/bug.ts:42\n",
      exit_code: 0,
    },
  });
  assert.deepEqual(parsed.events, [
    {
      _tag: "ToolEnd",
      toolId: "call_1",
      name: "shell",
      isError: false,
      outputPreview: "src/bug.ts:42",
    },
  ]);

  parsed = line(
    eventMsg({
      type: "agent_message",
      message: "found it",
      phase: "commentary",
    }),
  );
  assert.deepEqual(parsed.events, [
    { _tag: "AssistantMessage", parts: [{ type: "text", text: "found it" }] },
  ]);

  parsed = line(
    eventMsg({
      type: "agent_message",
      message: "Fixed the bug",
      phase: "final_answer",
    }),
  );
  parsed = line(
    eventMsg({
      type: "task_complete",
      turn_id: "t1",
      last_agent_message: "Fixed the bug",
    }),
  );
  assert.deepEqual(parsed.taskComplete, {
    turnId: "t1",
    lastAgentMessage: "Fixed the bug",
  });
});

test("codex reader emits usage and reasoning and handles turn_aborted", () => {
  const reader = new CodexRolloutReader("m");
  const line = (entry: Record<string, unknown>) =>
    reader.consume(JSON.stringify(entry));

  // Nothing flows until the marker user message binds replay to our run.
  line(eventMsg({ type: "user_message", message: "m do the thing" }));

  const usage = line(
    eventMsg({
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
        },
        model_context_window: 258400,
      },
    }),
  );
  assert.deepEqual(usage.events, [
    { _tag: "UsageChanged", tokens: 15, contextWindow: 258400 },
  ]);

  const reasoning = line({
    type: "response_item",
    payload: { type: "reasoning", summary: ["thinking hard"] },
  });
  assert.deepEqual(reasoning.events, [
    {
      _tag: "AssistantMessage",
      parts: [{ type: "thinking", text: "thinking hard" }],
    },
  ]);

  const aborted = line(eventMsg({ type: "turn_aborted", turn_id: "t9" }));
  assert.equal(aborted.turnAborted, "t9");
});

test("codex reader suppresses injected pre-marker user context (regression)", () => {
  const reader = new CodexRolloutReader("herdrsub_sa-3_marker01");
  const line = (entry: Record<string, unknown>) =>
    reader.consume(JSON.stringify(entry));

  // Codex writes injected AGENTS/environment context as role=user items
  // BEFORE our marked turn; they are runtime context, not transcript.
  assert.deepEqual(
    line(eventMsg({ type: "user_message", message: "[AGENTS] system rules" })),
    { events: [] },
  );
  assert.deepEqual(
    line({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "env context" }],
      },
    }),
    { events: [] },
  );
  // Lifecycle lines before the marker are ignored too.
  assert.deepEqual(line(eventMsg({ type: "task_started", turn_id: "t0" })), {
    events: [],
  });

  // The marked prompt opens the transcript...
  const prompt = line(
    eventMsg({
      type: "user_message",
      message: "herdrsub_sa-3_marker01 fix it",
    }),
  );
  assert.deepEqual(prompt.events, [{ _tag: "UserMessage", text: "fix it" }]);
  // ...and later plain user messages are real follow-up turns.
  assert.deepEqual(
    line(eventMsg({ type: "user_message", message: "follow up" })),
    {
      events: [{ _tag: "UserMessage", text: "follow up" }],
    },
  );
});

test("codex reader flushes open tools at task end and surfaces model from turn_context", () => {
  const reader = new CodexRolloutReader("m");
  const line = (entry: Record<string, unknown>) =>
    reader.consume(JSON.stringify(entry));

  line({ type: "turn_context", payload: { model: "gpt-5.5" } });
  assert.equal(reader.state.modelLabel, "gpt-5.5");

  line({
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      call_id: "call_x",
      name: "apply_patch",
      input: "*** Begin Patch",
    },
  });
  line(eventMsg({ type: "task_complete", turn_id: "t1" }));
  assert.equal(reader.consume("").events.length, 0); // no more output
});

// --- codex rollout discovery --------------------------------------------------------------

function writeRollout(name: string, content: string): string {
  const file = path.join(ROLLOUT_DIR, name);
  fs.writeFileSync(file, content, "utf8");
  return file;
}

test("rolloutMatches requires marker + cwd and select picks the newest", () => {
  const older = writeRollout(
    "older.jsonl",
    rollout(
      sessionMeta(CWD),
      eventMsg({ type: "user_message", message: "herdrsub_sa-3_111111 do a" }),
    ),
  );
  const newer = writeRollout(
    "newer.jsonl",
    rollout(
      sessionMeta(CWD),
      eventMsg({ type: "user_message", message: "herdrsub_sa-3_222222 do a" }),
    ),
  );
  writeRollout(
    "wrong-cwd.jsonl",
    rollout(
      sessionMeta("C:\\other"),
      eventMsg({ type: "user_message", message: "herdrsub_sa-3_333333 do a" }),
    ),
  );
  writeRollout(
    "no-marker.jsonl",
    rollout(
      sessionMeta(CWD),
      eventMsg({ type: "user_message", message: "plain task" }),
    ),
  );

  const all = findCodexRolloutFiles(ROLLOUT_DIR);
  assert.equal(all.length, 4);

  assert.equal(rolloutMatches(newer, CWD, "herdrsub_sa-3_222222"), true);
  assert.equal(rolloutMatches(newer, CWD, "herdrsub_sa-3_111111"), false);
  assert.equal(
    rolloutMatches(newer, "C:\\other", "herdrsub_sa-3_222222"),
    false,
  );

  const picked = selectCodexRollout(all, CWD, "herdrsub_sa-3_222222");
  assert.equal(picked, newer);
  // No candidate from a different marker/cwd.
  assert.equal(selectCodexRollout(all, CWD, "herdrsub_sa-3_nope"), undefined);

  // sessionId disambiguates further
  assert.equal(
    selectCodexRollout(all, CWD, "herdrsub_sa-3_222222", "019f-sess"),
    newer,
  );
});

test("codexRunMarker survives quoting/unicode prompts in the marker strip", () => {
  const marker = "herdrsub_sa-3_abcdef";
  const prompt = "explique ça – 日本語";
  assert.equal(stripCodexMarker(`${marker} ${prompt}`, marker), prompt);
  assert.equal(stripCodexMarker(`  ${marker} ${prompt}`, marker), prompt);
});

test("launch command surfaces the agreed title format (raw, unquoted)", () => {
  const plan = piWorkerLaunch(task({ profile: "reviewer" }), {
    nodePath: "node",
    piCliPath: "cli.js",
    sessionDir: "s",
    sessionId: "id",
  });
  assert.ok(plan.argv.includes("[sa-3 · reviewer] Refactor module"));
});
