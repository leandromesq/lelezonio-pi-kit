import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

const python =
  process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");

test("remote helper extracts the latest finalized assistant text", () => {
  const directory = fs.mkdtempSync(
    path.join(os.homedir(), ".pi", "agent", "sessions", "remote-helper-test-"),
  );
  const sessionPath = path.join(directory, "session.jsonl");
  try {
    const entries = [
      { type: "session", version: 3 },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "older" }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          content: [{ type: "text", text: "noise" }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: "clean final result" },
          ],
        },
      },
    ];
    fs.writeFileSync(
      sessionPath,
      entries.map((entry) => JSON.stringify(entry)).join("\n"),
    );
    const helperDir = path.join(import.meta.dirname, "remote");
    const output = execFileSync(
      python,
      [
        "-c",
        "from helper import extract_session_result; import json,sys; print(json.dumps(extract_session_result(sys.argv[1])))",
        sessionPath,
      ],
      { encoding: "utf8", env: { ...process.env, PYTHONPATH: helperDir } },
    );
    const result = JSON.parse(output) as { text: string; sessionPath: string };
    assert.equal(result.text, "clean final result");
    assert.equal(path.resolve(result.sessionPath), path.resolve(sessionPath));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
