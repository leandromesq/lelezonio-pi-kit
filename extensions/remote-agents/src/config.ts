import * as fs from "node:fs";
import * as path from "node:path";

export interface RemoteAgentsConfig {
  readonly host: string;
  readonly sshExecutable: string;
  readonly remoteHelper: string;
  readonly projectsRoot: string;
  readonly worktreesRoot: string;
  readonly openRemoteUiOnSpawn: boolean;
  readonly terminalExecutable: string;
  readonly pollIntervalMs: number;
  readonly maxConcurrent: number;
}

const windowsSsh = "C:\\Windows\\System32\\OpenSSH\\ssh.exe";

export function defaultRemoteAgentsConfig(): RemoteAgentsConfig {
  return {
    host: "macmini",
    sshExecutable: process.platform === "win32" ? windowsSsh : "ssh",
    remoteHelper: "/home/leandrom/.local/share/pi-remote/helper.py",
    projectsRoot: "/home/leandrom/Projects",
    worktreesRoot: "/home/leandrom/Worktrees",
    openRemoteUiOnSpawn: true,
    terminalExecutable: "kitty",
    pollIntervalMs: 3_000,
    maxConcurrent: 3,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function remoteRoot(value: unknown, fallback: string, field: string) {
  const root = typeof value === "string" ? value.trim() : fallback;
  if (!root.startsWith("/"))
    throw new Error(`${field} must be an absolute remote path`);
  return root.replace(/\/+$/, "");
}

export function parseRemoteAgentsConfig(value: unknown): RemoteAgentsConfig {
  if (!isRecord(value))
    throw new Error("remote-agents.json must contain an object");
  const defaults = defaultRemoteAgentsConfig();
  const host =
    typeof value.host === "string" ? value.host.trim() : defaults.host;
  const sshExecutable =
    typeof value.sshExecutable === "string"
      ? value.sshExecutable.trim()
      : defaults.sshExecutable;
  const remoteHelper =
    typeof value.remoteHelper === "string"
      ? value.remoteHelper.trim()
      : defaults.remoteHelper;
  const projectsRoot = remoteRoot(
    value.projectsRoot,
    defaults.projectsRoot,
    "projectsRoot",
  );
  const worktreesRoot = remoteRoot(
    value.worktreesRoot,
    defaults.worktreesRoot,
    "worktreesRoot",
  );
  const openRemoteUiOnSpawn =
    value.openRemoteUiOnSpawn ?? defaults.openRemoteUiOnSpawn;
  const terminalExecutable =
    typeof value.terminalExecutable === "string"
      ? value.terminalExecutable.trim()
      : defaults.terminalExecutable;
  const pollIntervalMs = value.pollIntervalMs ?? defaults.pollIntervalMs;
  const maxConcurrent = value.maxConcurrent ?? defaults.maxConcurrent;
  if (!host || !sshExecutable || !remoteHelper || !terminalExecutable)
    throw new Error(
      "host, sshExecutable, remoteHelper, and terminalExecutable must not be empty",
    );
  if (typeof openRemoteUiOnSpawn !== "boolean")
    throw new Error("openRemoteUiOnSpawn must be a boolean");
  if (
    typeof pollIntervalMs !== "number" ||
    !Number.isInteger(pollIntervalMs) ||
    pollIntervalMs < 1_000
  ) {
    throw new Error("pollIntervalMs must be an integer of at least 1000");
  }
  if (
    typeof maxConcurrent !== "number" ||
    !Number.isInteger(maxConcurrent) ||
    maxConcurrent < 1 ||
    maxConcurrent > 8
  ) {
    throw new Error("maxConcurrent must be an integer from 1 to 8");
  }
  return {
    host,
    sshExecutable,
    remoteHelper,
    projectsRoot,
    worktreesRoot,
    openRemoteUiOnSpawn,
    terminalExecutable,
    pollIntervalMs,
    maxConcurrent,
  };
}

export function loadRemoteAgentsConfig(filePath: string) {
  if (!fs.existsSync(filePath)) return defaultRemoteAgentsConfig();
  try {
    return parseRemoteAgentsConfig(
      JSON.parse(fs.readFileSync(filePath, "utf8")),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${path.basename(filePath)}: ${message}`);
  }
}
