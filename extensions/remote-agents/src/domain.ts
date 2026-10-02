import { formatElapsed as formatElapsedRange } from "../../shared/format.ts";

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
  /** Legacy shared delivery flag, kept for older registries and the in-process
   * notification dedupe. New code records the concrete recipient session in
   * `completionDeliveredTo`/`blockedDeliveredTo`. */
  readonly completionDelivered?: boolean;
  readonly blockedDelivered?: boolean;
  /** Pi session that spawned (and therefore owns the result of) this job. An
   * absent owner is a legacy entry: it is preserved and still inspectable, but
   * it is never auto-delivered to an arbitrary session — a user adopts it
   * explicitly. */
  readonly ownerSessionId?: string;
  /** Session that already received the settled/blocked result. Scoping by
   * session keeps one parent from stealing or permanently suppressing
   * another parent's delivery. */
  readonly completionDeliveredTo?: string;
  readonly blockedDeliveredTo?: string;
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

/** Snapshot-shaped adapter over the single `shared/format.ts` implementation. */
export function formatElapsed(snapshot: RemoteAgentSnapshot) {
  return formatElapsedRange(snapshot.createdAt, snapshot.settledAt);
}
