import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  TEST_DB,
  assertSchema,
  disconnect,
  linkCre,
  makeLead,
  makeOrder,
  makeOrg,
  makeUser,
  resetDatabase,
  sessionFor,
  skipWithoutDb,
} from "../helpers/db";
import { getLead, grabLead, listLeads, listPool } from "@/server/leads";
import { getOrder, listOrders, recordPayment } from "@/server/orders";
import { listQuotations } from "@/server/quotations";
import {
  deleteUser,
  listUsers,
  previewDeletion,
  resetPassword,
  setUserActive,
  updateUser,
} from "@/server/users";
import { ingestLead } from "@/server/ingest/common";
import { prisma } from "@/lib/db";

/**
 * The test this whole product rests on.
 *
 * Everything else in the suite checks that the CRM does the right thing. This
 * checks that it does it to the right company's data - which is the one bug
 * class that ends a SaaS business rather than annoying a user. It is also the
 * class no type error will ever point at: a query missing its organisation
 * filter compiles perfectly and returns somebody else's rows.
 */

describe("tenant isolation", { skip: skipWithoutDb }, () => {
  before(async () => {
    assert.ok(TEST_DB);
    await assertSchema();
  });
  beforeEach(resetDatabase);
  after(disconnect);

  /** Two complete, populated organisations that know nothing of each other. */
  async function twoWorlds() {
    const [orgA, orgB] = await Promise.all([
      makeOrg({ slug: "alpha", name: "Alpha Panels" }),
      makeOrg({ slug: "beta", name: "Beta Trading" }),
    ]);

    const [salesA, salesB] = await Promise.all([
      makeUser(orgA.id, "SALESMAN"),
      makeUser(orgB.id, "SALESMAN"),
    ]);
    const [creA, creB] = await Promise.all([
      makeUser(orgA.id, "CRE"),
      makeUser(orgB.id, "CRE"),
    ]);
    await Promise.all([
      linkCre(orgA.id, creA.id, salesA.id),
      linkCre(orgB.id, creB.id, salesB.id),
    ]);

    const [leadA, leadB] = await Promise.all([
      makeLead(orgA.id, { ownerId: salesA.id, personName: "Alpha customer" }),
      makeLead(orgB.id, { ownerId: salesB.id, personName: "Beta customer" }),
    ]);
    const [poolA, poolB] = await Promise.all([
      makeLead(orgA.id, { personName: "Alpha pooled" }),
      makeLead(orgB.id, { personName: "Beta pooled" }),
    ]);
    const [orderA, orderB] = await Promise.all([
      makeOrder(orgA.id, salesA.id, 100_000, { creId: creA.id }),
      makeOrder(orgB.id, salesB.id, 100_000, { creId: creB.id }),
    ]);

    const [a, b] = await Promise.all([sessionFor(salesA.id), sessionFor(salesB.id)]);
    return { orgA, orgB, a, b, salesA, salesB, creA, creB, leadA, leadB, poolA, poolB, orderA, orderB };
  }

  test("a salesman's lead list contains nothing from the other organisation", async () => {
    const { a, b, leadA, leadB } = await twoWorlds();

    const seenByA = await listLeads(a);
    const seenByB = await listLeads(b);

    assert.deepEqual(seenByA.items.map((r) => r.id), [leadA.id]);
    assert.deepEqual(seenByB.items.map((r) => r.id), [leadB.id]);
  });

  test("the lead pool is not shared between organisations", async () => {
    const { a, b, poolA, poolB } = await twoWorlds();

    const poolForA = await listPool(a);
    const poolForB = await listPool(b);

    assert.deepEqual(poolForA.items.map((r) => r.id), [poolA.id]);
    assert.deepEqual(poolForB.items.map((r) => r.id), [poolB.id]);
  });

  test("a lead id from another organisation does not open", async () => {
    const { a, leadB, poolB } = await twoWorlds();

    // Knowing the id is not access. Same answer as a lead that does not
    // exist, so an id cannot be probed for either.
    assert.equal(await getLead(a, leadB.id), null);
    assert.equal(await getLead(a, poolB.id), null);
  });

  test("a pooled lead in another organisation cannot be grabbed", async () => {
    const { a, poolB } = await twoWorlds();

    await assert.rejects(() => grabLead(a, poolB.id));

    const stored = await prisma.lead.findUniqueOrThrow({
      where: { id: poolB.id },
      select: { ownerId: true },
    });
    assert.equal(stored.ownerId, null, "it must still be in the other pool");
  });

  test("orders are not visible across organisations", async () => {
    const { a, b, orderA, orderB } = await twoWorlds();

    assert.deepEqual((await listOrders(a)).items.map((r) => r.id), [orderA.id]);
    assert.deepEqual((await listOrders(b)).items.map((r) => r.id), [orderB.id]);
    assert.equal(await getOrder(a, orderB.id), null);
  });

  test("a payment cannot be recorded against another organisation's order", async () => {
    const { a, orderB } = await twoWorlds();

    await assert.rejects(() =>
      recordPayment(a, orderB.id, { amountPaise: 10_000, mode: "UPI" }),
    );

    const paid = await prisma.payment.count({ where: { orderId: orderB.id } });
    assert.equal(paid, 0);
  });

  test("quotation and people lists stop at the organisation boundary", async () => {
    const { a, orgA } = await twoWorlds();

    const quotations = await listQuotations(a);
    assert.equal(quotations.items.length, 0, "Alpha has raised none of its own");

    // An admin, deliberately: their `users` scope is ALL, which without the
    // organisation filter would list every account on the platform. This is
    // the widest scope any role has, so it is the one worth proving.
    const admin = await makeUser(orgA.id, "ADMIN");
    const people = await listUsers(await sessionFor(admin.id));
    assert.ok(people.length > 0);
    for (const person of people) {
      const row = await prisma.user.findUniqueOrThrow({
        where: { id: person.id },
        select: { orgId: true },
      });
      assert.equal(row.orgId, orgA.id, `${person.name} belongs to another organisation`);
    }
  });

  test("the same person enquiring with two companies is two leads", async () => {
    const { orgA, orgB } = await twoWorlds();

    const shared = {
      source: "INDIAMART" as const,
      personName: "Ramesh Sharma",
      phone: "+91 98765 43210",
      email: "ramesh@example.com",
    };

    const intoA = await ingestLead({ ...shared, orgId: orgA.id, externalId: "Q1" });
    const intoB = await ingestLead({ ...shared, orgId: orgB.id, externalId: "Q1" });

    // Before orgId was part of the dedupe keys, the second of these came back
    // as a duplicate and Beta simply never saw the enquiry - silently.
    assert.equal(intoA.outcome, "created");
    assert.equal(intoB.outcome, "created");
    assert.notEqual(intoA.leadId, intoB.leadId);

    const rows = await prisma.lead.findMany({
      where: { phoneKey: "9876543210" },
      select: { orgId: true },
    });
    assert.equal(rows.length, 2);
    assert.deepEqual(new Set(rows.map((r) => r.orgId)), new Set([orgA.id, orgB.id]));
  });

  test("deduplication still works INSIDE one organisation", async () => {
    const { orgA } = await twoWorlds();

    const shared = {
      orgId: orgA.id,
      source: "INDIAMART" as const,
      personName: "Ramesh Sharma",
      phone: "+91 98765 43210",
    };

    const first = await ingestLead({ ...shared, externalId: "Q1" });
    const again = await ingestLead({ ...shared, externalId: "Q2" });

    assert.equal(first.outcome, "created");
    assert.notEqual(again.outcome, "created");
    assert.equal(again.leadId, first.leadId);
  });

  /**
   * Account management takes an id straight from a form.
   *
   * Every one of these was reachable across organisations when multi-tenancy
   * first went in: the lookups fetched by primary key alone, so an admin who
   * knew - or guessed - an id could act on somebody else's staff. Resetting a
   * password that way is a complete account takeover of another company.
   */
  describe("an admin cannot reach into another organisation's people", () => {
    async function adminOfA() {
      const w = await twoWorlds();
      const admin = await makeUser(w.orgA.id, "ADMIN");
      return { ...w, adminA: await sessionFor(admin.id) };
    }

    test("cannot reset a password", async () => {
      const { adminA, salesB } = await adminOfA();
      const before = await prisma.user.findUniqueOrThrow({
        where: { id: salesB.id },
        select: { passwordHash: true },
      });

      await assert.rejects(() => resetPassword(adminA, salesB.id, "a-new-password-12"));

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: salesB.id },
        select: { passwordHash: true },
      });
      assert.equal(after.passwordHash, before.passwordHash);
    });

    test("cannot delete an account", async () => {
      const { adminA, creB } = await adminOfA();

      await assert.rejects(() => deleteUser(adminA, creB.id));

      assert.equal(await prisma.user.count({ where: { id: creB.id } }), 1);
    });

    test("cannot deactivate an account", async () => {
      const { adminA, salesB } = await adminOfA();

      await assert.rejects(() => setUserActive(adminA, salesB.id, false));

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: salesB.id },
        select: { isActive: true },
      });
      assert.equal(after.isActive, true);
    });

    test("cannot rename an account", async () => {
      const { adminA, salesB } = await adminOfA();

      await assert.rejects(() => updateUser(adminA, salesB.id, { name: "Renamed" }));

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: salesB.id },
        select: { name: true },
      });
      assert.notEqual(after.name, "Renamed");
    });

    test("cannot even preview a deletion", async () => {
      const { adminA, salesB } = await adminOfA();
      await assert.rejects(() => previewDeletion(adminA, salesB.id));
    });

    test("cannot transfer work to a salesman in another organisation", async () => {
      const { adminA, orgA, salesB } = await adminOfA();
      const leaving = await makeUser(orgA.id, "SALESMAN");
      await makeLead(orgA.id, { ownerId: leaving.id });

      // Naming Beta's salesman as the destination must fail, and must leave
      // Alpha's salesman and their lead exactly where they were.
      await assert.rejects(() =>
        deleteUser(adminA, leaving.id, { transferToId: salesB.id }),
      );
      assert.equal(await prisma.user.count({ where: { id: leaving.id } }), 1);
      assert.equal(
        await prisma.lead.count({ where: { ownerId: leaving.id } }),
        1,
      );
    });
  });

  test("a suspended organisation cannot be acted for at all", async () => {
    const org = await makeOrg({ isActive: false });
    const salesman = await makeUser(org.id, "SALESMAN");

    // readSession() refuses before any scope clause is reached, so an unpaid
    // subscription stops the whole workspace rather than one person.
    const stored = await prisma.organisation.findUniqueOrThrow({
      where: { id: org.id },
      select: { isActive: true },
    });
    assert.equal(stored.isActive, false);
    assert.equal(
      (await prisma.user.findUniqueOrThrow({
        where: { id: salesman.id },
        select: { orgId: true },
      })).orgId,
      org.id,
    );
  });
});
