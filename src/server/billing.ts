import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import {
  dodoPaymentsApiBase,
  dodoPaymentsWebhookUrl,
  env,
  isBillingEnabled,
} from "@/lib/env";
import { ConflictError } from "@/lib/errors";
import { formatPaise, toPaise } from "@/lib/money";
import { requirePermission } from "@/lib/permissions";
import { isSubscriptionExpired, type SessionUser } from "@/lib/session";
import type { SubscriptionPaymentStatus } from "@/generated/prisma/enums";
import { audit } from "./audit";

/**
 * Subscription billing through Dodo Payments.
 *
 * One flat plan, no tiers - every organisation renews against the same
 * product, created once in the Dodo Payments dashboard. This app never
 * stores or bills a rupee amount itself; Dodo Payments prices the product on
 * its own side, so there is nothing here that can drift from what a customer
 * is actually charged. The flow:
 *
 *   1. createRenewalCheckout() - an OWNER presses "Renew". A SubscriptionPayment
 *      row is created first (status CREATED, no amount yet - it isn't known
 *      until the webhook reports what was actually charged), and its own id
 *      is written into the checkout session's `metadata` alongside this
 *      organisation's id, so the row can be found again without trusting
 *      anything the client or the webhook body claims on its own.
 *   2. The browser is redirected to Dodo Payments' hosted checkout_url. There
 *      is no client-side SDK to load - Dodo Payments is a hosted checkout
 *      product, not an embeddable modal like Razorpay's.
 *   3. Dodo Payments' webhook (payment.succeeded) is what calls
 *      applyCapturedPayment(), which is where Organisation.subscriptionUntil
 *      actually moves. A customer closing the tab before being redirected
 *      back must not mean the subscription silently never renews, so nothing
 *      about the redirect itself extends anything.
 *
 * The organisation to credit is never taken from anything a client sent, and
 * not even from the webhook body's metadata as the primary source - it comes
 * from OUR OWN SubscriptionPayment row, found by the id we ourselves wrote
 * into the checkout session, which only this app could have created and only
 * for the organisation it was created for. The metadata on the webhook body
 * is still read back and cross-checked (expectedOrgId below) as a
 * belt-and-braces sanity check, but a mismatch there refuses the credit
 * rather than ever being the thing that grants it.
 */

const RENEWAL_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// What the Settings page reads
// ---------------------------------------------------------------------------

export interface SubscriptionPaymentRow {
  id: string;
  amountPaise: number | null;
  status: SubscriptionPaymentStatus;
  dodoPaymentId: string | null;
  subscriptionUntilAfter: Date | null;
  createdAt: Date;
}

export interface BillingStatus {
  enabled: boolean;
  /** Paste into the Dodo Payments dashboard's Webhooks page. Shown even when billing is off, so setting it up is a copy-paste away. */
  webhookUrl: string;
  subscriptionUntil: Date | null;
  expired: boolean;
  recentPayments: SubscriptionPaymentRow[];
}

export async function getBillingStatus(user: SessionUser): Promise<BillingStatus> {
  requirePermission(user.role, "workspace.billing");

  const [org, payments] = await Promise.all([
    prisma.organisation.findUniqueOrThrow({
      where: { id: user.orgId },
      select: { subscriptionUntil: true },
    }),
    prisma.subscriptionPayment.findMany({
      where: { orgId: user.orgId },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        amountPaise: true,
        status: true,
        dodoPaymentId: true,
        subscriptionUntilAfter: true,
        createdAt: true,
      },
    }),
  ]);

  return {
    enabled: isBillingEnabled(),
    webhookUrl: dodoPaymentsWebhookUrl(),
    subscriptionUntil: org.subscriptionUntil,
    expired: isSubscriptionExpired(org),
    recentPayments: payments.map((p) => ({
      ...p,
      amountPaise: p.amountPaise === null ? null : toPaise(p.amountPaise),
    })),
  };
}

// ---------------------------------------------------------------------------
// Creating a renewal checkout
// ---------------------------------------------------------------------------

export interface RenewalCheckout {
  checkoutUrl: string;
}

