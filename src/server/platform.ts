import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { ConflictError, UnauthenticatedError, ValidationError } from "@/lib/errors";
import { hashPassword, validatePassword, verifyPassword } from "@/lib/password";
import { normalizeEmail } from "@/lib/dedupe";
import { audit } from "./audit";

/**
 * Whoever runs this software, as opposed to whoever uses it.
 *
 * The isolation everything else rests on is that a User belongs to one
 * organisation and every query about one is filtered by that, with no branch
 * anywhere that can turn the filter off. A "superadmin" role would put that
 * branch back, and from then on every query ever written would depend on
 * nobody reaching it by accident.
 *
 * So this is a separate identity with its own session cookie, and it reaches
 * customer data by exactly two routes, both of them explicit:
 *
 *   1. The console, whose queries say in their own names that they read
 *      across organisations.
 *   2. Impersonation, which issues an ORDINARY session inside one tenant -
 *      same scope clauses, same permissions - and records who opened it.
 *
 * Nothing in src/server/scope.ts knows this file exists, which is the point.
 */

const TOKEN_BYTES = 32;

export function platformCookieName(): string {
  return `${env.SESSION_COOKIE_NAME}_platform`;
}

function hashToken(token: string): string {
  return createHmac("sha256", env.AUTH_SECRET).update(token).digest("hex");
}

export interface PlatformSessionAdmin {
  id: string;
  email: string;
  name: string;
  mustChangePassword: boolean;
}

// ---------------------------------------------------------------------------
// Signing in
// ---------------------------------------------------------------------------

export async function platformLogin(
  email: string,
  password: string,
): Promise<PlatformSessionAdmin> {
  const normalised = normalizeEmail(email);

  const admin = normalised
    ? await prisma.platformAdmin.findUnique({
        where: { email: normalised },
        select: {
          id: true,
          email: true,
          name: true,
          passwordHash: true,
          isActive: true,
          mustChangePassword: true,
        },
      })
    : null;

  // Same message and roughly the same cost either way, so this cannot be used
  // to find out whether an address runs the platform.
  const valid = admin
    ? await verifyPassword(password, admin.passwordHash)
    : await verifyPassword(password, "scrypt$16384$8$1$AAAA$AAAA");

  if (!admin || !valid || !admin.isActive) {
    throw new ValidationError("That email address and password do not match.");
  }

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const ttlMs = env.SESSION_TTL_HOURS * 60 * 60 * 1000;
  const headerList = await headers();

  await prisma.platformSession.create({
    data: {
      tokenHash: hashToken(token),
      adminId: admin.id,
      expiresAt: new Date(Date.now() + ttlMs),
      userAgent: headerList.get("user-agent")?.slice(0, 300) ?? null,
      ip: headerList.get("x-forwarded-for")?.split(",")[0]?.trim().slice(0, 60) ?? null,
    },
  });

  await prisma.platformAdmin.update({
    where: { id: admin.id },
    data: { lastLoginAt: new Date() },
  });

  const store = await cookies();
  store.set(platformCookieName(), token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.APP_URL.startsWith("https://"),
    path: "/",
    maxAge: Math.floor(ttlMs / 1000),
  });

  return {
    id: admin.id,
    email: admin.email,
    name: admin.name,
    mustChangePassword: admin.mustChangePassword,
  };
}

export async function readPlatformSession(): Promise<PlatformSessionAdmin | null> {
  const store = await cookies();
  const token = store.get(platformCookieName())?.value;
  if (!token) return null;

  const session = await prisma.platformSession.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      expiresAt: true,
      admin: {
        select: {
          id: true,
          email: true,
          name: true,
          isActive: true,
          mustChangePassword: true,
        },
      },
    },
  });
  if (!session) return null;

  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.platformSession.delete({ where: { id: session.id } }).catch(() => {});
    return null;
  }
  if (!session.admin.isActive) return null;

  return {
    id: session.admin.id,
    email: session.admin.email,
    name: session.admin.name,
    mustChangePassword: session.admin.mustChangePassword,
  };
}

export async function requirePlatformAdmin(): Promise<PlatformSessionAdmin> {
  const admin = await readPlatformSession();
  if (!admin) throw new UnauthenticatedError();
  return admin;
}

export async function platformLogout(): Promise<void> {
  const store = await cookies();
  const token = store.get(platformCookieName())?.value;
  if (token) {
    await prisma.platformSession
      .deleteMany({ where: { tokenHash: hashToken(token) } })
      .catch(() => {});
  }
  store.delete(platformCookieName());
}

