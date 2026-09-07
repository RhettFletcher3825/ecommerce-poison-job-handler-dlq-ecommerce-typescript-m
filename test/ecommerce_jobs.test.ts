import assert from "node:assert/strict";
import test from "node:test";
import { decideJob, ecommerceJobSchema } from "../src/ecommerce_jobs";

test("a third backorder attempt becomes a dead letter instead of another fulfillment retry", () => {
  const job = ecommerceJobSchema.parse({
    kind: "ecommerce_job",
    stage: "fulfillment",
    attempt: 3,
    orderId: "order-1042",
    customerEmail: "buyer@example.com",
    paymentStatus: "authorized",
    inventoryStatus: "backorder",
  });

  assert.deepEqual(decideJob(job), {
    action: "dead_letter",
    reason: "inventory_attempts_exhausted",
  });
});
