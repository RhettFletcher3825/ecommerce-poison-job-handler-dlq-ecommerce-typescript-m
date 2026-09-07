import { z } from "zod";

export const checkoutRequestSchema = z.object({
  orderId: z.string().min(1),
  customerEmail: z.email(),
  paymentStatus: z.enum(["authorized", "declined"]),
  inventoryStatus: z.enum(["allocated", "backorder"]),
}).strict();

export const workerRequestSchema = z.object({
  maxMessages: z.number().int().min(1).max(10).default(5),
}).strict();

const stageSchema = z.enum(["checkout", "fulfillment", "receipt", "customer_order_update"]);

export const ecommerceJobSchema = checkoutRequestSchema.extend({
  kind: z.literal("ecommerce_job"),
  stage: stageSchema,
  attempt: z.number().int().positive(),
}).strict();

export type EcommerceJob = z.infer<typeof ecommerceJobSchema>;

export type JobDecision =
  | { action: "complete"; orderId: string }
  | { action: "advance"; next: EcommerceJob }
  | { action: "retry"; next: EcommerceJob; reason: "inventory_backorder" }
  | { action: "dead_letter"; reason: "payment_declined" | "inventory_attempts_exhausted" };

const nextStage: Record<EcommerceJob["stage"], EcommerceJob["stage"] | undefined> = {
  checkout: "fulfillment",
  fulfillment: "receipt",
  receipt: "customer_order_update",
  customer_order_update: undefined,
};

export function decideJob(job: EcommerceJob): JobDecision {
  if (job.stage === "checkout" && job.paymentStatus === "declined") {
    return { action: "dead_letter", reason: "payment_declined" };
  }

  if (job.stage === "fulfillment" && job.inventoryStatus === "backorder") {
    if (job.attempt >= 3) {
      return { action: "dead_letter", reason: "inventory_attempts_exhausted" };
    }
    return {
      action: "retry",
      reason: "inventory_backorder",
      next: { ...job, attempt: job.attempt + 1 },
    };
  }

  const stage = nextStage[job.stage];
  if (!stage) return { action: "complete", orderId: job.orderId };
  return { action: "advance", next: { ...job, stage, attempt: 1 } };
}

export function firstJob(input: z.infer<typeof checkoutRequestSchema>): EcommerceJob {
  return { kind: "ecommerce_job", stage: "checkout", attempt: 1, ...input };
}
