import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const python =
  process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const helperDir = path.join(import.meta.dirname, "remote");
const posixOnly =
  process.platform === "win32"
    ? { skip: "Requires POSIX sh fixture executables" }
    : {};

interface SessionMessage {
  role: string;
  toolName?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
}

interface ExtractedResult {
  text: string;
  sessionPath: string;
  status: string;
  reason?: string;
  stopReason?: string;
  errorMessage?: string;
}

/** Run a snippet against the helper module in a fresh process, so the
 * module-level `HERDR`/`GIT` resolution sees the test environment. */
function runHelper(
  code: string,
  options: { input?: unknown; args?: string[]; env?: NodeJS.ProcessEnv } = {},
) {
  return execFileSync(python, ["-c", code, ...(options.args ?? [])], {
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONPATH: helperDir,
      ...options.env,
    },
    input:
      options.input === undefined ? undefined : JSON.stringify(options.input),
  });
}

function messageEntry(message: SessionMessage) {
  return { type: "message", message };
}

function writeSession(entries: unknown[]) {
  const directory = fs.mkdtempSync(
    path.join(os.homedir(), ".pi", "agent", "sessions", "remote-helper-test-"),
  );
  const sessionPath = path.join(directory, "session.jsonl");
  fs.writeFileSync(
    sessionPath,
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  return { directory, sessionPath };
}

function extract(
  sessionPath: string,
  anchor: { digest?: string; cursor?: number; marker?: string } = {},
): ExtractedResult {
  return JSON.parse(
    runHelper(
      [
        "import json, sys",
        "from helper import extract_session_result",
        "request = json.load(sys.stdin)",
        "print(json.dumps(extract_session_result(request['path'], request.get('digest'), request.get('cursor'), request.get('marker'))))",
      ].join("\n"),
      { input: { path: sessionPath, ...anchor } },
    ),
  ) as ExtractedResult;
}

function promptDigest(text: string) {
  return JSON.parse(
    runHelper(
      "from helper import prompt_digest; import json,sys; print(json.dumps(prompt_digest(json.load(sys.stdin)['text'])))",
      { input: { text } },
    ),
  ) as string;
}

function writeExecutable(filePath: string, lines: string[]) {
  fs.writeFileSync(filePath, lines.join("\n"));
  fs.chmodSync(filePath, 0o700);
}

test("remote helper returns the answer bound to the submitted prompt marker", () => {
  const { directory, sessionPath } = writeSession([
    { type: "session", version: 3 },
    messageEntry({ role: "user", content: "earlier prompt" }),
    messageEntry({
      role: "assistant",
      content: [{ type: "text", text: "older answer" }],
      stopReason: "stop",
    }),
    messageEntry({
      role: "user",
      content: "current prompt\n\n<!-- pi-remote-submission: current-mark -->",
    }),
    messageEntry({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "clean final result" },
      ],
      stopReason: "stop",
    }),
  ]);
  try {
    const result = extract(sessionPath, { marker: "current-mark" });
    assert.equal(result.text, "clean final result");
    assert.equal(result.status, "ok");
    assert.equal(result.stopReason, "stop");
    assert.equal(path.resolve(result.sessionPath), path.resolve(sessionPath));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a bound result excludes answers belonging to later user submissions", () => {
  const { directory, sessionPath } = writeSession([
    messageEntry({
      role: "user",
      content: "first <!-- pi-remote-submission: first-id -->",
    }),
    messageEntry({
      role: "assistant",
      content: "first answer",
      stopReason: "stop",
    }),
    messageEntry({
      role: "user",
      content: "second <!-- pi-remote-submission: second-id -->",
    }),
    messageEntry({
      role: "assistant",
      content: "second answer",
      stopReason: "stop",
    }),
  ]);
  try {
    assert.equal(
      extract(sessionPath, { marker: "first-id" }).text,
      "first answer",
    );
    assert.equal(
      extract(sessionPath, { marker: "second-id" }).text,
      "second answer",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a new prompt without a recorded answer never returns prior assistant text", () => {
  const { directory, sessionPath } = writeSession([
    { type: "session", version: 3 },
    messageEntry({ role: "user", content: "earlier prompt" }),
    messageEntry({
      role: "assistant",
      content: [{ type: "text", text: "older answer" }],
      stopReason: "stop",
    }),
    messageEntry({ role: "user", content: "current prompt" }),
  ]);
  try {
    const result = extract(sessionPath, {
      digest: promptDigest("current prompt"),
    });
    assert.equal(result.status, "pending");
    assert.equal(result.reason, "response-not-finalized");
    assert.equal(result.text, "");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a repeated prompt with a failed cursor probe never reuses the old answer", () => {
  const { directory, sessionPath } = writeSession([
    { type: "session", version: 3 },
    messageEntry({
      role: "user",
      content: "repeat\n\n<!-- pi-remote-submission: old-mark -->",
    }),
    messageEntry({
      role: "assistant",
      content: [{ type: "text", text: "old repeated answer" }],
      stopReason: "stop",
    }),
  ]);
  try {
    // The new generation sent the same text with a fresh marker while the
    // cursor probe failed (cursor undefined): the marker alone must keep the
    // old answer out of the new result.
    const result = extract(sessionPath, { marker: "fresh-mark" });
    assert.equal(result.status, "pending");
    assert.equal(result.reason, "prompt-not-recorded");
    assert.equal(result.text, "");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("without any anchor the helper refuses to guess a submission", () => {
  const { directory, sessionPath } = writeSession([
    { type: "session", version: 3 },
    messageEntry({ role: "user", content: "current prompt" }),
    messageEntry({
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      stopReason: "stop",
    }),
  ]);
  try {
    const result = extract(sessionPath);
    assert.equal(result.status, "pending");
    assert.equal(result.reason, "prompt-not-recorded");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("remote helper does not treat an unfinished tool turn as a result", () => {
  const { directory, sessionPath } = writeSession([
    { type: "session", version: 3 },
    messageEntry({ role: "user", content: "current prompt" }),
    messageEntry({
      role: "assistant",
      content: [{ type: "text", text: "I will run a command" }],
      stopReason: "toolUse",
    }),
    messageEntry({
      role: "toolResult",
      toolName: "bash",
      content: [{ type: "text", text: "output" }],
    }),
  ]);
  try {
    const result = extract(sessionPath, {
      digest: promptDigest("current prompt"),
    });
    assert.equal(result.status, "pending");
    assert.equal(result.reason, "response-not-finalized");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a toolUse turn waiting for input is pending, not a result", () => {
  const { directory, sessionPath } = writeSession([
    { type: "session", version: 3 },
    messageEntry({ role: "user", content: "current prompt" }),
    messageEntry({
      role: "assistant",
      content: [{ type: "text", text: "Which branch should I use?" }],
      stopReason: "toolUse",
    }),
  ]);
  try {
    const result = extract(sessionPath, {
      digest: promptDigest("current prompt"),
    });
    assert.equal(result.status, "pending");
    assert.equal(result.reason, "response-toolUse");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an output-token-limit response is truncated, not successful", () => {
  const { directory, sessionPath } = writeSession([
    { type: "session", version: 3 },
    messageEntry({ role: "user", content: "current prompt" }),
    messageEntry({
      role: "assistant",
      content: [{ type: "text", text: "half an answer" }],
      stopReason: "length",
    }),
  ]);
  try {
    const result = extract(sessionPath, {
      digest: promptDigest("current prompt"),
    });
    assert.equal(result.status, "truncated");
    assert.equal(result.stopReason, "length");
    assert.equal(result.text, "half an answer");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a deferred response is unfinished rather than successful", () => {
  const { directory, sessionPath } = writeSession([
    { type: "session", version: 3 },
    messageEntry({ role: "user", content: "current prompt" }),
    messageEntry({
      role: "assistant",
      content: [{ type: "text", text: "waiting on provider" }],
      stopReason: "deferred",
    }),
  ]);
  try {
    const result = extract(sessionPath, {
      digest: promptDigest("current prompt"),
    });
    assert.equal(result.status, "pending");
    assert.equal(result.reason, "response-deferred");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a legacy session without stopReason keeps its final text as the answer", () => {
  const { directory, sessionPath } = writeSession([
    { type: "session", version: 1 },
    messageEntry({ role: "user", content: "current prompt" }),
    messageEntry({
      role: "assistant",
      content: [{ type: "text", text: "legacy answer" }],
    }),
  ]);
  try {
    const result = extract(sessionPath, {
      digest: promptDigest("current prompt"),
    });
    assert.equal(result.status, "ok");
    assert.equal(result.text, "legacy answer");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("remote helper classifies a failed model response", () => {
  const { directory, sessionPath } = writeSession([
    { type: "session", version: 3 },
    messageEntry({ role: "user", content: "current prompt" }),
    messageEntry({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "provider unavailable",
    }),
  ]);
  try {
    const result = extract(sessionPath, {
      digest: promptDigest("current prompt"),
    });
    assert.equal(result.status, "error");
    assert.equal(result.stopReason, "error");
    assert.equal(result.errorMessage, "provider unavailable");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("remote helper classifies an aborted response and keeps partial text out of success", () => {
  const { directory, sessionPath } = writeSession([
    { type: "session", version: 3 },
    messageEntry({ role: "user", content: "current prompt" }),
    messageEntry({
      role: "assistant",
      content: [{ type: "text", text: "partial answer" }],
      stopReason: "aborted",
    }),
  ]);
  try {
    const result = extract(sessionPath, {
      digest: promptDigest("current prompt"),
    });
    assert.equal(result.status, "aborted");
    assert.equal(result.stopReason, "aborted");
    assert.equal(result.text, "partial answer");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("remote helper reports a session with no recorded prompt as pending", () => {
  const { directory, sessionPath } = writeSession([
    { type: "session", version: 3 },
    messageEntry({
      role: "assistant",
      content: [{ type: "text", text: "orphan answer" }],
      stopReason: "stop",
    }),
  ]);
  try {
    const result = extract(sessionPath, {
      digest: promptDigest("current prompt"),
    });
    assert.equal(result.status, "pending");
    assert.equal(result.reason, "prompt-not-recorded");
    assert.equal(result.text, "");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function readFixture(mode: "not-idle" | "not-found") {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "remote-helper-read-test-"),
  );
  const herdr = path.join(directory, "herdr");
  writeExecutable(herdr, [
    "#!/bin/sh",
    'case "$1" in',
    "  agent)",
    "    shift 2",
    '    source=""',
    "    while [ $# -gt 0 ]; do",
    '      case "$1" in',
    '        --source) source="$2"; shift 2;;',
    "        *) shift;;",
    "      esac",
    "    done",
    `    if [ "${mode}" = "not-idle" ] && [ "$source" = "recent-unwrapped" ]; then`,
    '      echo \'{"error":{"code":"agent_not_idle","message":"agent is busy"}}\' >&2',
    "      exit 1",
    "    fi",
    `    if [ "${mode}" = "not-found" ]; then`,
    '      echo \'{"error":{"code":"agent_not_found","message":"agent target x not found"}}\' >&2',
    "      exit 1",
    "    fi",
    `    echo "VISIBLE SCREEN"`,
    "    exit 0;;",
    "esac",
    'echo "unexpected herdr invocation" >&2',
    "exit 2",
  ]);
  return { directory, herdr };
}

function handleRequest(
  herdr: string,
  request: unknown,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  return JSON.parse(
    runHelper(
      [
        "import json, sys",
        "from helper import handle",
        "request = json.load(sys.stdin)",
        "try:",
        "    print(json.dumps({'ok': True, 'result': handle(request)}))",
        "except Exception as error:",
        "    print(json.dumps({'ok': False, 'error': str(error)}))",
      ].join("\n"),
      { input: request, env: { PI_REMOTE_HERDR: herdr, ...extraEnv } },
    ),
  ) as { ok: boolean; result?: Record<string, unknown>; error?: string };
}

test(
  "remote helper falls back to the visible screen only on agent_not_idle",
  posixOnly,
  () => {
    const fixture = readFixture("not-idle");
    try {
      const response = handleRequest(fixture.herdr, {
        action: "read",
        target: "agent",
        lines: 20,
      });
      assert.equal(response.ok, true);
      assert.equal(
        (response.result as { text: string }).text.trim(),
        "VISIBLE SCREEN",
      );
    } finally {
      fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
  },
);

test("remote helper does not mask a non-idle read failure", posixOnly, () => {
  const fixture = readFixture("not-found");
  try {
    const response = handleRequest(fixture.herdr, {
      action: "read",
      target: "agent",
      lines: 20,
    });
    assert.equal(response.ok, false);
    assert.match(response.error ?? "", /agent_not_found/);
  } finally {
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test(
  "a failed cursor probe still binds the prompt with a unique marker",
  posixOnly,
  () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "remote-helper-marker-test-"),
    );
    const log = path.join(directory, "prompt.log");
    const herdr = path.join(directory, "herdr");
    writeExecutable(herdr, [
      "#!/bin/sh",
      'case "$1 $2" in',
      // The pre-prompt cursor probe fails: the marker must still bind.
      '  "agent get")',
      '    echo \'{"error":{"code":"server_unavailable","message":"probe failed"}}\' >&2',
      "    exit 1;;",
      '  "agent prompt")',
      '    printf "%s" "$4" > "$FAKE_PROMPT_LOG"',
      '    echo \'{"agent":{"agent":"pi","agent_status":"working","cwd":"/remote","pane_id":"p","workspace_id":"w","state_change_seq":1}}\'',
      "    exit 0;;",
      "esac",
      "exit 2",
    ]);
    try {
      const response = handleRequest(
        herdr,
        { action: "prompt", target: "agent", text: "repeat this instruction" },
        { FAKE_PROMPT_LOG: log },
      );
      assert.equal(response.ok, true);
      const marker = response.result?.promptMarker as string;
      assert.match(marker, /^[0-9a-f]{32}$/);
      assert.equal(response.result?.promptCursor, null);
      const sent = fs.readFileSync(log, "utf8");
      assert.match(sent, /repeat this instruction/);
      assert.ok(sent.includes(`pi-remote-submission: ${marker}`));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "remote preflight reports resolved tools and server without env dump",
  posixOnly,
  () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "remote-helper-preflight-test-"),
    );
    const bin = path.join(directory, "bin");
    fs.mkdirSync(bin);
    const herdr = path.join(bin, "herdr");
    writeExecutable(herdr, [
      "#!/bin/sh",
      'case "$1" in',
      '  --version) echo "herdr 9.9.9"; exit 0;;',
      "  status)",
      '    echo "status: running"',
      '    echo "version: 9.9.9"',
      '    echo "private_protocol: 99"',
      '    echo "endpoint_compatible: yes"',
      "    exit 0;;",
      "esac",
      "exit 2",
    ]);
    const pi = path.join(bin, "pi");
    writeExecutable(pi, ["#!/bin/sh", 'echo "2.0.0"']);
    try {
      const report = JSON.parse(
        runHelper(
          "from helper import collect_preflight; import json; print(json.dumps(collect_preflight()))",
          {
            env: {
              PI_REMOTE_HERDR: herdr,
              PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
            },
          },
        ),
      ) as Record<string, unknown> & {
        cwd: string;
        python: { path: string; version: string };
        pi?: { path: string; version?: string };
        herdr?: { path: string; version?: string };
        server?: { running: boolean; version?: string; protocol?: string };
      };
      assert.equal(report.cwd, process.cwd());
      assert.match(report.python.version, /^\d+\.\d+/);
      assert.match(report.python.path, /python/);
      assert.equal(report.pi?.version, "2.0.0");
      assert.equal(report.pi?.path, fs.realpathSync(pi));
      assert.equal(report.herdr?.version, "9.9.9");
      assert.equal(report.herdr?.path, fs.realpathSync(herdr));
      assert.equal(report.server?.running, true);
      assert.equal(report.server?.version, "9.9.9");
      assert.equal(report.server?.protocol, "99");
      assert.doesNotMatch(JSON.stringify(report), /"env"/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
