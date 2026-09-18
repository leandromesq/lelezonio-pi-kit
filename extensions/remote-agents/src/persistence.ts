import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { RemoteAgentSnapshot } from "./domain.ts";

interface Tombstone {
  readonly id: string;
  readonly deletedAt: number;
}

interface RegistryFile {
  readonly version: 1;
  readonly jobs: ReadonlyArray<RemoteAgentSnapshot>;
  readonly tombstones?: ReadonlyArray<Tombstone>;
}

type RegistryChange = (registry: RegistryFile) => RegistryFile;

/**
 * Writes are coalesced and performed off the request path. A poll tick, a
 * dashboard refresh and a settlement can all land within the same window, and
 * the registry only needs the final state.
 */
const DEFAULT_WRITE_DEBOUNCE_MS = 250;
/** Tombstones only guard against writers that still hold a removed job. */
const DEFAULT_TOMBSTONE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TOMBSTONE_LIMIT = 500;
const LOCK_ATTEMPTS = 100;
const LOCK_RETRY_MS = 10;
const LOCK_STALE_MS = 10_000;

/** Only used by the synchronous teardown flush; never on a request path. */
const sleepArray = new Int32Array(new SharedArrayBuffer(4));

export interface RemoteJobStoreOptions {
  /** Window that coalesces bursts of mutations into one atomic write. */
  readonly writeDebounceMs?: number;
  /** Tombstones older than this are dropped when the registry is written. */
  readonly tombstoneMaxAgeMs?: number;
  /** Hard cap on retained tombstones, keeping the most recent ones. */
  readonly tombstoneLimit?: number;
  /** Injectable clock, for tests that age tombstones deterministically. */
  readonly now?: () => number;
}

function emptyRegistry(): RegistryFile {
  return { version: 1, jobs: [] };
}

