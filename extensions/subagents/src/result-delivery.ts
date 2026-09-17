import type { SubagentSnapshot } from "./domain.ts";

export type SettledResult = Pick<
  SubagentSnapshot,
  | "id"
  | "run"
  | "title"
  | "status"
  | "errorText"
  | "finalText"
  | "meta"
  | "usage"
  | "question"
>;

/** Notification delivery never needs to retain or clone a worker transcript. */
export function settledResult(snap: SubagentSnapshot): SettledResult {
  return {
    id: snap.id,
    run: snap.run,
    title: snap.title,
    status: snap.status,
    errorText: snap.errorText,
    finalText: snap.finalText,
    meta: { ...snap.meta },
    usage: { ...snap.usage },
    question: snap.question ? { ...snap.question } : undefined,
  };
}

export function createDeferredResultDelivery<T extends { id: string }>(
  keyOf: (result: T) => string = (result) => result.id,
) {
  // A session can settle more than once after follow-up turns. Keep every
  // immutable settlement in global FIFO order rather than overwriting by id.
  let pending: T[] = [];

  return {
    defer(result: T) {
      pending.push(result);
    },
    /** Consume only the exact settled runs represented by these results. */
    consumeResults(results: Iterable<T>) {
      const consumed = new Set([...results].map(keyOf));
      pending = pending.filter((result) => !consumed.has(keyOf(result)));
    },
    drain() {
      const results = pending;
      pending = [];
      return results;
    },
    clear() {
      pending = [];
    },
  };
}
