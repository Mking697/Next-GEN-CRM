import { NextResponse } from "next/server";
import { isMetaEnabled } from "@/lib/env";
import {
  handleMetaWebhook,
  verifyHandshake,
  verifyMetaSignature,
} from "@/server/ingest/meta";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Meta Lead Ads webhook.
 *
 * GET  - the one-time subscription handshake.
 * POST - a leadgen notification. The raw body is read as text and checked
 *        against X-Hub-Signature-256 before anything is parsed out of it,
 *        because re-serialising parsed JSON would change the digest and
 *        because an unverified body must never reach the ingest code.
 */

export async function GET(request: Request) {
  const url = new URL(request.url);
  const challenge = verifyHandshake(url.searchParams);

  if (!challenge) {
    return new NextResponse("Verification failed", { status: 403 });
  }
  // Meta wants the challenge echoed back as plain text.
  return new NextResponse(challenge, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

export async function POST(request: Request) {
  if (!isMetaEnabled()) {
    // Nothing can be verified without the app secret, so nothing is accepted.
    return NextResponse.json(
      { ok: false, error: "Meta integration is not configured" },
      { status: 503 },
    );
  }

  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");

  if (!verifyMetaSignature(rawBody, signature)) {
    return NextResponse.json(
      { ok: false, error: "Bad signature" },
      { status: 401 },
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    // Signed but unparseable. Answer 200 so Meta stops retrying a body that
    // will never parse.
    return NextResponse.json({ ok: true, ignored: "unparseable" });
  }

  try {
    const result = await handleMetaWebhook(payload);
    return NextResponse.json({
      ok: true,
      fetched: result.tally.fetched,
      created: result.tally.created,
      duplicates: result.tally.duplicates,
      errors: result.errors.length,
    });
  } catch (error) {
    // A genuine failure on our side: 500 makes Meta retry, which is what we
    // want when the database was briefly unreachable.
    console.error("[meta] webhook failed", error);
    return NextResponse.json(
      { ok: false, error: "Processing failed" },
      { status: 500 },
    );
  }
}
