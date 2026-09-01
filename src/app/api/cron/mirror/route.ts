import { NextResponse } from "next/server";
import { env, isCronEnabled, isGoogleEnabled } from "@/lib/env";
import { secretsMatch } from "@/lib/session";
import { retryPendingMirrors } from "@/server/sheet-mirror";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Sweep up quotations that have not reached the Google Sheet yet.
 *
 * The mirror normally runs in the background right after a quotation is sent
 * or an order is placed. This is the safety net for the cases that background
 * run cannot cover: the process was restarted mid-flight, or Google was down
 * at the time and is back now.
 *
 *   *\/15 * * * * curl -fsS -X POST https://your-app/api/cron/mirror \
 *     -H "Authorization: Bearer $CRON_SECRET"
 *
 * Idempotent: a quotation that is already SYNCED is not picked up, and one
 * that is re-mirrored overwrites its own row and its own file rather than
 * adding a second.
 */
async function run(request: Request) {
  if (!isCronEnabled()) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET is not set, so this route is disabled." },
      { status: 503 },
    );
  }

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!provided || !secretsMatch(provided, env.CRON_SECRET)) {
    return NextResponse.json({ ok: false, error: "Unauthorised" }, { status: 401 });
  }

  if (!isGoogleEnabled()) {
    return NextResponse.json(
      { ok: true, status: "disabled", message: "Google is not configured." },
      { status: 200 },
    );
  }

  const result = await retryPendingMirrors(25);

  return NextResponse.json({
    ok: true,
    attempted: result.attempted,
    succeeded: result.succeeded,
    failed: result.attempted - result.succeeded,
  });
}

export async function POST(request: Request) {
  return run(request);
}

export async function GET(request: Request) {
  return run(request);
}
