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
