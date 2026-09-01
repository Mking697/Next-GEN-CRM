import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { prisma } from "./db";
import { env } from "./env";
import type { Role } from "@/generated/prisma/enums";

/**
 * Sessions live in the database, not in a signed cookie.
 *
 * The reason is the delete rule. When an admin deletes an account or resets
 * somebody's password, that person has to lose access immediately, on every
 * device. A stateless JWT would stay valid until it expired. Session rows
 * cascade on user delete, so revocation is free and instant.
 *
 * The cookie carries an opaque random token. Only its sha256 is stored, so a
 * leaked database backup does not hand anybody a working session.
 */

const TOKEN_BYTES = 32;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  /**
   * For a CRE, every salesman they work for, by name. Empty for every other
   * role. Ordered by name so the sidebar switcher is stable.
   */
  salesmen: { id: string; name: string }[];
  /**
   * Which of those salesmen this CRE is acting for right now.
   *
   * Comes from a cookie, but is only ever trusted after being found in
   * `salesmen` above - a cookie is attacker-controlled, and this value feeds
   * straight into the scope clauses. An absent or unrecognised cookie falls
   * back to the first salesman, so there is no state in which a CRE is acting
   * for nobody while having somebody to act for.
   */
  activeSalesmanId: string | null;
  activeSalesmanName: string | null;
  isActive: boolean;
}

/** The cookie carrying which salesman a CRE is currently acting for. */
export function actingCookieName(): string {
  return `${env.SESSION_COOKIE_NAME}_acting`;
}

/**
 * Keyed hash of the cookie token.
 *
 * HMAC, not sha256(token + secret). The appended-key construction is the
 * wrong primitive for a keyed digest, and password-core.ts already reaches
 * for createHmac to do exactly this job - there is no reason for the two to
 * disagree about it.
 *
 * Changing this changes every tokenHash, so existing sessions stop resolving
 * and everybody signs in once more. Same blast radius as rotating
 * AUTH_SECRET, and no data is lost: the rows simply stop matching and are
 * swept out by pruneExpiredSessions().
 */
function hashToken(token: string): string {
  return createHmac("sha256", env.AUTH_SECRET).update(token).digest("hex");
}

function cookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    // APP_URL is the source of truth for whether we are behind TLS. env.ts
    // refuses to boot a production build on a non-https APP_URL, so this
    // cannot silently ship a cookie without Secure the way it used to.
    secure: env.APP_URL.startsWith("https://"),
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

/** Create a session row and set the cookie. Returns the expiry. */
export async function createSession(userId: string): Promise<Date> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const ttlMs = env.SESSION_TTL_HOURS * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttlMs);

  const headerList = await headers();

  await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt,
      userAgent: headerList.get("user-agent")?.slice(0, 300) ?? null,
      ip: clientIp(headerList),
    },
  });

  const store = await cookies();
  store.set(env.SESSION_COOKIE_NAME, token, cookieOptions(Math.floor(ttlMs / 1000)));

  return expiresAt;
}

/**
 * Resolve the signed-in user, or null.
 *
 * Expired and orphaned sessions are cleaned up as they are encountered, which
 * keeps the table tidy without a scheduled job.
 */
export async function readSession(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(env.SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  void pruneExpiredSessions();

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      expiresAt: true,
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          isActive: true,
          salesmen: {
            orderBy: { salesman: { name: "asc" } },
            select: { salesman: { select: { id: true, name: true } } },
          },
        },
      },
    },
  });

  if (!session) return null;

  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }

  // A deactivated account keeps its rows but cannot act.
  if (!session.user.isActive) return null;

  const salesmen = session.user.salesmen.map((link) => link.salesman);

  // The cookie is a request for which salesman to act as, never an assertion
  // of one: it only takes effect if it names a salesman this CRE is actually
  // linked to. Anything else falls back to the first.
  const requested = store.get(actingCookieName())?.value;
  const active =
    salesmen.find((salesman) => salesman.id === requested) ?? salesmen[0] ?? null;

  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role,
    salesmen,
    activeSalesmanId: active?.id ?? null,
    activeSalesmanName: active?.name ?? null,
    isActive: session.user.isActive,
  };
}

/**
 * Remember which salesman a CRE is acting for.
 *
 * Validation lives in readSession(), not here: a value written now could stop
 * being valid the moment an admin unassigns the CRE, so the check has to
 * happen on read. This only records the preference.
 */
export async function setActingSalesman(salesmanId: string): Promise<void> {
  const store = await cookies();
  store.set(
    actingCookieName(),
    salesmanId,
    cookieOptions(env.SESSION_TTL_HOURS * 60 * 60),
  );
}

/** Sign out of this device. */
export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(env.SESSION_COOKIE_NAME)?.value;

  if (token) {
    await prisma.session
      .deleteMany({ where: { tokenHash: hashToken(token) } })
      .catch(() => {});
  }
  store.delete(env.SESSION_COOKIE_NAME);
}

/** Sign a user out everywhere. Used after a password reset. */
export async function destroyAllSessions(userId: string): Promise<void> {
  await prisma.session.deleteMany({ where: { userId } });
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

let lastPrune = 0;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Delete every expired session, at most once an hour per process.
 *
 * readSession() already drops an expired row when its own token is presented,
 * but that only ever reaches sessions somebody comes back to. A device that
 * is never used again left its row behind forever, which is why the schema
 * carries an index on expiresAt that nothing was reading. This is the sweep
 * that index was cut for.
 *
 * Fire-and-forget on purpose: it must never delay or fail a request.
 */
export function pruneExpiredSessions(): Promise<void> {
  const now = Date.now();
  if (now - lastPrune < PRUNE_INTERVAL_MS) return Promise.resolve();
  lastPrune = now;

  return prisma.session
    .deleteMany({ where: { expiresAt: { lte: new Date(now) } } })
    .then(() => undefined)
    .catch(() => undefined);
}

/** Best-effort client IP from the proxy headers Hostinger sets. */
function clientIp(headerList: Headers): string | null {
  const forwarded = headerList.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first.slice(0, 60);
  }
  return headerList.get("x-real-ip")?.slice(0, 60) ?? null;
}

export async function requestIp(): Promise<string | null> {
  return clientIp(await headers());
}

/** Constant-time compare for bearer secrets (cron). */
export function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
