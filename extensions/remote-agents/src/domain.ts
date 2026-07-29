export type RemoteAgentStatus =
  | "starting"
  | "working"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled"
  | "unreachable"
  | "unknown";

export interface RemoteAgentSnapshot {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly host: string;
  readonly localCwd: string;
  readonly remoteCwd: string;
  readonly projectRoot?: string;
  readonly projectName?: string;
  readonly workspaceId?: string;
  readonly paneId?: string;
  readonly sessionPath?: string;
  readonly status: RemoteAgentStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly settledAt?: number;
  readonly lastSeenAt?: number;
  readonly errorText?: string;
  readonly transcript: string;
  readonly transcriptVersion: number;
  readonly finalText?: string;
  readonly generation: number;
  readonly promptBaselineSeq?: number;
  readonly promptObservedActivity?: boolean;
  readonly resultMissingSince?: number;
  readonly cancelRequested?: boolean;
  readonly completionDelivered?: boolean;
  readonly blockedDelivered?: boolean;
}

export function isRemoteAgentActive(status: RemoteAgentStatus) {
  return (
    status === "starting" ||
    status === "working" ||
    status === "blocked" ||
    status === "unreachable" ||
    status === "unknown"
  );
}

export function formatElapsed(snapshot: RemoteAgentSnapshot) {
  const end = snapshot.settledAt ?? Date.now();
  const totalSeconds = Math.max(
    0,
    Math.round((end - snapshot.createdAt) / 1000),
  );
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m${seconds.toString().padStart(2, "0")}s`
    : `${seconds}s`;
}
