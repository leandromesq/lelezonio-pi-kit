import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadRunEntries, buildTranscriptRows } from "./dashboard.ts";
import type { AgentRecord, Theme } from "./model.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function withAgentDir<T>(dir: string, fn: () => T): T {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

function writeRun(
  agentDir: string,
  runId: string,
  body: Record<string, unknown>,
  mtime: Date,
): string {
  const runDir = path.join(agentDir, "workflows", runId);
  fs.mkdirSync(runDir, { recursive: true });
  const workflowPath = path.join(runDir, "workflow.json");
  fs.writeFileSync(workflowPath, JSON.stringify(body), "utf8");
  fs.utimesSync(workflowPath, mtime, mtime);
  fs.utimesSync(runDir, mtime, mtime);
  return runDir;
}

test("loadRunEntries caches parsed runs by mtime and re-reads changed ones", () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-dashboard-"));
  try {
    withAgentDir(agentDir, () => {
      const runId = `wf_caching_${process.pid}_${Date.now()}`;
      writeRun(
        agentDir,
        runId,
        {
          sessionId: "session-1",
          name: "first",
          status: "completed",
          startedAt: 1,
          agents: [],
        },
        new Date("2020-01-01T00:00:00Z"),
      );

      const active = new Map();
      const first = loadRunEntries(active, "session-1", new Set());
      assert.equal(first.length, 1);
      const second = loadRunEntries(active, "session-1", new Set());
      // An unchanged run must reuse its parsed details, not re-read the disk.
      assert.equal(second[0].details, first[0].details);

      // A newer mtime must invalidate the cached parse.
      writeRun(
        agentDir,
        runId,
        {
          sessionId: "session-1",
          name: "second",
          status: "completed",
          startedAt: 2,
          agents: [],
        },
        new Date("2020-01-02T00:00:00Z"),
      );
      const third = loadRunEntries(active, "session-1", new Set());
      assert.equal(third[0].details.name, "second");

      // Session filtering (and referencedRunIds) still applies.
      assert.equal(
        loadRunEntries(active, "other-session", new Set()).length,
        0,
      );
      assert.equal(
        loadRunEntries(active, "other-session", new Set([runId])).length,
        1,
      );
    });
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("workflow transcript rows sanitize escapes, tabs and control chars", () => {
  const agent: AgentRecord = {
    index: 1,
    label: "agent-1",
    state: "done",
    startedAt: 0,
    preview: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0,
    },
    transcript: [
      { role: "assistant", text: "before \u001b[31mred\u001b[0m\tend" },
      { role: "tool", name: "bash\u001b]0;title\u0007", text: "ok\u0001done" },
    ],
  };

  const rows = buildTranscriptRows(agent, 40, theme);
  const joined = rows.join("\n");

  assert.doesNotMatch(joined, /\u001b/);
  assert.doesNotMatch(joined, /\t/);
  assert.match(joined, /before red {2}end/);
  assert.match(joined, /TOOL bash/);
  assert.match(joined, /okdone/);
});
