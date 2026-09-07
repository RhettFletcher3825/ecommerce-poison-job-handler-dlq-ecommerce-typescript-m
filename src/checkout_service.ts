import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ZodError, z } from "zod";
import { decideJob, ecommerceJobSchema, firstJob, checkoutRequestSchema, workerRequestSchema } from "./ecommerce_jobs";
import { InfraiError, infrai } from "./infrai_queue";

const consumedSchema = z.object({
  items: z.array(z.object({ message_id: z.string(), payload: z.unknown() })).default([]),
});

function stableKey(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function submitCheckout(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const input = checkoutRequestSchema.parse(await readJson(request));
  const job = firstJob(input);
  await infrai.queue.publish(job, `checkout-${job.orderId}`);
  send(response, 202, { orderId: job.orderId, state: "queued", stage: job.stage });
}

async function runWorker(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const input = workerRequestSchema.parse(await readJson(request));
  const batch = consumedSchema.parse(await infrai.queue.consume(input.maxMessages, 30));
  const results: Array<Record<string, unknown>> = [];

  for (const message of batch.items) {
    const parsed = ecommerceJobSchema.safeParse(message.payload);
    if (!parsed.success) {
      const deadLetter = { kind: "dead_letter", reason: "invalid_job", original: message.payload };
      await infrai.queue.publish(deadLetter, `dead-${message.message_id}`);
      await infrai.queue.ack(message.message_id);
      results.push({ messageId: message.message_id, action: "dead_letter", reason: "invalid_job" });
      continue;
    }

    const decision = decideJob(parsed.data);
    if (decision.action === "advance" || decision.action === "retry") {
      await infrai.queue.publish(decision.next, `job-${stableKey(decision.next)}`);
    } else if (decision.action === "dead_letter") {
      const deadLetter = { kind: "dead_letter", reason: decision.reason, original: parsed.data };
      await infrai.queue.publish(deadLetter, `dead-${message.message_id}`);
    }
    await infrai.queue.ack(message.message_id);
    results.push({ messageId: message.message_id, ...decision, next: undefined });
  }

  send(response, 200, { processed: results.length, results });
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "POST" && request.url === "/checkouts") {
      await submitCheckout(request, response);
      return;
    }
    if (request.method === "POST" && request.url === "/worker/run") {
      await runWorker(request, response);
      return;
    }
    send(response, 404, { error: "route_not_found" });
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      send(response, 400, { error: "invalid_request" });
      return;
    }
    if (error instanceof InfraiError) {
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      send(response, status, { error: error.code, message: error.message });
      return;
    }
    console.error(error);
    send(response, 502, { error: "dependency_request_failed" });
  }
});

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 3000);
  server.listen(port, () => console.log(`Checkout worker listening on http://localhost:${port}`));
}
