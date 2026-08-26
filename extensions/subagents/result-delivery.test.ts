import assert from "node:assert/strict";
import test from "node:test";
import { createDeferredResultDelivery } from "./src/result-delivery.ts";

test("a result consumed by a later wait is not delivered", () => {
  const delivery = createDeferredResultDelivery<{
    id: string;
    output: string;
  }>();

  delivery.defer({ id: "sa-1", output: "done" });
  delivery.consumeResults([{ id: "sa-1", output: "done" }]);

  assert.deepEqual(delivery.drain(), []);
});

test("unconsumed results are delivered once in settlement order", () => {
  const delivery = createDeferredResultDelivery<{ id: string }>();
  const first = { id: "sa-1" };
  const second = { id: "sa-2" };

  delivery.defer(first);
  delivery.defer(second);

  assert.deepEqual(delivery.drain(), [first, second]);
  assert.deepEqual(delivery.drain(), []);
});

test("multiple settled runs with the same id remain FIFO", () => {
  const delivery = createDeferredResultDelivery<{
    id: string;
    output: string;
  }>();
  const first = { id: "sa-1", output: "first run" };
  const other = { id: "sa-2", output: "other run" };
  const second = { id: "sa-1", output: "second run" };

  delivery.defer(first);
  delivery.defer(other);
  delivery.defer(second);

  assert.deepEqual(delivery.drain(), [first, other, second]);
});

test("consumeResults removes only the exact run generation", () => {
  const delivery = createDeferredResultDelivery<{
    id: string;
    run: number;
    output: string;
  }>((result) => `${result.id}:${result.run}`);
  const first = { id: "sa-1", run: 1, output: "first" };
  const second = { id: "sa-1", run: 2, output: "second" };
  delivery.defer(first);
  delivery.defer(second);

  delivery.consumeResults([second]);

  assert.deepEqual(delivery.drain(), [first]);
});
