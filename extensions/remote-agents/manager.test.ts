import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { RemoteAgentsConfig } from "./src/config.ts";
import type { HerdrAgent, HerdrAgentStatus } from "./src/herdr-client.ts";
import { RemoteAgentManager } from "./src/manager.ts";
import { RemoteJobStore } from "./src/persistence.ts";

function agent(
  name: string,
  status: HerdrAgentStatus,
  stateChangeSeq = status === "working" ? 1 : 2,
): HerdrAgent {
  return {
    agent: "pi",
    agent_status: status,
    cwd: "/remote/project",
    name,
    pane_id: "w2:p1",
    workspace_id: "w2",
    state_change_seq: stateChangeSeq,
    agent_session: { value: "/remote/session.jsonl" },
  };
}

const config: RemoteAgentsConfig = {
  host: "macmini",
  sshExecutable: "ssh",
  remoteHelper: "/tmp/helper.py",
  projectsRoot: "/remote/Projects",
  worktreesRoot: "/remote/Worktrees",
  pollIntervalMs: 60_000,
  maxConcurrent: 3,
};

test("manager redelivers an undelivered completion recovered after restart", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "remote-manager-recovery-test-"),
  );
  const store = new RemoteJobStore(path.join(directory, "jobs.json"));
  store.save([
    {
      id: "ra-recovered",
      name: "pi-remote-ra-recovered",
      title: "recovered",
      host: "macmini",
      localCwd: "C:/project",
      remoteCwd: "/remote/project",
      workspaceId: "w2",
      paneId: "w2:p1",
      status: "done",
      createdAt: 1,
      updatedAt: 2,
      settledAt: 2,
      transcript: "",
      transcriptVersion: 0,
      generation: 1,
      completionDelivered: false,
    },
  ]);
  const client = {
    async start() {
      throw new Error("not used");
    },
    async list() {
      return [agent("pi-remote-ra-recovered", "done")];
    },
    async get(name: string) {
      return agent(name, "done");
    },
    async read() {
      return "done";
    },
    async result() {
      return { text: "structured done", sessionPath: "/remote/session.jsonl" };
    },
    async pathInfo() {
      return { exists: true, isGitRepository: true };
    },
    async cloneProject() {
      return { path: "/remote/project", output: "" };
    },
    async prompt() {
      return { agent: agent("pi-remote-ra-recovered", "working") };
    },
    async cancel() {},
    async close() {},
  };
  try {
    const manager = new RemoteAgentManager(config, client, store);
    const settled: string[] = [];
    manager.setOnSettled((snapshot) => settled.push(snapshot.id));
    await manager.initialize();
    assert.deepEqual(settled, ["ra-recovered"]);
    manager.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("missing remote workspaces can still be forgotten and cleaned", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "remote-manager-missing-workspace-test-"),
  );
  const store = new RemoteJobStore(path.join(directory, "jobs.json"));
  const snapshots = ["ra-gone-one", "ra-gone-two"].map((id, index) => ({
    id,
    name: `pi-remote-${id}`,
    title: id,
    host: "macmini",
    localCwd: "C:/project",
    remoteCwd: "/remote/project",
    workspaceId: `w${index + 8}`,
    status: "done" as const,
    createdAt: index + 1,
    updatedAt: index + 1,
    settledAt: index + 1,
    transcript: "",
    transcriptVersion: 0,
    generation: 1,
    completionDelivered: true,
  }));
  store.save(snapshots);
  const client = {
    async start() {
      throw new Error("not used");
    },
    async list() {
      return [];
    },
    async get() {
      throw new Error("not used");
    },
    async read() {
      return "";
    },
    async result() {
      throw new Error("not used");
    },
    async pathInfo() {
      return { exists: true, isGitRepository: true };
    },
    async cloneProject() {
      return { path: "/remote/project", output: "" };
    },
    async prompt() {
      throw new Error("not used");
    },
    async cancel() {},
    async close() {
      throw new Error(
        '{"error":{"code":"workspace_not_found","message":"workspace not found"}}',
      );
    },
  };
  const manager = new RemoteAgentManager(config, client, store);
  try {
    await manager.initialize();
    await manager.remove("ra-gone-one");
    assert.equal(manager.get("ra-gone-one"), undefined);
    const cleaned = await manager.cleanStale();
    assert.deepEqual(cleaned.removed, ["ra-gone-two"]);
    assert.deepEqual(cleaned.failed, []);
    assert.deepEqual(store.load(), []);
  } finally {
    manager.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("manager does not settle on the unchanged idle state before a prompt starts", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "remote-manager-prompt-race-test-"),
  );
  let current = agent("", "idle", 10);
  let resultAvailable = false;
  const client = {
    async start(options: { name: string }) {
      current = agent(options.name, "idle", 10);
      return {
        workspaceId: "w3",
        paneId: "w3:p1",
        agent: current,
        prompted: { agent: current },
      };
    },
    async list() {
      return current.name ? [current] : [];
    },
    async get() {
      return current;
    },
    async read() {
      return "";
    },
    async result() {
      if (!resultAvailable) throw new Error("no result yet");
      return { text: "finished", sessionPath: "/remote/session.jsonl" };
    },
    async pathInfo() {
      return { exists: true, isGitRepository: true };
    },
    async cloneProject() {
      return { path: "/remote/project", output: "" };
    },
    async prompt() {
      return { agent: current };
    },
    async cancel() {},
    async close() {},
  };
  try {
    const manager = new RemoteAgentManager(
      config,
      client,
      new RemoteJobStore(path.join(directory, "jobs.json")),
    );
    const snapshot = await manager.spawn({
      title: "prompt race",
      prompt: "work",
      localCwd: "C:/project",
      remoteCwd: "/remote/project",
    });
    assert.equal(snapshot.status, "working");

    const unchanged = await manager.refresh(snapshot.id);
    assert.equal(unchanged.status, "working");

    current = agent(snapshot.name, "done", 11);
    const startupIdle = await manager.refresh(snapshot.id, {
      transcript: true,
    });
    assert.equal(startupIdle.status, "working");

    current = agent(snapshot.name, "working", 12);
    assert.equal((await manager.refresh(snapshot.id)).status, "working");
    current = agent(snapshot.name, "done", 13);
    resultAvailable = true;
    const finished = await manager.refresh(snapshot.id, { transcript: true });
    assert.equal(finished.status, "done");
    assert.equal(finished.finalText, "finished");
    manager.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("manager tracks settlement and never cancels remote work on dispose", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "remote-manager-test-"),
  );
  let currentStatus: HerdrAgentStatus = "working";
  let startedName = "";
  let cancelCalls = 0;
  let closeCalls = 0;
  const client = {
    async start(options: { name: string }) {
      startedName = options.name;
      return {
        workspaceId: "w2",
        paneId: "w2:p1",
        agent: agent(options.name, "idle"),
        prompted: { agent: agent(options.name, "working") },
      };
    },
    async list() {
      return startedName ? [agent(startedName, currentStatus)] : [];
    },
    async get(name: string) {
      return agent(name, currentStatus);
    },
    async read() {
      return "REMOTE_RESULT";
    },
    async result() {
      return {
        text: "STRUCTURED_RESULT",
        sessionPath: "/remote/session.jsonl",
      };
    },
    async pathInfo() {
      return { exists: true, isGitRepository: true };
    },
    async cloneProject() {
      return { path: "/remote/project", output: "" };
    },
    async prompt() {
      return { agent: agent(startedName, currentStatus) };
    },
    async cancel() {
      cancelCalls++;
    },
    async close() {
      closeCalls++;
    },
  };
  try {
    const store = new RemoteJobStore(path.join(directory, "jobs.json"));
    const manager = new RemoteAgentManager(config, client, store);
    const settled: string[] = [];
    const blocked: string[] = [];
    manager.setOnSettled((snapshot) => settled.push(snapshot.id));
    manager.setOnBlocked((snapshot) => blocked.push(snapshot.id));
    await manager.initialize();
    const snapshot = await manager.spawn({
      title: "test",
      prompt: "work",
      localCwd: "C:/project",
      remoteCwd: "/remote/project",
      projectRoot: "/remote/project",
      projectName: "project",
    });
    assert.equal(snapshot.status, "working");
    await assert.rejects(
      manager.spawn({
        title: "conflict",
        prompt: "work",
        localCwd: "C:/project",
        remoteCwd: "/remote/project",
        projectRoot: "/remote/project",
        projectName: "project",
      }),
      /already has an active remote agent/,
    );

    currentStatus = "done";
    const finished = await manager.refresh(snapshot.id, { transcript: true });
    assert.equal(finished.status, "done");
    assert.equal(finished.transcript, "REMOTE_RESULT");
    assert.equal(finished.finalText, "STRUCTURED_RESULT");
    assert.deepEqual(settled, [snapshot.id]);

    manager.markCompletionDelivered(snapshot.id);
    await manager.send(snapshot.id, "continue");
    currentStatus = "blocked";
    const waiting = await manager.refresh(snapshot.id, { transcript: true });
    assert.equal(waiting.status, "blocked");
    assert.equal(waiting.finalText, "STRUCTURED_RESULT");
    assert.deepEqual(blocked, [snapshot.id]);

    manager.markBlockedDelivered(snapshot.id);
    await manager.send(snapshot.id, "answer");
    currentStatus = "done";
    await manager.refresh(snapshot.id);
    assert.deepEqual(settled, [snapshot.id, snapshot.id]);

    const cleaned = await manager.cleanStale();
    assert.deepEqual(cleaned.removed, [snapshot.id]);
    assert.equal(manager.get(snapshot.id), undefined);
    assert.deepEqual(store.load(), []);
    assert.equal(closeCalls, 1);

    manager.dispose();
    assert.equal(cancelCalls, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
