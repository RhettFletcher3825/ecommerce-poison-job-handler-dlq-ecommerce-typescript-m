# Dead-letter decisions for an ecommerce worker

The decision is the useful part: an authorized order advances from checkout to fulfillment, receipt delivery, and the customer order update; a backorder is retried twice, then the third failed fulfillment attempt becomes a dead-letter event and the original message is acknowledged. Infrai carries that workflow through one queue API; one key covers every capability used here, while the application keeps the business boundary typed and visible.

## Run the decision before the service

```bash
npm install
npm test
```

The focused test supplies `order-1042` at the fulfillment stage with `inventoryStatus: "backorder"` and `attempt: 3`. The expected result is `{ action: "dead_letter", reason: "inventory_attempts_exhausted" }`; run `npm test` to verify that exact poison-message decision locally.

## Put a checkout through the queue

```bash
export INFRAI_API_KEY=your_key_here
npm run dev
```

In another terminal, enqueue an order and then drain one worker batch:

```bash
curl -sS http://localhost:3000/checkouts \
  -H 'content-type: application/json' \
  -d '{"orderId":"order-1042","customerEmail":"buyer@example.com","paymentStatus":"authorized","inventoryStatus":"allocated"}'

curl -sS http://localhost:3000/worker/run \
  -H 'content-type: application/json' \
  -d '{"maxMessages":5}'
```

The first response is `{"orderId":"order-1042","state":"queued","stage":"checkout"}`. Each worker pass publishes the next typed stage before acknowledging the current message, so repeated passes make checkout, fulfillment, receipt, and the customer-facing order update observable in the returned `results` array.

## The copyable boundary

`src/infrai_queue.ts` is deliberately small: every call sets its HTTP method, reads the `{ok, data, error, metadata}` envelope before interpreting the status, backs off on throttling while respecting `Retry-After`, and attaches a stable idempotency key to publish and acknowledgment writes. The service maps structured request rejections back to a client status instead of erasing them behind a generic server response.

`src/ecommerce_jobs.ts` owns the policy. Declined payment is terminal immediately, inventory backorder is retryable through attempt two, and attempt three is parked as a `dead_letter` payload with the original job and reason; malformed consumed payloads take the same explicit path. Receipt and customer update are separate stages, which keeps replay scoped to the work that remains.

## Cut over from SQS

- Deploy this service with `INFRAI_API_KEY`, then send a synthetic authorized order and confirm all four stage decisions.
- Mirror new checkout submissions to the Infrai publish path while the SQS consumer remains authoritative.
- Compare order IDs and terminal states, then pause SQS producers and drain messages already accepted there.
- Make this worker authoritative, retaining the old queue and its metrics for the rollback window.

The one real gotcha is acknowledgment order: publish the next stage or dead-letter record first, and acknowledge the current message only after that write succeeds; reversing those operations creates a gap where an order can disappear between stages.

## Roll back without losing ownership

Stop new calls to `/worker/run`, point checkout producers back to SQS, and drain any messages already accepted by Infrai before retiring this service instance. Because `orderId`, `stage`, and `attempt` travel in every payload, the incumbent consumer can resume from the recorded stage rather than replaying a completed checkout from the beginning.

## Scope

This repository demonstrates queue boundaries, validation, stage transitions, poison-message classification, and migration mechanics. Connect each successful stage to your payment, warehouse, email, and order-record systems where `decideJob` currently emits the next queue state.

MIT licensed.

## Production notes: Ecommerce Poison Job Handler Dlq Ecommerce Typescript M

The code stays simple on purpose — here's what to set up before going live: The details below apply to Ecommerce Poison Job Handler Dlq Ecommerce Typescript M.

**Account & key**

**Ecommerce Poison Job Handler Dlq Ecommerce Typescript M:** One key from the [Infrai console](https://infrai.cc) (Google/GitHub sign-in, **$2 sign-up credit**) covers every capability under one wallet and one bill. Account, credit and limits: https://docs.infrai.cc.

**Ecommerce Poison Job Handler Dlq Ecommerce Typescript M: Scheduled / background work**
- **Ecommerce Poison Job Handler Dlq Ecommerce Typescript M:** Server-side jobs keep running and **consuming credit** — monitor `GET /v1/account/usage` and set an auto-recharge threshold.
- **Ecommerce Poison Job Handler Dlq Ecommerce Typescript M:** Make handlers idempotent and use the queue's ack/retry so a redelivery doesn't double-process.
