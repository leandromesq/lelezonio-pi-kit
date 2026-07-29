import * as fs from "node:fs";
import * as path from "node:path";
import type { RemoteAgentSnapshot } from "./domain.ts";

interface RegistryFile {
  readonly version: 1;
  readonly jobs: ReadonlyArray<RemoteAgentSnapshot>;
  readonly tombstones?: ReadonlyArray<{
    readonly id: string;
    readonly deletedAt: number;
  }>;
}

const sleepArray = new Int32Array(new SharedArrayBuffer(4));

export class RemoteJobStore {
  private readonly filePath: string;
  private readonly lockPath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
  }

  load() {
    if (!fs.existsSync(this.filePath)) return [];
    try {
      const registry = this.read();
      const deleted = new Map(
        registry.tombstones?.map((item) => [item.id, item.deletedAt]),
      );
      return registry.jobs.filter(
        (job) => (deleted.get(job.id) ?? -1) < (job.updatedAt ?? job.createdAt),
      );
    } catch {
      const quarantine = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.filePath, quarantine);
      } catch {
        // If another process already replaced/quarantined it, start clean.
      }
      return [];
    }
  }

  save(jobs: ReadonlyArray<RemoteAgentSnapshot>) {
    this.update((registry) => {
      const merged = new Map(registry.jobs.map((job) => [job.id, job]));
      const deleted = new Map(
        registry.tombstones?.map((item) => [item.id, item.deletedAt]),
      );
      for (const job of jobs) {
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
    const deletedAt = Date.now();
    this.update((registry) => {
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

  private update(change: (registry: RegistryFile) => RegistryFile) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const lock = this.acquireLock();
    try {
      let registry: RegistryFile = { version: 1, jobs: [] };
      try {
        if (fs.existsSync(this.filePath)) registry = this.read();
      } catch {
        // A corrupt prior registry must not block new durable state.
      }
      const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(change(registry), null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      fs.renameSync(temporary, this.filePath);
    } finally {
      fs.closeSync(lock);
      fs.rmSync(this.lockPath, { force: true });
    }
  }

  private read() {
    const parsed = JSON.parse(
      fs.readFileSync(this.filePath, "utf8"),
    ) as RegistryFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.jobs)) {
      throw new Error("unsupported registry format");
    }
    return parsed;
  }

  private acquireLock() {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        return fs.openSync(this.lockPath, "wx", 0o600);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "EEXIST"
        )
          throw error;
        try {
          const age = Date.now() - fs.statSync(this.lockPath).mtimeMs;
          if (age > 10_000) fs.rmSync(this.lockPath, { force: true });
        } catch {}
        Atomics.wait(sleepArray, 0, 0, 10);
      }
    }
    throw new Error("Timed out waiting for the remote job registry lock");
  }
}
