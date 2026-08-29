import { randomBytes } from "node:crypto";
import type { RemoteAgentsConfig } from "./config.ts";
import type { RemoteAgentSnapshot, RemoteAgentStatus } from "./domain.ts";
import { isRemoteAgentActive } from "./domain.ts";
import type { HerdrAgent, HerdrClient } from "./herdr-client.ts";
import type { RemoteJobStore } from "./persistence.ts";

const TRANSCRIPT_MAX_CHARS = 256 * 1024;
const FINAL_TEXT_MAX_CHARS = 64 * 1024;
const RESULT_GRACE_MS = 120_000;

interface MutableSnapshot {
  id: string;
  name: string;
  title: string;
  host: string;
  localCwd: string;
  remoteCwd: string;
  projectRoot?: string;
  projectName?: string;
  workspaceId?: string;
  paneId?: string;
  sessionPath?: string;
  status: RemoteAgentStatus;
  createdAt: number;
  updatedAt: number;
  settledAt?: number;
  lastSeenAt?: number;
  errorText?: string;
  transcript: string;
  transcriptVersion: number;
  finalText?: string;
  generation: number;
  promptBaselineSeq?: number;
  promptObservedActivity?: boolean;
  resultMissingSince?: number;
  cancelRequested?: boolean;
  completionDelivered?: boolean;
  blockedDelivered?: boolean;
}

export interface RemoteAgentReadModel {
  list(): ReadonlyArray<RemoteAgentSnapshot>;
  get(id: string): RemoteAgentSnapshot | undefined;
  subscribe(listener: () => void): () => void;
  subscribeTo(id: string, listener: () => void): () => void;
  requestRefresh(id: string): void;
  requestSend(id: string, text: string): void;
  requestCancel(id: string): void;
  requestDelete(id: string): void;
}

export class RemoteAgentManager {
  private readonly jobs = new Map<string, MutableSnapshot>();
  private readonly listeners = new Set<() => void>();
  private readonly idListeners = new Map<string, Set<() => void>>();
  private readonly deliveryPending = new Set<string>();
  private readonly blockedPending = new Set<string>();
  private readonly waitInterest = new Map<string, number>();
  private pollTimer?: ReturnType<typeof setInterval>;
  private polling = false;
  private disposed = false;
  private onSettled?: (snapshot: RemoteAgentSnapshot) => void;
  private onBlocked?: (snapshot: RemoteAgentSnapshot) => void;
  private readonly config: RemoteAgentsConfig;
  private readonly client: Pick<
    HerdrClient,
    | "start"
    | "list"
    | "get"
    | "read"
    | "result"
    | "pathInfo"
    | "cloneProject"
    | "prompt"
    | "cancel"
    | "close"
  >;
  private readonly store: RemoteJobStore;

