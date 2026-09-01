import { NextResponse } from "next/server";
import { env, isCronEnabled } from "@/lib/env";
import { secretsMatch } from "@/lib/session";
import { syncIndiamart } from "@/server/ingest/indiamart";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The IndiaMART pull, triggered from outside.
 *
 * This app is one Node process on one port with no worker, so the schedule
 * lives in whatever cron the host provides:
 *
 *   *\/5 * * * * curl -fsS -X POST https://your-app/api/cron/indiamart \
 *     -H "Authorization: Bearer $CRON_SECRET"
 *
 * The five-minute rule is NOT delegated to that cron. syncIndiamart() checks
 * SyncState.lastRunAt itself and refuses to call the provider early, so a
 * misconfigured schedule, a double-fired cron or somebody hitting this by
 * hand still cannot breach the limit. A refusal comes back as 429 with the
 * seconds remaining, which is the honest answer rather than a fake success.
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

  const result = await syncIndiamart();

  const status =
    result.status === "ok"
      ? 200
      : result.status === "skipped"
        ? 429
        : result.status === "locked"
          ? 409
          : result.status === "disabled"
            ? 503
            : 502;

  return NextResponse.json(
    {
      ok: result.status === "ok",
      status: result.status,
      message: result.message,
      ...result.tally,
    },
    {
      status,
      headers: result.retryAfterSeconds
        ? { "retry-after": String(result.retryAfterSeconds) }
        : undefined,
    },
  );
}

export async function POST(request: Request) {
  return run(request);
}

/** Some schedulers can only issue GET. Same auth, same rate limit. */
export async function GET(request: Request) {
  return run(request);
}
