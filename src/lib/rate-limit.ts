import "server-only";
import { prisma } from "./db";

/**
 * A fixed-window counter, backed by the database.
 *
 * This app runs on Vercel: each request can be served by an independently
 * cold-started serverless instance with no memory shared between them, so a
 * process-memory counter resets on every new instance and never actually
 * enforces a limit under real concurrency or scale-out. The single
 * INSERT ... ON CONFLICT below is one atomic statement - Postgres takes a row
 * lock on the conflicting key, so two requests hitting the same key at the
 * same instant on two different instances still serialise correctly.
 *
 * Used only to blunt password guessing. It is not a billing meter.
 */

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export async function hit(
  key: string,
  limit: number,
  windowMinutes: number,
): Promise<RateLimitResult> {
  const now = new Date();
  const freshResetAt = new Date(now.getTime() + windowMinutes * 60_000);

  const [row] = await prisma.$queryRaw<{ count: number; resetAt: Date }[]>`
    INSERT INTO "RateLimit" ("key", "count", "resetAt")
    VALUES (${key}, 1, ${freshResetAt})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE
        WHEN "RateLimit"."resetAt" <= ${now} THEN 1
        ELSE "RateLimit"."count" + 1
      END,
      "resetAt" = CASE
        WHEN "RateLimit"."resetAt" <= ${now} THEN ${freshResetAt}
        ELSE "RateLimit"."resetAt"
      END
    RETURNING "count", "resetAt"
  `;

  void sweep();

  const count = row!.count;
  const resetAt = row!.resetAt.getTime();
  const allowed = count <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: allowed
      ? 0
      : Math.max(1, Math.ceil((resetAt - now.getTime()) / 1000)),
  };
}

/** Called after a success, so a good password clears the counter. */
export async function reset(key: string): Promise<void> {
  await prisma.rateLimit.delete({ where: { key } }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

let lastSweep = 0;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Delete every window that expired more than an hour ago, at most once an
 * hour per process. Fire-and-forget: it must never delay or fail a request.
 * Mirrors pruneExpiredSessions() in lib/session.ts.
 */
function sweep(): Promise<void> {
  const now = Date.now();
  if (now - lastSweep < SWEEP_INTERVAL_MS) return Promise.resolve();
  lastSweep = now;

  return prisma.rateLimit
    .deleteMany({ where: { resetAt: { lte: new Date(now - SWEEP_INTERVAL_MS) } } })
    .then(() => undefined)
    .catch(() => undefined);
}
