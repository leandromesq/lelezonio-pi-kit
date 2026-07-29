import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { RemoteAgentsConfig } from "./config.ts";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

interface ExecuteOptions {
  readonly input?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export class SshTransport {
  private helperReady?: Promise<void>;
  private readonly config: RemoteAgentsConfig;

  constructor(config: RemoteAgentsConfig) {
    this.config = config;
  }

  private execute(remoteCommand: string, options: ExecuteOptions = {}) {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(
        this.config.sshExecutable,
        [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=10",
          this.config.host,
          remoteCommand,
        ],
        { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let totalOutput = 0;
      let settled = false;
      let timedOut = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        callback();
      };
      const abort = () => child.kill();
      const timeoutMs = options.timeoutMs ?? 30_000;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        totalOutput += chunk.length;
        if (totalOutput > MAX_OUTPUT_BYTES) {
          child.kill();
          finish(() => reject(new Error("SSH output exceeded 4 MiB")));
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      // ssh can exit while a prompt is still flushing. Without an error
      // listener, the resulting EPIPE/EOF would become an uncaught exception.
      child.stdin.on("error", () => {});
      child.on("error", (error) => finish(() => reject(error)));
      child.on("close", (code) => {
        finish(() => {
          if (options.signal?.aborted)
            reject(new Error("SSH operation was aborted"));
          else if (timedOut)
            reject(new Error(`SSH operation timed out after ${timeoutMs}ms`));
          else if (code !== 0)
            reject(
              new Error(
                Buffer.concat(stderr).toString("utf8").trim() ||
                  `SSH exited ${code}`,
              ),
            );
          else resolve(Buffer.concat(stdout).toString("utf8"));
        });
      });
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });
      child.stdin.end(options.input ?? "");
    });
  }

  ensureHelper() {
    this.helperReady ??= this.installHelper().catch((error) => {
      this.helperReady = undefined;
      throw error;
    });
    return this.helperReady;
  }

  private async installHelper() {
    const extensionDir = path.dirname(
      path.dirname(fileURLToPath(import.meta.url)),
    );
    const helper = fs.readFileSync(
      path.join(extensionDir, "remote", "helper.py"),
      "utf8",
    );
    const helperPath = this.config.remoteHelper;
    const helperDir = path.posix.dirname(helperPath);
    await this.execute(
      `umask 077 && mkdir -p ${shellQuote(helperDir)} && temporary=${shellQuote(`${helperPath}.upload`)}.$$ && cat > "$temporary" && chmod 700 "$temporary" && mv -f "$temporary" ${shellQuote(helperPath)}`,
      { input: helper, timeoutMs: 20_000 },
    );
    const pingOutput = await this.execute(
      `exec /usr/bin/python3 ${shellQuote(helperPath)}`,
      { input: JSON.stringify({ action: "ping" }), timeoutMs: 20_000 },
    );
    const ping = JSON.parse(pingOutput.trim().split(/\r?\n/).at(-1) ?? "") as {
      ok?: boolean;
      result?: { protocol?: number; ok?: boolean };
      error?: string;
    };
    if (!ping.ok || !ping.result?.ok || ping.result.protocol !== 1) {
      throw new Error(
        ping.error ??
          `Remote helper protocol mismatch (expected 1, received ${ping.result?.protocol ?? "unknown"})`,
      );
    }
  }

  async request<T>(
    request: Record<string, unknown>,
    options: ExecuteOptions = {},
  ) {
    await this.ensureHelper();
    const output = await this.execute(
      `exec /usr/bin/python3 ${shellQuote(this.config.remoteHelper)}`,
      {
        ...options,
        input: JSON.stringify(request),
      },
    );
    let envelope: unknown;
    try {
      // Login banners or shell startup noise may precede the helper envelope.
      envelope = JSON.parse(output.trim().split(/\r?\n/).at(-1) ?? "");
    } catch {
      throw new Error(
        `Remote helper returned invalid JSON: ${output.slice(-500)}`,
      );
    }
    if (!envelope || typeof envelope !== "object")
      throw new Error("Remote helper returned an invalid response");
    const response = envelope as { ok?: boolean; result?: T; error?: string };
    if (!response.ok) throw new Error(response.error || "Remote helper failed");
    return response.result as T;
  }
}