  readonly view: RemoteAgentReadModel = {
    list: () => this.list(),
    get: (id) => this.jobs.get(id),
    subscribe: (listener) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
    subscribeTo: (id, listener) => {
      const listeners = this.idListeners.get(id) ?? new Set();
      listeners.add(listener);
      this.idListeners.set(id, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) this.idListeners.delete(id);
      };
    },
    requestRefresh: (id) =>
      void this.refresh(id, { transcript: true }).catch(() => {}),
    requestSend: (id, text) => void this.send(id, text).catch(() => {}),
    requestCancel: (id) => void this.cancel(id).catch(() => {}),
    requestDelete: (id) => void this.remove(id).catch(() => {}),
  };

  constructor(
    config: RemoteAgentsConfig,
    client: Pick<
      HerdrClient,
      | "start"
      | "list"
      | "get"
      | "read"
      | "result"
      | "pathInfo"
      | "cloneProject"
      | "prompt"
      | "cancel"
      | "close"
    >,
    store: RemoteJobStore,
  ) {
    this.config = config;
    this.client = client;
    this.store = store;
    for (const snapshot of store.load())
      this.jobs.set(snapshot.id, {
        ...snapshot,
        updatedAt: snapshot.updatedAt ?? snapshot.createdAt,
        generation: snapshot.generation ?? 1,
      });
  }

  async initialize() {
    await this.reconcile().catch(() => {});
    if (!this.disposed) {
      this.pollTimer = setInterval(
        () => void this.poll(),
        this.config.pollIntervalMs,
      );
    }
  }

  setOnSettled(handler: ((snapshot: RemoteAgentSnapshot) => void) | undefined) {
    this.onSettled = handler;
  }

  setOnBlocked(handler: ((snapshot: RemoteAgentSnapshot) => void) | undefined) {
    this.onBlocked = handler;
  }

  list() {
    return [...this.jobs.values()].sort(
      (a, b) => b.createdAt - a.createdAt,
    ) as ReadonlyArray<RemoteAgentSnapshot>;
  }

  get(id: string) {
    return this.jobs.get(id) as RemoteAgentSnapshot | undefined;
  }

  pathInfo(remotePath: string, signal?: AbortSignal) {
    return this.client.pathInfo(remotePath, signal);
  }

  cloneProject(origin: string, destination: string, signal?: AbortSignal) {
    return this.client.cloneProject(
      { origin, projectsRoot: this.config.projectsRoot, destination },
      signal,
    );
  }

  async spawn(options: {
    title: string;
    prompt: string;
    localCwd: string;
    remoteCwd: string;
    projectRoot?: string;
    projectName?: string;
    signal?: AbortSignal;
  }) {
    if (this.disposed) throw new Error("Remote agent manager is shutting down");
    const active = this.list().filter((snapshot) =>
      isRemoteAgentActive(snapshot.status),
    ).length;
    if (active >= this.config.maxConcurrent) {
      throw new Error(
        `Max ${this.config.maxConcurrent} remote agents can run concurrently. Wait for one to finish before starting another.`,
      );
    }
    if (
      options.projectRoot &&
      this.list().some(
        (snapshot) =>
          snapshot.projectRoot === options.projectRoot &&
          isRemoteAgentActive(snapshot.status),
      )
    ) {
      throw new Error(
        `Project ${options.projectName ?? options.projectRoot} already has an active remote agent. Wait for it to settle before starting another writer.`,
      );
    }
    const id = `ra-${randomBytes(3).toString("hex")}`;
    const name = `pi-remote-${id}`;
    const snapshot: MutableSnapshot = {
      id,
      name,
      title: options.title.trim().slice(0, 80) || "remote task",
      host: this.config.host,
      localCwd: options.localCwd,
      remoteCwd: options.remoteCwd,
      projectRoot: options.projectRoot,
      projectName: options.projectName,
      status: "starting",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      transcript: "",
      transcriptVersion: 0,
      generation: 1,
    };
    this.jobs.set(id, snapshot);
    this.changed(id);
    try {
      const started = await this.client.start({
        name,
        cwd: options.remoteCwd,
        prompt: options.prompt,
        signal: options.signal,
      });
      snapshot.workspaceId = started.workspaceId;
      snapshot.paneId = started.paneId;
      snapshot.promptBaselineSeq = started.prompted.agent.state_change_seq;
      snapshot.promptObservedActivity =
        started.prompted.agent.agent_status === "working" ||
        started.prompted.agent.agent_status === "blocked" ||
        started.prompted.agent.agent_status === "done";
      this.applyAgent(snapshot, started.prompted.agent, false);
      this.deliveryPending.delete(id);
      // Herdr can return the unchanged pre-transition idle snapshot after
      // accepting a prompt. Keep that state working until its sequence changes.
      if (snapshot.status === "done") this.notifySettlement(snapshot);
      else if (snapshot.status === "blocked") this.notifyBlocked(snapshot);
      else {
        snapshot.status = "working";
        snapshot.settledAt = undefined;
      }
      this.changed(id);
      return snapshot as RemoteAgentSnapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // An interrupted local SSH wait does not prove the remote helper
      // stopped. Keep tracking by stable name so polling can recover it.
      const outcomeUnknown = /aborted|timed out|SSH exited/i.test(message);
      snapshot.status = outcomeUnknown ? "unknown" : "failed";
      snapshot.settledAt = outcomeUnknown ? undefined : Date.now();
      snapshot.errorText = message;
      this.changed(id);
      throw error;
    }
  }

  async refresh(
    id: string,
    options: { transcript?: boolean; signal?: AbortSignal } = {},
  ) {
    const snapshot = this.require(id);
    try {
      const agent = await this.client.get(snapshot.name, options.signal);
      this.applyAgent(snapshot, agent);
      if (options.transcript) {
        const transcript = await this.client.read(
          snapshot.name,
          400,
          options.signal,
        );
        snapshot.transcript = transcript.slice(-TRANSCRIPT_MAX_CHARS);
        snapshot.transcriptVersion++;
        if (snapshot.status === "done" || snapshot.status === "blocked") {
          const structured = await this.client
            .result(snapshot.name, options.signal)
            .catch(() => undefined);
          if (structured?.text) {
            snapshot.finalText = structured.text.slice(-FINAL_TEXT_MAX_CHARS);
            snapshot.sessionPath = structured.sessionPath;
            snapshot.resultMissingSince = undefined;
          } else if (
            snapshot.status === "done" &&
            !snapshot.promptObservedActivity
          ) {
            snapshot.resultMissingSince ??= Date.now();
            if (Date.now() - snapshot.resultMissingSince < RESULT_GRACE_MS) {
              // Pi can briefly appear idle/done while its startup prompt is
              // still queued. Once activity was observed, Herdr's settled
              // state is authoritative even when it omits agent_session.
              snapshot.status = "working";
              snapshot.settledAt = undefined;
            } else {
              snapshot.status = "failed";
              snapshot.errorText =
                "Remote agent settled without producing an assistant result";
            }
          } else {
            // Herdr versions that do not expose agent_session cannot provide a
            // structured result. Keep the settled state and use the captured
            // terminal transcript as the completion fallback.
            snapshot.resultMissingSince = undefined;
          }
        }
      }
      this.changed(id);
      return snapshot as RemoteAgentSnapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("agent_not_found")) {
        const wasActive = isRemoteAgentActive(snapshot.status);
        snapshot.status = "failed";
        snapshot.settledAt ??= Date.now();
        snapshot.errorText = "Remote Herdr agent no longer exists";
        if (wasActive) this.notifySettlement(snapshot);
        this.changed(id);
        return snapshot as RemoteAgentSnapshot;
      }
      if (isRemoteAgentActive(snapshot.status)) {
        snapshot.status = "unreachable";
        snapshot.errorText = message;
        this.changed(id);
      }
      throw error;
    }
  }

  async send(id: string, text: string, signal?: AbortSignal) {
    const snapshot = this.require(id);
    if (!text.trim()) throw new Error("Follow-up message must not be empty");
    const prompted = await this.client.prompt(snapshot.name, text, signal);
    snapshot.promptBaselineSeq = prompted.agent.state_change_seq;
    snapshot.promptObservedActivity =
      prompted.agent.agent_status === "working" ||
      prompted.agent.agent_status === "blocked" ||
      prompted.agent.agent_status === "done";
    snapshot.status = "working";
    snapshot.settledAt = undefined;
    snapshot.errorText = undefined;
    snapshot.finalText = undefined;
    snapshot.resultMissingSince = undefined;
    snapshot.cancelRequested = false;
    snapshot.completionDelivered = false;
    snapshot.blockedDelivered = false;
    snapshot.generation++;
    this.deliveryPending.delete(id);
    this.blockedPending.delete(id);
    this.changed(id);
  }

  async cancel(id: string, signal?: AbortSignal) {
    const snapshot = this.require(id);
    if (!isRemoteAgentActive(snapshot.status))
      return snapshot as RemoteAgentSnapshot;
    snapshot.cancelRequested = true;
    await this.client.cancel(snapshot.name, signal);
    this.changed(id);
    return this.refresh(id, { transcript: true, signal }).catch(
      () => snapshot as RemoteAgentSnapshot,
    );
  }

  async wait(id: string, signal?: AbortSignal) {
    this.addWaitInterest(id);
    try {
      while (true) {
        const snapshot = await this.refresh(id, { transcript: false, signal });
        if (
          snapshot.status === "blocked" ||
          !isRemoteAgentActive(snapshot.status)
        )
          return this.refresh(id, { transcript: true, signal });
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(new Error("Remote wait was aborted"));
          };
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
          }, 1_500);
          signal?.addEventListener("abort", abort, { once: true });
        });
      }
    } finally {
      this.releaseWaitInterest(id);
    }
  }

  markCompletionDelivered(id: string) {
    const snapshot = this.jobs.get(id);
    if (!snapshot) return;
    snapshot.completionDelivered = true;
    this.deliveryPending.delete(id);
    this.changed(id);
  }

  releaseCompletionDelivery(id: string) {
    this.deliveryPending.delete(id);
  }

  markBlockedDelivered(id: string) {
    const snapshot = this.jobs.get(id);
    if (!snapshot) return;
    snapshot.blockedDelivered = true;
    this.blockedPending.delete(id);
    this.changed(id);
  }

  releaseBlockedDelivery(id: string) {
    this.blockedPending.delete(id);
  }

  async remove(id: string, signal?: AbortSignal) {
    const snapshot = this.require(id);
    await this.closeWorkspace(snapshot, signal);
    this.jobs.delete(id);
    this.deliveryPending.delete(id);
    this.blockedPending.delete(id);
    this.store.remove([id]);
    this.changed();
  }

  async cleanStale(signal?: AbortSignal) {
    const stale = this.list().filter(
      (snapshot) => !isRemoteAgentActive(snapshot.status),
    );
    const removed: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const snapshot of stale) {
      try {
        await this.closeWorkspace(snapshot, signal);
        this.jobs.delete(snapshot.id);
        removed.push(snapshot.id);
      } catch (error) {
        failed.push({
          id: snapshot.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.store.remove(removed);
    this.changed();
    return { removed, failed };
  }

  private async closeWorkspace(
    snapshot: RemoteAgentSnapshot,
    signal?: AbortSignal,
  ) {
    if (!snapshot.workspaceId) return;
    try {
      await this.client.close(snapshot.workspaceId, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("workspace_not_found")) throw error;
      // Closing is idempotent: a workspace removed directly through Herdr is
      // already in the desired state and its local registry entry can go.
    }
  }

  dispose() {
    if (this.disposed) return;
    this.store.save(this.list());
    this.disposed = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.listeners.clear();
    this.idListeners.clear();
  }

  private require(id: string) {
    const snapshot = this.jobs.get(id);
    if (!snapshot)
      throw new Error(
        `Unknown remote agent id "${id}". Known: ${[...this.jobs.keys()].join(", ") || "none"}.`,
      );
    return snapshot;
  }

  private status(
    agent: HerdrAgent,
    snapshot: MutableSnapshot,
  ): RemoteAgentStatus {
    if (
      snapshot.cancelRequested &&
      (agent.agent_status === "idle" || agent.agent_status === "done")
    )
      return "cancelled";
    switch (agent.agent_status) {
      case "working":
        snapshot.promptObservedActivity = true;
        return "working";
      case "blocked":
        snapshot.promptObservedActivity = true;
        return "blocked";
      case "idle":
      case "done":
        if (
          snapshot.promptBaselineSeq !== undefined &&
          !snapshot.promptObservedActivity &&
          agent.state_change_seq <= snapshot.promptBaselineSeq
        )
          return "working";
        return "done";
      default:
        return "unknown";
    }
  }

  private applyAgent(
    snapshot: MutableSnapshot,
    agent: HerdrAgent,
    notify = true,
  ) {
    const previousStatus = snapshot.status;
    const nextStatus = this.status(agent, snapshot);
    snapshot.status = nextStatus;
    if (previousStatus === "blocked" && nextStatus !== "blocked") {
      snapshot.blockedDelivered = false;
      this.blockedPending.delete(snapshot.id);
    }
    snapshot.workspaceId = agent.workspace_id;
    snapshot.paneId = agent.pane_id;
    snapshot.sessionPath = agent.agent_session?.value;
    snapshot.lastSeenAt = Date.now();
    snapshot.updatedAt = Date.now();
    snapshot.errorText = undefined;
    if (isRemoteAgentActive(nextStatus)) {
      snapshot.settledAt = undefined;
      if (nextStatus === "working" || nextStatus === "blocked")
        snapshot.resultMissingSince = undefined;
    } else snapshot.settledAt ??= Date.now();
    if (notify && !isRemoteAgentActive(nextStatus))
      this.notifySettlement(snapshot);
    if (notify && nextStatus === "blocked" && previousStatus !== "blocked")
      this.notifyBlocked(snapshot);
  }

  private notifyBlocked(snapshot: MutableSnapshot) {
    if (
      snapshot.blockedDelivered ||
      this.blockedPending.has(snapshot.id) ||
      (this.waitInterest.get(snapshot.id) ?? 0) > 0
    ) {
      return;
    }
    this.blockedPending.add(snapshot.id);
    try {
      this.onBlocked?.(snapshot);
    } catch {
      this.blockedPending.delete(snapshot.id);
    }
  }

  private notifySettlement(snapshot: MutableSnapshot) {
    if (
      snapshot.completionDelivered ||
      this.deliveryPending.has(snapshot.id) ||
      (this.waitInterest.get(snapshot.id) ?? 0) > 0
    ) {
      return;
    }
    this.deliveryPending.add(snapshot.id);
    try {
      this.onSettled?.(snapshot);
    } catch {
      this.deliveryPending.delete(snapshot.id);
    }
  }

  private addWaitInterest(id: string) {
    this.waitInterest.set(id, (this.waitInterest.get(id) ?? 0) + 1);
  }

  private releaseWaitInterest(id: string) {
    const count = (this.waitInterest.get(id) ?? 1) - 1;
    if (count <= 0) this.waitInterest.delete(id);
    else this.waitInterest.set(id, count);
  }

  private async reconcile() {
    const agents = await this.client.list();
    const byName = new Map(
      agents.filter((agent) => agent.name).map((agent) => [agent.name!, agent]),
    );
    for (const snapshot of this.jobs.values()) {
      const agent = byName.get(snapshot.name);
      if (agent) this.applyAgent(snapshot, agent);
      else if (isRemoteAgentActive(snapshot.status)) {
        snapshot.status = "unknown";
        snapshot.updatedAt = Date.now();
      }
      if (!isRemoteAgentActive(snapshot.status))
        this.notifySettlement(snapshot);
      else if (snapshot.status === "blocked") this.notifyBlocked(snapshot);
    }
    this.changed();
  }

  private async poll() {
    if (this.polling || this.disposed) return;
    this.polling = true;
    try {
      const active = this.list().filter((snapshot) =>
        isRemoteAgentActive(snapshot.status),
      );
      await Promise.allSettled(
        active.map((snapshot) => this.refresh(snapshot.id)),
      );
    } finally {
      this.polling = false;
    }
  }

  private changed(id?: string) {
    if (this.disposed) return;
    if (id) {
      const snapshot = this.jobs.get(id);
      if (snapshot) snapshot.updatedAt = Date.now();
    }
    this.persist();
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {}
    }
    if (id) {
      for (const listener of this.idListeners.get(id) ?? []) {
        try {
          listener();
        } catch {}
      }
    }
  }

  private persist() {
    if (!this.disposed) this.store.save(this.list());
  }
}