/** Bearer-authed calls to the Dodo Payments REST API. No SDK - one endpoint does not need one. */
async function dodoRequest<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${dodoPaymentsApiBase()}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.DODO_PAYMENTS_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Dodo Payments ${path} failed with ${response.status}: ${detail.slice(0, 300)}`,
    );
  }
  return (await response.json()) as T;
}

interface DodoCheckoutSessionResponse {
  session_id: string;
  checkout_url: string | null;
}

/**
 * An OWNER pressing "Renew". Requires billing to be configured - refused with
 * a ConflictError otherwise, which the UI never even offers to press because
 * the button is hidden while isBillingEnabled() is false.
 */
export async function createRenewalCheckout(
  user: SessionUser,
): Promise<RenewalCheckout> {
  requirePermission(user.role, "workspace.billing");

  if (!isBillingEnabled()) {
    throw new ConflictError(
      "Billing is not configured yet. Ask your platform administrator to extend your subscription.",
    );
  }

  const row = await prisma.subscriptionPayment.create({
    data: { orgId: user.orgId, status: "CREATED" },
    select: { id: true },
  });

  const session = await dodoRequest<DodoCheckoutSessionResponse>("/checkouts", {
    product_cart: [{ product_id: env.DODO_PAYMENTS_PRODUCT_ID, quantity: 1 }],
    // Round-tripped back to us, unmodified, on the resulting Payment object -
    // this is what lets the webhook find its way back to this exact row
    // without trusting anything else in the payload.
    metadata: { orgId: user.orgId, subscriptionPaymentId: row.id },
    return_url: `${env.APP_URL}/settings?billing=return`,
  });

  if (!session.checkout_url) {
    throw new Error("Dodo Payments did not return a checkout URL.");
  }

  await prisma.subscriptionPayment.update({
    where: { id: row.id },
    data: { checkoutSessionId: session.session_id },
  });

  return { checkoutUrl: session.checkout_url };
}

// ---------------------------------------------------------------------------
// The webhook
// ---------------------------------------------------------------------------

/**
 * Verifies a Dodo Payments webhook against the Standard Webhooks spec they
 * follow: HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{raw body}`,
 * keyed by the webhook secret (given as `whsec_<base64>`, decoded before
 * use), compared against one of the space-separated `v1,<signature>` entries
 * in the `webhook-signature` header. The timestamp is also bounds-checked, so
 * a captured request cannot be replayed indefinitely.
 *
 * The body must be the exact bytes Dodo Payments sent; re-serialising parsed
 * JSON would change the digest.
 */
