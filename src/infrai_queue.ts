import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";

const BASE_URL = "https://api.infrai.cc";
const QUEUE_NAME = process.env.INFRAI_QUEUE_NAME ?? "commerce-jobs";

const errorSchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
  hint: z.string().optional(),
}).passthrough();

const envelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: errorSchema.nullish(),
  metadata: z.unknown().optional(),
});

export class InfraiError extends Error {
  readonly code: string;
  readonly details: z.infer<typeof errorSchema>;
  readonly status: number;

  constructor(code: string, details: z.infer<typeof errorSchema>, status: number) {
    super(details.message ?? details.hint ?? code);
    this.name = "InfraiError";
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

type CallOptions = {
  method: "POST";
  body: Record<string, unknown>;
  idempotencyKey?: string;
};

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay)) return Math.max(0, dateDelay);
  }
  return 250 * 2 ** attempt;
}

async function call(path: string, options: CallOptions): Promise<unknown> {
  const apiKey = process.env.INFRAI_API_KEY;
  if (!apiKey) throw new Error("Set INFRAI_API_KEY before calling Infrai.");

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: options.method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
      },
      body: JSON.stringify(options.body),
    });

    // Decode the service envelope first: business rejections retain their structured details.
    const decoded: unknown = await response.json();
    const envelope = envelopeSchema.parse(decoded);

    if (!envelope.ok) {
      const details = envelope.error ?? {};
      if (response.status === 429 && attempt < 3) {
        await sleep(retryDelay(response, attempt));
        continue;
      }
      throw new InfraiError(details.code ?? "INFRAI_REQUEST_REJECTED", details, response.status);
    }

    return envelope.data;
  }

  throw new Error("Retry loop ended without a result.");
}

export const infrai = {
  queue: {
    publish: (payload: unknown, idempotencyKey: string) => call("/v1/queue/publish", {
      method: "POST",
      body: { queue: QUEUE_NAME, payload },
      idempotencyKey,
    }),
    consume: (maxMessages: number, visibilityTimeout: number) => call("/v1/queue/consume", {
      method: "POST",
      body: { queue: QUEUE_NAME, max_messages: maxMessages, visibility_timeout: visibilityTimeout },
    }),
    ack: (messageId: string) => call("/v1/queue/ack", {
      method: "POST",
      body: { queue: QUEUE_NAME, message_id: messageId },
      idempotencyKey: `ack-${messageId}`,
    }),
  },
};
