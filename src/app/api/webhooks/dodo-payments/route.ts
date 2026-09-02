import { NextResponse } from "next/server";
import { isBillingEnabled } from "@/lib/env";
import { handleDodoWebhook, verifyDodoSignature } from "@/server/billing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Dodo Payments subscription billing webhook.
 *
 * Mirrors api/webhooks/meta/route.ts exactly: the raw body is read as text
 * and checked against the Standard Webhooks signature headers before
 * anything is parsed out of it, because re-serialising parsed JSON would
 * change the digest and because an unverified body must never reach code
 * that moves a subscription date.
 */
export async function POST(request: Request) {
  if (!isBillingEnabled()) {
    // Nothing can be verified without a webhook secret, so nothing is
    // accepted.
    return NextResponse.json(
      { ok: false, error: "Billing is not configured" },
      { status: 503 },
    );
  }

  const rawBody = await request.text();
  const verified = verifyDodoSignature(rawBody, {
    id: request.headers.get("webhook-id"),
    timestamp: request.headers.get("webhook-timestamp"),
    signature: request.headers.get("webhook-signature"),
  });

  if (!verified) {
    return NextResponse.json({ ok: false, error: "Bad signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // Signed but unparseable. Answer 200 so Dodo Payments stops retrying a
    // body that will never parse.
    return NextResponse.json({ ok: true, ignored: "unparseable" });
  }

  try {
    await handleDodoWebhook(payload);
    return NextResponse.json({ ok: true });
  } catch (error) {
    // A genuine failure on our side: 500 makes Dodo Payments retry, which is
    // what we want when the database was briefly unreachable.
    console.error("[dodo-payments] webhook failed", error);
    return NextResponse.json(
      { ok: false, error: "Processing failed" },
      { status: 500 },
    );
  }
}
