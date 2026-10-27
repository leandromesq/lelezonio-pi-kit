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
  openRemoteUiOnSpawn: false,
  terminalExecutable: "kitty",
  pollIntervalMs: 60_000,
  maxConcurrent: 3,
};

/** Minimal preflight used by every fake client; spawn tests do not inspect it. */
const preflight = async () => ({ cwd: "/remote" });

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
    preflight,
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
    preflight,
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
    assert.deepEqual(cleaned.closeFailures, []);
    assert.deepEqual(store.load(), []);
  } finally {
    manager.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a job whose host is unreachable can still be forgotten", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "remote-manager-unreachable-test-"),
  );
  const store = new RemoteJobStore(path.join(directory, "jobs.json"));
  store.save(
    ["ra-offline", "ra-settled"].map((id, index) => ({
      id,
      name: `pi-remote-${id}`,
      title: id,
      host: "macmini",
      localCwd: "C:/project",
      remoteCwd: "/remote/project",
      workspaceId: `w${index + 5}`,
      // Tracked as active: this is the state that made `d` a silent no-op,
      // because closing the workspace threw before the entry was dropped.
      status: (index === 0 ? "unreachable" : "done") as "unreachable" | "done",
      createdAt: index + 1,
      updatedAt: index + 1,
      transcript: "",
      transcriptVersion: 0,
      generation: 1,
    })),
  );
  const client = {
    preflight,
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
      throw new Error("ssh: connect to host macmini port 22: No route to host");
    },
  };
  const manager = new RemoteAgentManager(config, client, store);
  const warnings: string[] = [];
  manager.setOnWarning((message) => warnings.push(message));
  try {
    await manager.initialize();

    await manager.remove("ra-offline");
    assert.equal(manager.get("ra-offline"), undefined);
    assert.deepEqual(
      store.load().map((job) => job.id),
      ["ra-settled"],
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /removed locally/);
    assert.match(warnings[0]!, /No route to host/);

    const cleaned = await manager.cleanStale();
    assert.deepEqual(cleaned.removed, ["ra-settled"]);
    assert.deepEqual(
      cleaned.closeFailures.map((failure) => failure.id),
      ["ra-settled"],
    );
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
    preflight,
    async start(options: { name: string }) {
      current = agent(options.name, "idle", 10);
      return {
        workspaceId: "w3",
        paneId: "w3:p1",
        agent: current,
        prompted: { agent: current },
        promptDigest: "race-digest",
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
      if (!resultAvailable)
        return {
          text: "",
          sessionPath: "/remote/session.jsonl",
          status: "pending" as const,
          reason: "response-not-finalized",
        };
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
    const transcriptFallback = await manager.refresh(snapshot.id, {
      transcript: true,
    });
    // The session does not yet hold the anchored answer: stay pending instead
    // of accepting a terminal fallback as success.
    assert.equal(transcriptFallback.status, "working");
    assert.equal(transcriptFallback.finalText, undefined);

    resultAvailable = true;
    const finished = await manager.refresh(snapshot.id, { transcript: true });
    assert.equal(finished.status, "done");
    assert.equal(finished.finalText, "finished");
    manager.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** A client whose single tracked agent stays active across refreshes. */
function trackedClient() {
  let current: HerdrAgent | undefined;
  return {
    preflight,
    async start(options: { name: string }) {
      current = agent(options.name, "working");
      return {
        workspaceId: "w7",
        paneId: "w7:p1",
        agent: current,
        prompted: { agent: current },
      };
    },
    async list() {
      return current ? [current] : [];
    },
    async get() {
      return current!;
    },
    async read() {
      return "working";
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
      return { agent: current! };
    },
    async cancel() {},
    async close() {},
  };
}

test("manager does not rewrite the registry when a refresh changed nothing", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "remote-manager-dirty-test-"),
  );
  const filePath = path.join(directory, "jobs.json");
  try {
    const store = new RemoteJobStore(filePath);
    const manager = new RemoteAgentManager(config, trackedClient(), store);
    await manager.initialize();
    const snapshot = await manager.spawn({
      title: "dirty check",
      prompt: "work",
      localCwd: "C:/project",
      remoteCwd: "/remote/project",
    });
    await store.flush();
    const written = fs.readFileSync(filePath, "utf8");
    const writtenAt = fs.statSync(filePath).mtimeMs;

    // The tracked job is still active, so cleanStale() finds nothing to remove
    // and the persisted projection is identical to what is already on disk.
    const cleaned = await manager.cleanStale();
    assert.deepEqual(cleaned.removed, []);
    await store.flush();

    assert.equal(fs.readFileSync(filePath, "utf8"), written);
    assert.equal(fs.statSync(filePath).mtimeMs, writtenAt);

    // Sanity check: a real change does rewrite the file, so the assertion above
    // proves the skip instead of a filesystem timestamp artifact.
    manager.markCompletionDelivered(snapshot.id);
    await store.flush();
    assert.notEqual(fs.statSync(filePath).mtimeMs, writtenAt);
    manager.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("manager dispose flushes pending registry state synchronously", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "remote-manager-flush-test-"),
  );
  const filePath = path.join(directory, "jobs.json");
  try {
    // The debounce never fires, so only dispose can make the job durable.
    const store = new RemoteJobStore(filePath, { writeDebounceMs: 60_000 });
    const manager = new RemoteAgentManager(config, trackedClient(), store);
    await manager.initialize();
    const snapshot = await manager.spawn({
      title: "flush on dispose",
      prompt: "work",
      localCwd: "C:/project",
      remoteCwd: "/remote/project",
    });
    assert.equal(fs.existsSync(filePath), false);

    manager.dispose();

    const registry = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      jobs: Array<{ id: string; transcript: string }>;
    };
    assert.deepEqual(
      registry.jobs.map((job) => job.id),
      [snapshot.id],
    );
    assert.equal(registry.jobs[0].transcript, "");
    assert.deepEqual(
      store.load().map((job) => job.id),
      [snapshot.id],
    );
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
    preflight,
    async start(options: { name: string }) {
      startedName = options.name;
      return {
        workspaceId: "w2",
        paneId: "w2:p1",
        agent: agent(options.name, "idle"),
        prompted: { agent: agent(options.name, "working") },
        promptDigest: "initial-digest",
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
      return {
        agent: agent(startedName, currentStatus),
        promptDigest: "follow-up-digest",
      };
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

/** A client that reports one named agent as already settled with a result. */
function settledClient(id: string) {
  const name = `pi-remote-${id}`;
  return {
    preflight,
    async start() {
      throw new Error("not used");
    },
    async list() {
      return [agent(name, "done")];
    },
    async get() {
      return agent(name, "done");
    },
    async read() {
      return "tail";
    },
    async result() {
      return { text: "structured", sessionPath: "/remote/session.jsonl" };
    },
    async pathInfo() {
      return { exists: true, isGitRepository: true };
    },
    async cloneProject() {
      return { path: "/remote/project", output: "" };
    },
    async prompt() {
      return { agent: agent(name, "working") };
    },
    async cancel() {},
    async close() {},
  };
}

/** Seed a settled job directly into the registry, with optional ownership. */
function seedJob(
  store: RemoteJobStore,
  id: string,
  extra: Record<string, unknown> = {},
) {
  store.save([
    {
      id,
      name: `pi-remote-${id}`,
      title: id,
      host: "macmini",
      localCwd: "C:/project",
      remoteCwd: "/remote/project",
      workspaceId: "w2",
      paneId: "w2:p1",
      status: "done" as const,
      createdAt: 1,
      updatedAt: 2,
      settledAt: 2,
      transcript: "",
      transcriptVersion: 0,
      generation: 1,
      ...extra,
    },
  ]);
}

test("a session only delivers remote results for jobs it owns", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "remote-manager-ownership-test-"),
  );
  const filePath = path.join(directory, "jobs.json");
  const store = new RemoteJobStore(filePath);
  seedJob(store, "ra-owned", { ownerSessionId: "session-owner" });
  const client = settledClient("ra-owned");
  try {
    // A different session sharing the registry must not deliver the result.
    const other = new RemoteAgentManager(config, client, store, {
      sessionId: "session-other",
    });
    const otherSettled: string[] = [];
    other.setOnSettled((snapshot) => otherSettled.push(snapshot.id));
    await other.initialize();
    assert.deepEqual(otherSettled, []);
    other.dispose();

    // The owning session recovers the still-undelivered completion.
    const owner = new RemoteAgentManager(config, client, store, {
      sessionId: "session-owner",
    });
    const ownerSettled: string[] = [];
    owner.setOnSettled((snapshot) => ownerSettled.push(snapshot.id));
    await owner.initialize();
    assert.deepEqual(ownerSettled, ["ra-owned"]);
    owner.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a legacy job is preserved but delivered only after explicit adoption", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "remote-manager-legacy-test-"),
  );
  const store = new RemoteJobStore(path.join(directory, "jobs.json"));
  // No ownerSessionId: a job from before ownership existed.
  seedJob(store, "ra-legacy");
  const client = settledClient("ra-legacy");
  try {
    const manager = new RemoteAgentManager(config, client, store, {
      sessionId: "session-adopter",
    });
    const settled: string[] = [];
    manager.setOnSettled((snapshot) => settled.push(snapshot.id));
    await manager.initialize();
    // Preserved and inspectable, but never auto-delivered to an arbitrary
    // session.
    assert.equal(manager.get("ra-legacy")?.ownerSessionId, undefined);
    assert.deepEqual(settled, []);

    assert.equal(await manager.adopt("ra-legacy"), true);
    assert.equal(manager.get("ra-legacy")?.ownerSessionId, "session-adopter");
    await manager.refresh("ra-legacy", { transcript: true });
    assert.deepEqual(settled, ["ra-legacy"]);
    manager.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("adoption never steals a job owned by another session", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "remote-manager-steal-test-"),
  );
  const store = new RemoteJobStore(path.join(directory, "jobs.json"));
  seedJob(store, "ra-owned", { ownerSessionId: "session-a" });
  try {
    const manager = new RemoteAgentManager(
      config,
      settledClient("ra-owned"),
      store,
      {
        sessionId: "session-b",
      },
    );
    await manager.initialize();
    assert.equal(await manager.adopt("ra-owned"), false);
    assert.equal(manager.get("ra-owned")?.ownerSessionId, "session-a");
    manager.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a spawned job records its owning session", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "remote-manager-spawn-owner-test-"),
  );
  try {
    const manager = new RemoteAgentManager(
      config,
      trackedClient(),
      new RemoteJobStore(path.join(directory, "jobs.json")),
      { sessionId: "session-spawn" },
    );
    await manager.initialize();
    const snapshot = await manager.spawn({
      title: "owned",
      prompt: "work",
      localCwd: "C:/project",
      remoteCwd: "/remote/project",
    });
    assert.equal(snapshot.ownerSessionId, "session-spawn");
    manager.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("marking delivered never steals another session's delivery marker", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "remote-manager-marker-test-"),
  );
  const store = new RemoteJobStore(path.join(directory, "jobs.json"));
  seedJob(store, "ra-owned", { ownerSessionId: "session-a" });
  try {
    const manager = new RemoteAgentManager(
      config,
      settledClient("ra-owned"),
      store,
      { sessionId: "session-b" },
    );
    await manager.initialize();
    // Checking another session's job must not mark it delivered for this one.
    manager.markCompletionDelivered("ra-owned");
    manager.markBlockedDelivered("ra-owned");
    assert.equal(manager.get("ra-owned")?.completionDeliveredTo, undefined);
    await store.flush();
    const persisted = store.load().find((job) => job.id === "ra-owned");
    assert.equal(persisted?.completionDeliveredTo, undefined);
    assert.equal(persisted?.blockedDeliveredTo, undefined);
    manager.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

type ResultOutcome = {
  text: string;
  sessionPath: string;
  status?: "ok" | "error" | "aborted" | "pending" | "truncated";
  stopReason?: string;
  errorMessage?: string;
};

interface ClientScript {
  read?: () => string;
  result?: (anchor?: {
    promptDigest?: string;
    promptMarker?: string;
    promptCursor?: number;
  }) => ResultOutcome | Promise<ResultOutcome>;
  get?: (name: string) => HerdrAgent;
  list?: () => HerdrAgent[];
}

/**
 * Spawn-capable fake whose reads can fail on demand, so a busy terminal read
 * can be distinguished from a real SSH failure.
 */
function scriptedJobClient(script: ClientScript) {
  let promptCount = 0;
  const client = {
    preflight,
    script,
    currentStatus: "working" as HerdrAgentStatus,
    currentName: "",
    lastAnchor: undefined as
      | { promptDigest?: string; promptMarker?: string; promptCursor?: number }
      | undefined,
    async start(options: { name: string }) {
      client.currentName = options.name;
      client.currentStatus = "working";
      promptCount++;
      return {
        workspaceId: "w9",
        paneId: "w9:p1",
        agent: agent(options.name, "idle"),
        prompted: { agent: agent(options.name, "working") },
        promptDigest: `digest-${promptCount}`,
        promptMarker: `marker-${promptCount}`,
        promptCursor: 0,
      };
    },
    async list() {
      if (script.list) return script.list();
      return client.currentName
        ? [agent(client.currentName, client.currentStatus)]
        : [];
    },
    async get() {
      if (script.get) return script.get(client.currentName);
      return agent(client.currentName, client.currentStatus);
    },
    async read() {
      return script.read ? script.read() : "tail";
    },
    async result(
      _target: string,
      _signal?: AbortSignal,
      anchor?: {
        promptDigest?: string;
        promptMarker?: string;
        promptCursor?: number;
      },
    ) {
      client.lastAnchor = anchor;
      if (script.result) return script.result(anchor);
      return { text: "answer", sessionPath: "/remote/session.jsonl" };
    },
    async pathInfo() {
      return { exists: true, isGitRepository: true };
    },
    async cloneProject() {
      return { path: "/remote/project", output: "" };
    },
    async prompt() {
      client.currentStatus = "working";
      promptCount++;
      return {
        agent: agent(client.currentName, "working"),
        promptDigest: `digest-${promptCount}`,
        promptMarker: `marker-${promptCount}`,
        promptCursor: 0,
      };
    },
    async cancel() {},
    async close() {},
  };
  return client;
}

async function spawnScriptedJob(
  client: ReturnType<typeof scriptedJobClient>,
  directory: string,
) {
  const manager = new RemoteAgentManager(
    config,
    client,
    new RemoteJobStore(path.join(directory, "jobs.json")),
  );
  await manager.initialize();
  const snapshot = await manager.spawn({
    title: "scripted",
    prompt: "work",
    localCwd: "/local/project",
    remoteCwd: "/remote/project",
  });
  return { manager, id: snapshot.id };
}

test("a delayed result from an older generation cannot overwrite a follow-up", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "remote-manager-old-result-"),
  );
  let manager: RemoteAgentManager | undefined;
  let release!: (value: ResultOutcome) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const deferred = new Promise<ResultOutcome>((resolve) => {
    release = resolve;
  });
  try {
    const client = scriptedJobClient({
      result: () => {
        entered();
        return deferred;
      },
    });
    const spawned = await spawnScriptedJob(client, directory);
    manager = spawned.manager;
    client.currentStatus = "done";
    const oldRefresh = manager.refresh(spawned.id, { transcript: true });
    await started;
    await manager.send(spawned.id, "new request");
    release({
      text: "old answer",
      sessionPath: "/remote/session.jsonl",
      status: "ok",
    });
    await oldRefresh;
    assert.equal(manager.get(spawned.id)?.status, "working");
    assert.equal(manager.get(spawned.id)?.finalText, undefined);
    assert.equal(manager.get(spawned.id)?.promptMarker, "marker-2");
  } finally {
    manager?.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("wait does not settle before the current submission result is finalized", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "remote-manager-wait-pending-test-"),
  );
  let manager: RemoteAgentManager | undefined;
  try {
    let reads = 0;
    const client = scriptedJobClient({
      result: () => {
        reads++;
        return reads === 1
          ? {
              text: "",
              sessionPath: "/remote/session.jsonl",
              status: "pending",
            }
          : {
              text: "current answer",
              sessionPath: "/remote/session.jsonl",
              status: "ok",
            };
      },
    });
    const spawned = await spawnScriptedJob(client, directory);
    manager = spawned.manager;
    client.currentStatus = "done";
    const snapshot = await manager.wait(spawned.id);
    assert.equal(snapshot.status, "done");
    assert.equal(snapshot.finalText, "current answer");
    assert.equal(reads, 2);
    assert.notEqual(snapshot.completionDelivered, true);
  } finally {
    manager?.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a busy alternate-screen read is best-effort, not a health failure", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "remote-manager-busy-read-test-"),
  );
  try {
    const client = scriptedJobClient({
      read: () => {
        throw new Error(
          '{"error":{"code":"agent_not_idle","message":"agent is busy"}}',
        );
      },
      result: () => ({
        text: "current answer",
        sessionPath: "/remote/session.jsonl",
        status: "ok",
      }),
    });
    const { manager, id } = await spawnScriptedJob(client, directory);
    client.currentStatus = "done";
    const snapshot = await manager.refresh(id, { transcript: true });
    assert.equal(snapshot.status, "done");
    assert.equal(snapshot.errorText, undefined);
    assert.equal(snapshot.transcript, "");
    assert.equal(snapshot.finalText, "current answer");
    assert.deepEqual(client.lastAnchor, {
      promptDigest: "digest-1",
      promptMarker: "marker-1",
      promptCursor: 0,
    });
    manager.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a transcript transport failure is not masked as a healthy job", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "remote-manager-transcript-health-test-"),
  );
  try {
    const client = scriptedJobClient({
      read: () => {
        throw new Error("ssh: connect to host macmini port 22: Broken pipe");
      },
    });
    const { manager, id } = await spawnScriptedJob(client, directory);
    await assert.rejects(
      () => manager.refresh(id, { transcript: true }),
      /Broken pipe/,
    );
    const snapshot = manager.get(id)!;
    assert.equal(snapshot.status, "unreachable");
    assert.match(snapshot.errorText ?? "", /Broken pipe/);
    manager.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a true SSH failure still marks the job unreachable and rejects", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "remote-manager-ssh-failure-test-"),
  );
  try {
    const client = scriptedJobClient({});
    const { manager, id } = await spawnScriptedJob(client, directory);
    client.script.get = () => {
      throw new Error("ssh: connect to host macmini port 22: No route to host");
    };
    await assert.rejects(
      () => manager.refresh(id, { transcript: true }),
      /No route to host/,
    );
    const snapshot = manager.get(id)!;
    assert.equal(snapshot.status, "unreachable");
    assert.match(snapshot.errorText ?? "", /No route to host/);
    manager.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a follow-up prompt never reuses the previous answer as its result", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "remote-manager-stale-answer-test-"),
  );
  try {
    const client = scriptedJobClient({
      result: (anchor) => ({
        text:
          anchor?.promptDigest === "digest-1" ? "first answer" : "wrong run",
        sessionPath: "/remote/session.jsonl",
        status: "ok",
      }),
    });
    const { manager, id } = await spawnScriptedJob(client, directory);
    client.currentStatus = "done";
    assert.equal(
      (await manager.refresh(id, { transcript: true })).finalText,
      "first answer",
    );

    // The new generation accepted its prompt but the session file still holds
    // only the first answer: the helper reports pending, and the manager must
    // not fall back to success or the previous text.
    client.script.result = () => ({
      text: "",
      sessionPath: "/remote/session.jsonl",
      status: "pending",
      reason: "prompt-not-recorded",
    });
    await manager.send(id, "continue with the follow-up");
    assert.equal(manager.get(id)?.finalText, undefined);
    client.currentStatus = "done";
    const snapshot = await manager.refresh(id, { transcript: true });
    assert.equal(snapshot.status, "working");
    assert.equal(snapshot.settledAt, undefined);
    assert.equal(snapshot.finalText, undefined);
    assert.equal(snapshot.transcript, "tail");
    assert.deepEqual(client.lastAnchor, {
      promptDigest: "digest-2",
      promptMarker: "marker-2",
      promptCursor: 0,
    });
    manager.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("an unbound submission fails after the grace window instead of using the terminal fallback", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "remote-manager-pending-expired-test-"),
  );
  const store = new RemoteJobStore(path.join(directory, "jobs.json"));
  seedJob(store, "ra-pending", {
    status: "done",
    promptDigest: "pending-digest",
    promptCursor: 0,
    resultMissingSince: Date.now() - 200_000,
  });
  const client = scriptedJobClient({
    result: () => ({
      text: "",
      sessionPath: "/remote/session.jsonl",
      status: "pending",
      reason: "response-not-finalized",
    }),
  });
  client.currentStatus = "done";
  try {
    const manager = new RemoteAgentManager(config, client, store);
    await manager.initialize();
    const snapshot = await manager.refresh("ra-pending", { transcript: true });
    assert.equal(snapshot.status, "failed");
    assert.equal(snapshot.finalText, undefined);
    assert.match(snapshot.errorText ?? "", /bound assistant result/);
    manager.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a legacy pre-anchor job never claims an extracted result", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "remote-manager-legacy-anchor-test-"),
  );
  const store = new RemoteJobStore(path.join(directory, "jobs.json"));
  seedJob(store, "ra-legacy-anchor", { status: "done" });
  const client = scriptedJobClient({
    result: () => ({
      text: "possibly stale answer",
      sessionPath: "/remote/session.jsonl",
      status: "ok",
    }),
  });
  client.currentStatus = "done";
  try {
    const manager = new RemoteAgentManager(config, client, store);
    await manager.initialize();
    const snapshot = await manager.refresh("ra-legacy-anchor", {
      transcript: true,
    });
    assert.equal(snapshot.status, "done");
    assert.equal(snapshot.finalText, undefined);
    assert.equal(client.lastAnchor, undefined);
    manager.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a truncated response is a failure, not a successful result", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "remote-manager-truncated-test-"),
  );
  try {
    const client = scriptedJobClient({
      result: () => ({
        text: "half an answer",
        sessionPath: "/remote/session.jsonl",
        status: "truncated",
        stopReason: "length",
      }),
    });
    const { manager, id } = await spawnScriptedJob(client, directory);
    client.currentStatus = "done";
    const snapshot = await manager.refresh(id, { transcript: true });
    assert.equal(snapshot.status, "failed");
    assert.equal(snapshot.finalText, undefined);
    assert.match(snapshot.errorText ?? "", /truncated/);
    manager.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a structured-result transport failure marks the job unreachable", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "remote-manager-result-transport-test-"),
  );
  try {
    const client = scriptedJobClient({
      result: () => {
        throw new Error(
          "ssh: connect to host macmini port 22: No route to host",
        );
      },
    });
    const { manager, id } = await spawnScriptedJob(client, directory);
    client.currentStatus = "done";
    await assert.rejects(
      () => manager.refresh(id, { transcript: true }),
      /No route to host/,
    );
    assert.equal(manager.get(id)?.status, "unreachable");
    manager.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("failed and aborted responses are never accepted as successful results", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "remote-manager-failed-result-test-"),
  );
  try {
    const client = scriptedJobClient({
      result: () => ({
        text: "",
        sessionPath: "/remote/session.jsonl",
        status: "error",
        stopReason: "error",
        errorMessage: "provider unavailable",
      }),
    });
    const { manager, id } = await spawnScriptedJob(client, directory);
    client.currentStatus = "done";
    const failed = await manager.refresh(id, { transcript: true });
    assert.equal(failed.status, "failed");
    assert.equal(failed.finalText, undefined);
    assert.match(failed.errorText ?? "", /provider unavailable/);

    client.script.result = () => ({
      text: "partial answer",
      sessionPath: "/remote/session.jsonl",
      status: "aborted",
      stopReason: "aborted",
    });
    await manager.send(id, "try again");
    client.currentStatus = "done";
    const aborted = await manager.refresh(id, { transcript: true });
    assert.equal(aborted.status, "failed");
    assert.equal(aborted.finalText, undefined);
    assert.match(aborted.errorText ?? "", /aborted/);

    await manager.send(id, "try once more");
    client.currentStatus = "done";
    const cancelled = await manager.cancel(id);
    assert.equal(cancelled.status, "cancelled");
    manager.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a disconnect-marked job reconciles back to its live state", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "remote-manager-reconnect-test-"),
  );
  const store = new RemoteJobStore(path.join(directory, "jobs.json"));
  seedJob(store, "ra-offline", {
    status: "unreachable",
    promptDigest: "recovered-digest",
    promptCursor: 0,
  });
  const client = scriptedJobClient({
    list: () => [agent("pi-remote-ra-offline", "done")],
    result: () => ({
      text: "recovered answer",
      sessionPath: "/remote/session.jsonl",
      status: "ok",
    }),
  });
  client.currentStatus = "done";
  try {
    const manager = new RemoteAgentManager(config, client, store);
    const settled: string[] = [];
    manager.setOnSettled((snapshot) => settled.push(snapshot.id));
    await manager.initialize();
    assert.equal(manager.get("ra-offline")?.status, "done");
    assert.deepEqual(settled, ["ra-offline"]);
    const snapshot = await manager.refresh("ra-offline", { transcript: true });
    assert.equal(snapshot.finalText, "recovered answer");
    manager.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a job whose agent vanished after a reboot stays unknown without a completion", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "remote-manager-reboot-test-"),
  );
  const store = new RemoteJobStore(path.join(directory, "jobs.json"));
  seedJob(store, "ra-gone", { status: "working", settledAt: undefined });
  const client = scriptedJobClient({ list: () => [] });
  try {
    const manager = new RemoteAgentManager(config, client, store);
    const settled: string[] = [];
    manager.setOnSettled((snapshot) => settled.push(snapshot.id));
    await manager.initialize();
    assert.equal(manager.get("ra-gone")?.status, "unknown");
    assert.deepEqual(settled, []);
    manager.dispose();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