export async function changePlatformPassword(
  admin: PlatformSessionAdmin,
  current: string,
  next: string,
): Promise<void> {
  const row = await prisma.platformAdmin.findUniqueOrThrow({
    where: { id: admin.id },
    select: { passwordHash: true },
  });
  if (!(await verifyPassword(current, row.passwordHash))) {
    throw new ValidationError("That is not your current password.", {
      current: "Wrong password",
    });
  }
  const problem = validatePassword(next);
  if (problem) throw new ValidationError(problem, { password: problem });

  await prisma.$transaction([
    prisma.platformAdmin.update({
      where: { id: admin.id },
      data: { passwordHash: await hashPassword(next), mustChangePassword: false },
    }),
    // Every other device signs out; this one gets a fresh cookie below.
    prisma.platformSession.deleteMany({ where: { adminId: admin.id } }),
  ]);
}

// ---------------------------------------------------------------------------
// The console
// ---------------------------------------------------------------------------

export interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  isActive: boolean;
  createdAt: Date;
  users: number;
  leads: number;
  orders: number;
  quotations: number;
  ownerEmail: string | null;
}

/**
 * Every workspace on the platform.
 *
 * Named so that it is obvious at the call site that this crosses
 * organisations. It is one of only two things in the codebase that does, and
 * it lives behind a platform session rather than a user one.
 */
export async function listAllWorkspaces(): Promise<WorkspaceRow[]> {
  const orgs = await prisma.organisation.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      slug: true,
      name: true,
      isActive: true,
      createdAt: true,
      _count: { select: { users: true, leads: true, orders: true, quotations: true } },
      users: {
        where: { role: "OWNER" },
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { email: true },
      },
    },
  });

  return orgs.map((org) => ({
    id: org.id,
    slug: org.slug,
    name: org.name,
    isActive: org.isActive,
    createdAt: org.createdAt,
    users: org._count.users,
    leads: org._count.leads,
    orders: org._count.orders,
    quotations: org._count.quotations,
    ownerEmail: org.users[0]?.email ?? null,
  }));
}

export async function setWorkspaceActive(
  admin: PlatformSessionAdmin,
  orgId: string,
  isActive: boolean,
): Promise<void> {
  const org = await prisma.organisation.findUniqueOrThrow({
    where: { id: orgId },
    select: { name: true },
  });

  await prisma.$transaction(async (tx) => {
    await tx.organisation.update({ where: { id: orgId }, data: { isActive } });
    if (!isActive) {
      // Suspending has to take effect now, not when sessions expire.
      await tx.session.deleteMany({ where: { user: { orgId } } });
    }
    await audit(tx, {
      orgId,
      action: isActive ? "workspace.reactivate" : "workspace.suspend",
      actorId: null,
      targetType: "Organisation",
      targetId: orgId,
      detail: `Platform administrator ${admin.name} ${
        isActive ? "reactivated" : "suspended"
      } the ${org.name} workspace`,
    });
  });
}

// ---------------------------------------------------------------------------
// Impersonation
// ---------------------------------------------------------------------------

/**
 * Open a customer's workspace to support them.
 *
 * Issues an ORDINARY session as their owner: same scope clauses, same
 * permissions, same organisation. Support happens inside a tenant rather than
 * through a hole in the boundary, so a bug in the CRM can never widen this.
 *
 * The row records who opened it, which puts a banner on every screen and a
 * line in that workspace's own audit trail - the customer can see that
 * somebody came in, which is the point of writing it there rather than only
 * in a log we keep.
 */
export async function impersonate(
  admin: PlatformSessionAdmin,
  orgId: string,
): Promise<{ token: string; orgName: string; as: string }> {
  const org = await prisma.organisation.findUniqueOrThrow({
    where: { id: orgId },
    select: { id: true, name: true, isActive: true },
  });
  if (!org.isActive) {
    throw new ConflictError(
      "That workspace is suspended. Reactivate it before opening it.",
    );
  }

  const owner = await prisma.user.findFirst({
    where: { orgId, role: "OWNER", isActive: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });
  if (!owner) {
    throw new ConflictError(
      `${org.name} has no active owner account to open it as.`,
    );
  }

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const headerList = await headers();

  await prisma.$transaction(async (tx) => {
    await tx.session.create({
      data: {
        tokenHash: hashToken(token),
        userId: owner.id,
        // Short: this is a support visit, not a login.
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        userAgent: headerList.get("user-agent")?.slice(0, 300) ?? null,
        impersonatedById: admin.id,
      },
    });
    await audit(tx, {
      orgId,
      action: "workspace.impersonate",
      actorId: null,
      targetType: "Organisation",
      targetId: orgId,
      detail: `Platform administrator ${admin.name} (${admin.email}) opened this workspace as ${owner.name}`,
    });
  });

  const store = await cookies();
  store.set(env.SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.APP_URL.startsWith("https://"),
    path: "/",
    maxAge: 3600,
  });

  return { token, orgName: org.name, as: owner.name };
}

/** Constant-time compare, for anywhere a platform secret is checked. */
export function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