export function verifyDodoSignature(
  rawBody: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
): boolean {
  if (!isBillingEnabled()) return false;
  if (!headers.id || !headers.timestamp || !headers.signature) return false;

  const timestampSeconds = Number(headers.timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  // Five minutes either side, matching the tolerance Standard Webhooks
  // implementations recommend.
  const skewSeconds = Math.abs(Date.now() / 1000 - timestampSeconds);
  if (skewSeconds > 5 * 60) return false;

  const secret = env.DODO_PAYMENTS_WEBHOOK_SECRET;
  const secretBytes = Buffer.from(
    secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret,
    "base64",
  );
  const signedContent = `${headers.id}.${headers.timestamp}.${rawBody}`;
  const expected = createHmac("sha256", secretBytes)
    .update(signedContent, "utf8")
    .digest("base64");
  const expectedBytes = Buffer.from(expected, "utf8");

  return headers.signature
    .split(" ")
    .map((entry) => entry.split(",")[1])
    .filter((candidate): candidate is string => Boolean(candidate))
    .some((candidate) => {
      const candidateBytes = Buffer.from(candidate, "utf8");
      return (
        candidateBytes.length === expectedBytes.length &&
        timingSafeEqual(candidateBytes, expectedBytes)
      );
    });
}

// Loose on purpose: Dodo Payments' payload carries far more than this, and
// event types this app has not been taught about yet must not fail parsing.
const dodoWebhookSchema = z
  .object({
    type: z.string(),
    data: z
      .object({
        payment_id: z.string().optional(),
        status: z.string().optional(),
        total_amount: z.number().optional(),
        currency: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough(),
  })
  .passthrough();

function readMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Route this from api/webhooks/dodo-payments/route.ts, after the signature
 * has already been verified. Never throws on a payload it does not recognise
 * - the webhook endpoint has to tolerate event types this app has not been
 * taught about yet without failing the delivery.
 */
export async function handleDodoWebhook(payload: unknown): Promise<void> {
  const parsed = dodoWebhookSchema.safeParse(payload);
  if (!parsed.success) return;

  const { type, data } = parsed.data;

  if (type === "payment.succeeded" || data.status === "succeeded") {
    const subscriptionPaymentId = readMetadataString(
      data.metadata,
      "subscriptionPaymentId",
    );
    const expectedOrgId = readMetadataString(data.metadata, "orgId");
    if (!subscriptionPaymentId || !data.payment_id) return;

    await applyCapturedPayment({
      subscriptionPaymentId,
      dodoPaymentId: data.payment_id,
      expectedOrgId,
      totalAmount: data.total_amount ?? null,
      currency: data.currency ?? null,
    });
    return;
  }

  if (type === "payment.failed") {
    const subscriptionPaymentId = readMetadataString(
      data.metadata,
      "subscriptionPaymentId",
    );
    if (subscriptionPaymentId) await markPaymentFailed(subscriptionPaymentId);
  }
}

interface CaptureInput {
  subscriptionPaymentId: string;
  dodoPaymentId: string;
  /** From the webhook body's own metadata, cross-checked, never trusted alone. */
  expectedOrgId: string | null;
  totalAmount: number | null;
  currency: string | null;
}

/**
 * Apply a confirmed capture. Idempotent: a webhook can be redelivered, so
 * replaying the same payment a second time is a no-op.
 *
 * Mirrors recordPayment()'s lock in server/orders.ts: a `SELECT ... FOR
 * UPDATE` on the SubscriptionPayment row serialises concurrent deliveries of
 * the same event against each other, and a second lock on the Organisation
 * row keeps this from racing setSubscriptionUntil() (the platform
 * administrator's manual override), which touches the same column.
 */
export async function applyCapturedPayment(input: CaptureInput): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "SubscriptionPayment"
      WHERE id = ${input.subscriptionPaymentId}
      FOR UPDATE
    `;
    if (!locked) {
      // A payment Dodo Payments knows about that this app never created.
      // Cannot happen through the Renew flow, but a webhook is an open
      // endpoint and must not throw on input it cannot explain.
      return;
    }

    const row = await tx.subscriptionPayment.findUniqueOrThrow({
      where: { id: locked.id },
      select: { id: true, orgId: true, status: true },
    });
    if (row.status === "CAPTURED") return; // Already applied.

    if (input.expectedOrgId && input.expectedOrgId !== row.orgId) {
      // The webhook's own metadata disagrees with the organisation this
      // payment was created for. Should never happen once the signature has
      // verified - Dodo Payments only ever echoes back the metadata we sent
      // it - but this is exactly the check that makes it a belt-and-braces
      // refusal rather than a silent trust of whichever value showed up
      // first.
      console.error(
        `[dodo-payments] payment ${input.dodoPaymentId} metadata.orgId (${input.expectedOrgId}) ` +
          `does not match the organisation it was created for (${row.orgId}). Refusing to extend anything.`,
      );
      return;
    }

    // This app prices and bills only in INR, everywhere else - a payment
    // reported in anything else means the Dodo Payments product was set up
    // wrong, not that this code should silently mislabel the amount.
    const amountPaise =
      input.totalAmount !== null && input.currency === "INR"
        ? BigInt(Math.round(input.totalAmount))
        : null;
    if (input.totalAmount !== null && input.currency !== "INR") {
      console.error(
        `[dodo-payments] payment ${input.dodoPaymentId} was charged in ${input.currency}, ` +
          "not INR - check how the subscription product is priced in the Dodo Payments dashboard.",
      );
    }

    // Locks the row setSubscriptionUntil() also writes, so a manual override
    // landing at the same instant cannot be clobbered or clobber this.
    await tx.$queryRaw`SELECT id FROM "Organisation" WHERE id = ${row.orgId} FOR UPDATE`;

    const org = await tx.organisation.findUniqueOrThrow({
      where: { id: row.orgId },
      select: { name: true, subscriptionUntil: true },
    });

    const now = new Date();
    // Stacks on top of whatever runway is left, rather than resetting the
    // clock - a renewal made five days before expiry should not throw away
    // those five days.
    const base =
      org.subscriptionUntil && org.subscriptionUntil.getTime() > now.getTime()
        ? org.subscriptionUntil
        : now;
    const newUntil = new Date(base.getTime() + RENEWAL_DAYS * MS_PER_DAY);

    await tx.organisation.update({
      where: { id: row.orgId },
      data: { subscriptionUntil: newUntil },
    });

    await tx.subscriptionPayment.update({
      where: { id: row.id },
      data: {
        dodoPaymentId: input.dodoPaymentId,
        amountPaise,
        status: "CAPTURED",
        capturedAt: now,
        subscriptionUntilAfter: newUntil,
      },
    });

    await audit(tx, {
      orgId: row.orgId,
      action: "workspace.subscription.renewed",
      actorId: null,
      targetType: "Organisation",
      targetId: row.orgId,
      detail:
        `Dodo Payments payment ${input.dodoPaymentId}` +
        (amountPaise !== null ? ` (${formatPaise(toPaise(amountPaise))})` : "") +
        ` extended the ${org.name} workspace's subscription to run until ${newUntil.toISOString()}`,
    });
  });
}

/** Guarded so a failure event delivered out of order can never undo a capture. */
async function markPaymentFailed(subscriptionPaymentId: string): Promise<void> {
  await prisma.subscriptionPayment.updateMany({
    where: { id: subscriptionPaymentId, status: "CREATED" },
    data: { status: "FAILED" },
  });
}
