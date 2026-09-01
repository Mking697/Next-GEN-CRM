import { prisma } from "@/lib/db";
import { hashPasswordWith } from "@/lib/password-core";
import type { SessionUser } from "@/lib/session";
import type { Role } from "@/generated/prisma/enums";

/**
 * Support for the integration tests.
 *
 * These run the real server functions against a real Postgres, because the
 * things they exist to prove - that two salesmen cannot both grab one lead,
 * that two payments cannot together overshoot an order, that deleting a user
 * moves their work or refuses - are properties of the database, not of the
 * TypeScript. A mock would agree with whatever the code does today, which is
 * the opposite of what a test is for.
 */

/**
 * These suites share one database and TRUNCATE it between tests, so the test
 * script runs files with --test-concurrency=1. Node runs test FILES in
 * parallel by default, which had one file's truncate deleting another file's
 * fixtures mid-test and producing foreign key violations that looked like
 * bugs in the code under test.
 */

/** Integration tests are skipped unless a throwaway database is named. */
export const TEST_DB = process.env.TEST_DATABASE_URL ?? null;

export const skipWithoutDb = TEST_DB
  ? false
  : "set TEST_DATABASE_URL to a throwaway Postgres to run this (see README)";

/**
 * Every table, in an order that does not matter because this is one statement.
 *
 * TRUNCATE ... CASCADE rather than deleteMany per model: it is one round trip,
 * it resets regardless of foreign keys, and it cannot leave a half-cleaned
 * database behind if a test fails midway.
 */
const TABLES = [
  "Organisation",
  "AuditEvent",
  "Payment",
  "Order",
  "QuotationItem",
  "QuotationRevision",
  "Quotation",
  "LeadActivity",
  "Lead",
  "Contact",
  "Company",
  "CreSalesman",
  "Session",
  "SyncState",
  "User",
];

export async function resetDatabase(): Promise<void> {
  const list = TABLES.map((t) => `"${t}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/**
 * Fail loudly and usefully when the schema is missing, rather than letting
 * every test fail with the same opaque "relation does not exist".
 */
export async function assertSchema(): Promise<void> {
  try {
    await prisma.user.count();
  } catch (error) {
    throw new Error(
      "The test database has no schema. Run:\n" +
        "  DIRECT_DATABASE_URL=$TEST_DATABASE_URL npx prisma migrate deploy\n" +
        `Underlying error: ${(error as Error).message}`,
    );
  }
}

let counter = 0;
const unique = () => `${Date.now().toString(36)}${(counter += 1)}`;

/**
 * A tenant. Tests that only need one still make one, because every row in the
 * schema now has to name an organisation.
 */
export async function makeOrg(
  overrides: { slug?: string; name?: string; isActive?: boolean } = {},
): Promise<{ id: string; slug: string; name: string }> {
  const id = unique();
  return prisma.organisation.create({
    data: {
      slug: overrides.slug ?? `org-${id}`,
      name: overrides.name ?? `Org ${id}`,
      isActive: overrides.isActive ?? true,
    },
    select: { id: true, slug: true, name: true },
  });
}

export async function makeUser(
  orgId: string,
  role: Role,
  overrides: { name?: string; email?: string; isActive?: boolean } = {},
): Promise<{ id: string; name: string; email: string; role: Role; orgId: string }> {
  const id = unique();
  const user = await prisma.user.create({
    data: {
      orgId,
      email: overrides.email ?? `${role.toLowerCase()}-${id}@test.local`,
      name: overrides.name ?? `${role} ${id}`,
      role,
      isActive: overrides.isActive ?? true,
      passwordHash: await hashPasswordWith("x".repeat(32), "password-for-tests"),
    },
    select: { id: true, name: true, email: true, role: true, orgId: true },
  });
  return user;
}

/** Link a CRE to a salesman, the way an admin would. */
export async function linkCre(
  orgId: string,
  creId: string,
  salesmanId: string,
): Promise<void> {
  await prisma.creSalesman.create({ data: { orgId, creId, salesmanId } });
}

/**
 * The session shape the server functions take.
 *
 * Built from the database rather than by hand, so a test cannot accidentally
 * assert against a session that readSession() would never produce - in
 * particular an activeSalesmanId naming somebody this CRE does not work for.
 */
export async function sessionFor(userId: string): Promise<SessionUser> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      org: { select: { id: true, name: true, slug: true } },
      salesmen: {
        orderBy: { salesman: { name: "asc" } },
        select: { salesman: { select: { id: true, name: true } } },
      },
    },
  });
  const salesmen = user.salesmen.map((link) => link.salesman);
  return {
    id: user.id,
    orgId: user.org.id,
    orgName: user.org.name,
    orgSlug: user.org.slug,
    email: user.email,
    name: user.name,
    role: user.role,
    isActive: user.isActive,
    salesmen,
    activeSalesmanId: salesmen[0]?.id ?? null,
    activeSalesmanName: salesmen[0]?.name ?? null,
  };
}

export async function makeLead(
  orgId: string,
  overrides: { ownerId?: string | null; personName?: string; phone?: string } = {},
): Promise<{ id: string }> {
  const id = unique();
  return prisma.lead.create({
    data: {
      orgId,
      source: "MANUAL",
      personName: overrides.personName ?? `Lead ${id}`,
      phone: overrides.phone ?? null,
      ownerId: overrides.ownerId ?? null,
      grabbedAt: overrides.ownerId ? new Date() : null,
    },
    select: { id: true },
  });
}

/** A company, an order and nothing else - enough to record payments against. */
export async function makeOrder(
  orgId: string,
  salesmanId: string,
  amountPaise: number,
  overrides: { creId?: string | null } = {},
): Promise<{ id: string; orderNo: string }> {
  const id = unique();
  const company = await prisma.company.create({
    data: { orgId, name: `Client ${id}`, salesmanId },
    select: { id: true },
  });
  return prisma.order.create({
    data: {
      orgId,
      orderNo: `ORD-TEST-${id}`,
      companyId: company.id,
      salesmanId,
      creId: overrides.creId ?? null,
      handedOverAt: overrides.creId ? new Date() : null,
      stage: overrides.creId ? "WITH_CRE" : "CONFIRMED",
      amountPaise: BigInt(amountPaise),
    },
    select: { id: true, orderNo: true },
  });
}

export async function receivedPaise(orderId: string): Promise<number> {
  const aggregate = await prisma.payment.aggregate({
    where: { orderId },
    _sum: { amountPaise: true },
  });
  return Number(aggregate._sum.amountPaise ?? 0n);
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
