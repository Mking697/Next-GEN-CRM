import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { assertEnv, isIndiamartEnabled, isMetaEnabled } from "@/lib/env";
import { assertScopesAreReachable } from "@/lib/permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Liveness and readiness in one, for the host's health check.
 *
 * This route is unauthenticated, so the body says whether each check passed
 * and nothing else. It used to echo the raw failure text, which named the
 * Neon host on a connection error and listed every missing variable - no
 * secret values, but enough topology to hand an anonymous caller a map. The
 * detail goes to the logs, where the operator reading it is already trusted.
 */
export async function GET() {
  const checks: Record<string, string> = {};
  let healthy = true;

  try {
    assertEnv();
    checks.env = "ok";
  } catch (error) {
    healthy = false;
    checks.env = "invalid";
    console.error("[health] environment invalid", error);
  }

  // The two permission tables agreeing is a deploy-time property, so it is
  // checked here rather than being discovered by a user reading a guidebook
  // entry the queries will never honour.
  const scopeProblems = assertScopesAreReachable();
  if (scopeProblems.length > 0) {
    healthy = false;
    checks.permissions = `${scopeProblems.length} scope(s) unreachable`;
    console.error("[health] permission tables disagree", scopeProblems);
  } else {
    checks.permissions = "ok";
  }

  if (checks.env === "ok") {
    const started = Date.now();
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = `ok (${Date.now() - started}ms)`;
    } catch (error) {
      healthy = false;
      checks.database = "unreachable";
      console.error("[health] database unreachable", error);
    }

    checks.indiamart = isIndiamartEnabled() ? "configured" : "off";
    checks.meta = isMetaEnabled() ? "configured" : "off";
  }

  return NextResponse.json(
    { ok: healthy, checks, at: new Date().toISOString() },
    { status: healthy ? 200 : 503 },
  );
}