function lockHeld(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function parseRegistry(raw: string | undefined): RegistryFile {
  if (raw === undefined) return emptyRegistry();
  const parsed = JSON.parse(raw) as RegistryFile;
  if (parsed.version !== 1 || !Array.isArray(parsed.jobs)) {
    throw new Error("unsupported registry format");
  }
  return parsed;
}

export class RemoteJobStore {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly debounceMs: number;
  private readonly tombstoneMaxAgeMs: number;
  private readonly tombstoneLimit: number;
  private readonly now: () => number;
  /**
   * Changes that are not on disk yet. Entries are only removed after a
   * successful write, so a failed write retries instead of losing state.
   */
  private pending: RegistryChange[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private chain: Promise<void> = Promise.resolve();
  /**
   * Bumped by every write attempt. A synchronous teardown flush supersedes an
   * asynchronous write that is still in flight.
   */
  private writeGeneration = 0;

  constructor(filePath: string, options: RemoteJobStoreOptions = {}) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.debounceMs = options.writeDebounceMs ?? DEFAULT_WRITE_DEBOUNCE_MS;
    this.tombstoneMaxAgeMs =
      options.tombstoneMaxAgeMs ?? DEFAULT_TOMBSTONE_MAX_AGE_MS;
    this.tombstoneLimit = options.tombstoneLimit ?? DEFAULT_TOMBSTONE_LIMIT;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Jobs that are not shadowed by a tombstone. In-process changes that have not
   * reached the disk yet are applied first, so this always observes the latest
   * local state.
   */
  load(): ReadonlyArray<RemoteAgentSnapshot> {
    let registry: RegistryFile;
    try {
      registry = this.read();
    } catch {
      this.quarantine();
      registry = emptyRegistry();
    }
    return this.visible(this.resolve(this.pending, registry));
  }

  /**
   * Cheap pre-flight check used to skip manager initialization (and its SSH
   * round-trips) when nothing is tracked. An unreadable or corrupt registry
   * reports true so real jobs are never silently ignored.
   */
  hasTrackedJobs(): boolean {
    try {
      if (!fs.existsSync(this.filePath)) return this.pending.length > 0;
      return this.visible(this.resolve(this.pending, this.read())).length > 0;
    } catch {
      return true;
    }
  }

  save(jobs: ReadonlyArray<RemoteAgentSnapshot>) {
    const snapshots = jobs.map((job) => ({ ...job }));
    this.enqueue((registry) => {
      const merged = new Map(registry.jobs.map((job) => [job.id, job]));
      const deleted = new Map(
        registry.tombstones?.map((item) => [item.id, item.deletedAt]),
      );
      for (const job of snapshots) {
        const changedAt = job.updatedAt ?? job.createdAt;
        if ((deleted.get(job.id) ?? -1) >= changedAt) continue;
        const current = merged.get(job.id);
        if (!current || changedAt >= (current.updatedAt ?? current.createdAt)) {
          merged.set(job.id, { ...job, transcript: "", transcriptVersion: 0 });
        }
      }
      return {
        version: 1,
        jobs: [...merged.values()],
        tombstones: registry.tombstones,
      };
    });
  }

  remove(ids: ReadonlyArray<string>) {
    if (ids.length === 0) return;
    const deletedAt = this.now();
    this.enqueue((registry) => {
      const removed = new Set(ids);
      const tombstones = new Map(
        registry.tombstones?.map((item) => [item.id, item.deletedAt]),
      );
      for (const id of ids) tombstones.set(id, deletedAt);
      return {
        version: 1,
        jobs: registry.jobs.filter((job) => !removed.has(job.id)),
        tombstones: [...tombstones].map(([id, time]) => ({
          id,
          deletedAt: time,
        })),
      };
    });
  }

  /** Force every pending change to disk and resolve when it is durable. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const next = this.chain.then(() => this.writePending());
    this.chain = next.catch(() => {});
    return next;
  }

  /**
   * Deterministic teardown flush. `dispose()` cannot await, and the process may
   * exit right after it, so the last state is written synchronously. The
   * request path never takes this route.
   */
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const applied = [...this.pending];
    if (applied.length === 0) return;
    this.writeGeneration++;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const release = this.acquireLockSync();
      try {
        this.writeSync(applied);
        this.commit(applied);
      } finally {
        release();
      }
    } catch (error) {
      console.error(
        "remote-agents: could not flush the remote job registry",
        error,
      );
    }
  }

  private enqueue(change: RegistryChange) {
    this.pending.push(change);
    this.schedule();
  }

  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.debounceMs);
    // Never hold the process (or a test runner) open for a background write.
    this.timer.unref?.();
  }

  private async writePending() {
    const applied = [...this.pending];
    if (applied.length === 0) return;
    const generation = ++this.writeGeneration;
    try {
      // Unsynchronized dirty check first: most flushes follow a change that
      // produced the state already on disk, and those must not touch the lock.
      const before = this.readRaw();
      if (this.serialize(applied, before) === before) {
        this.commit(applied);
        return;
      }
      await fs.promises.mkdir(path.dirname(this.filePath), {
        recursive: true,
      });
      const release = await this.acquireLock();
      try {
        const current = this.readRaw();
        const serialized = this.serialize(applied, current);
        // Another process may have written the same state while we waited.
        if (serialized !== current && generation === this.writeGeneration) {
          const temporary = `${this.filePath}.${process.pid}.${this.now()}.tmp`;
          await fs.promises.writeFile(temporary, serialized, {
            encoding: "utf8",
            mode: 0o600,
          });
          await fs.promises.rename(temporary, this.filePath);
        }
      } finally {
        await release();
      }
      this.commit(applied);
    } catch (error) {
      // A background write must never reject into a request path. The changes
      // stay pending, so the next flush (or teardown) retries them.
      console.error(
        "remote-agents: could not persist the remote job registry",
        error,
      );
    }
  }

  private writeSync(applied: ReadonlyArray<RegistryChange>) {
    const current = this.readRaw();
    const serialized = this.serialize(applied, current);
    if (serialized === current) return;
    const temporary = `${this.filePath}.${process.pid}.${this.now()}.tmp`;
    fs.writeFileSync(temporary, serialized, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, this.filePath);
  }

  /** Drop the changes a write just made durable, keeping newer ones pending. */
  private commit(applied: ReadonlyArray<RegistryChange>) {
    const written = new Set(applied);
    this.pending = this.pending.filter((change) => !written.has(change));
  }

  private resolve(
    changes: ReadonlyArray<RegistryChange>,
    registry: RegistryFile,
  ): RegistryFile {
    let next = registry;
    for (const change of changes) next = change(next);
    return this.pruneTombstones(next);
  }

  private serialize(
    changes: ReadonlyArray<RegistryChange>,
    raw: string | undefined,
  ) {
    let registry: RegistryFile;
    try {
      registry = parseRegistry(raw);
    } catch {
      // A corrupt prior registry must not block new durable state.
      registry = emptyRegistry();
    }
    return JSON.stringify(this.resolve(changes, registry), null, 2);
  }

  private visible(registry: RegistryFile) {
    const deleted = new Map(
      registry.tombstones?.map((item) => [item.id, item.deletedAt]),
    );
    return registry.jobs.filter(
      (job) => (deleted.get(job.id) ?? -1) < (job.updatedAt ?? job.createdAt),
    );
  }

  /** Bound registry growth: tombstones are only useful while they are recent. */
  private pruneTombstones(registry: RegistryFile): RegistryFile {
    const tombstones = registry.tombstones;
    if (!tombstones || tombstones.length === 0) return registry;
    const cutoff = this.now() - this.tombstoneMaxAgeMs;
    let kept = tombstones.filter((item) => item.deletedAt > cutoff);
    if (kept.length > this.tombstoneLimit)
      kept = kept.slice(kept.length - this.tombstoneLimit);
    if (kept.length === tombstones.length) return registry;
    return {
      version: 1,
      jobs: registry.jobs,
      tombstones: kept.length > 0 ? kept : undefined,
    };
  }

  private read(): RegistryFile {
    if (!fs.existsSync(this.filePath)) return emptyRegistry();
    return parseRegistry(fs.readFileSync(this.filePath, "utf8"));
  }

  private readRaw(): string | undefined {
    try {
      return fs.readFileSync(this.filePath, "utf8");
    } catch {
      return undefined;
    }
  }

  private quarantine() {
    const quarantine = `${this.filePath}.corrupt-${this.now()}`;
    try {
      fs.renameSync(this.filePath, quarantine);
    } catch {
      // If another process already replaced/quarantined it, start clean.
    }
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
      try {
        const handle = await fs.promises.open(this.lockPath, "wx", 0o600);
        return async () => {
          try {
            await handle.close();
          } catch {}
          this.releaseLock();
        };
      } catch (error) {
        if (!lockHeld(error)) throw error;
        await this.dropStaleLock();
        // Yield to the event loop instead of blocking it while another
        // process finishes its atomic registry write.
        await delay(LOCK_RETRY_MS);
      }
    }
    throw new Error("Timed out waiting for the remote job registry lock");
  }

  private acquireLockSync(): () => void {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
      try {
        const fd = fs.openSync(this.lockPath, "wx", 0o600);
        return () => {
          try {
            fs.closeSync(fd);
          } catch {}
          this.releaseLock();
        };
      } catch (error) {
        // Teardown must not drop the last state: on any lock problem (including
        // a timeout below) the atomic write proceeds without the lock.
        if (!lockHeld(error)) return () => {};
        try {
          const age = this.now() - fs.statSync(this.lockPath).mtimeMs;
          if (age > LOCK_STALE_MS) fs.rmSync(this.lockPath, { force: true });
        } catch {}
        Atomics.wait(sleepArray, 0, 0, LOCK_RETRY_MS);
      }
    }
    return () => {};
  }

  private releaseLock() {
    try {
      fs.rmSync(this.lockPath, { force: true });
    } catch {
      // A stale lock is reclaimed by the age check on the next write.
    }
  }

  private async dropStaleLock() {
    try {
      const stat = await fs.promises.stat(this.lockPath);
      if (this.now() - stat.mtimeMs > LOCK_STALE_MS)
        await fs.promises.rm(this.lockPath, { force: true });
    } catch {
      // The lock disappeared between the failed open and this check.
    }
  }
}
