import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  TEST_DB,
  assertSchema,
  disconnect,
  linkCre,
  makeLead,
  makeOrder,
  makeUser,
  resetDatabase,
  sessionFor,
  skipWithoutDb,
} from "../helpers/db";
import { deleteUser, previewDeletion } from "@/server/users";
import { prisma } from "@/lib/db";

/**
 * Deleting a user moves their work; it never destroys it.
 *
 * The whole thing is one transaction that re-counts what still points at the
 * deleted account before committing, and throws - rolling everything back - if
 * anything is left. That rollback is the part worth testing: it is the
 * difference between refusing and orphaning, and it cannot be observed without
 * a database.
 */

describe("deleteUser", { skip: skipWithoutDb }, () => {
  before(async () => {
    assert.ok(TEST_DB);
    await assertSchema();
  });
  beforeEach(resetDatabase);
  after(disconnect);

  test("deleting a salesman moves leads, orders and CREs to the named one", async () => {
    const admin = await makeUser("ADMIN");
    const leaving = await makeUser("SALESMAN");
    const receiving = await makeUser("SALESMAN");
    const cre = await makeUser("CRE");
    await linkCre(cre.id, leaving.id);

    const lead = await makeLead({ ownerId: leaving.id });
    const order = await makeOrder(leaving.id, 50_000, { creId: cre.id });

    await deleteUser(await sessionFor(admin.id), leaving.id, {
      transferToId: receiving.id,
    });

    assert.equal(
      (await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).ownerId,
      receiving.id,
    );
    const movedOrder = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    assert.equal(movedOrder.salesmanId, receiving.id);
    // The CRE moves with the work, so they keep serving the same order.
    assert.equal(movedOrder.creId, cre.id);
    assert.equal(
      await prisma.creSalesman.count({
        where: { creId: cre.id, salesmanId: receiving.id },
      }),
      1,
    );
    assert.equal(await prisma.user.count({ where: { id: leaving.id } }), 0);
  });

  test("stage is preserved verbatim, not normalised", async () => {
    const admin = await makeUser("ADMIN");
    const leaving = await makeUser("SALESMAN");
    const receiving = await makeUser("SALESMAN");
    const cre = await makeUser("CRE");
    await linkCre(cre.id, leaving.id);
    const order = await makeOrder(leaving.id, 50_000, { creId: cre.id });

    await deleteUser(await sessionFor(admin.id), leaving.id, {
      transferToId: receiving.id,
    });

    // An order that was WITH_CRE stays WITH_CRE. The order page flags it as
    // awaiting re-handover rather than quietly rewriting the stage.
    assert.equal(
      (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).stage,
      "WITH_CRE",
    );
  });

  test("deleting a CRE frees their orders without moving the salesman", async () => {
    const admin = await makeUser("ADMIN");
    const salesman = await makeUser("SALESMAN");
    const cre = await makeUser("CRE");
    await linkCre(cre.id, salesman.id);
    const order = await makeOrder(salesman.id, 50_000, { creId: cre.id });

    await deleteUser(await sessionFor(admin.id), cre.id);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(after.creId, null, "the order loses its CRE");
    assert.equal(
      after.salesmanId,
      salesman.id,
      "the salesman it was credited to must not change",
    );
  });

  test("a salesman holding work cannot be deleted without naming a destination", async () => {
    const admin = await makeUser("ADMIN");
    const leaving = await makeUser("SALESMAN");
    const lead = await makeLead({ ownerId: leaving.id });

    const session = await sessionFor(admin.id);
    await assert.rejects(() => deleteUser(session, leaving.id));

    // Nothing moved, and the account is still there.
    assert.equal(
      (await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).ownerId,
      leaving.id,
    );
    assert.equal(await prisma.user.count({ where: { id: leaving.id } }), 1);
  });

  test("the owner account cannot be deleted", async () => {
    const owner = await makeUser("OWNER");
    const admin = await makeUser("ADMIN");

    const session = await sessionFor(admin.id);
    await assert.rejects(() => deleteUser(session, owner.id));
    assert.equal(await prisma.user.count({ where: { id: owner.id } }), 1);
  });

  test("a payment history survives its salesman being deleted", async () => {
    const admin = await makeUser("ADMIN");
    const leaving = await makeUser("SALESMAN");
    const receiving = await makeUser("SALESMAN");
    const order = await makeOrder(leaving.id, 50_000);
    await prisma.payment.create({
      data: { orderId: order.id, amountPaise: 20_000n, mode: "UPI" },
    });

    await deleteUser(await sessionFor(admin.id), leaving.id, {
      transferToId: receiving.id,
    });

    const payments = await prisma.payment.findMany({ where: { orderId: order.id } });
    assert.equal(payments.length, 1);
    assert.equal(Number(payments[0]?.amountPaise), 20_000);
  });

  test("every deletion writes an audit row inside the same transaction", async () => {
    const admin = await makeUser("ADMIN");
    const leaving = await makeUser("SALESMAN");
    const receiving = await makeUser("SALESMAN");
    await makeLead({ ownerId: leaving.id });

    await deleteUser(await sessionFor(admin.id), leaving.id, {
      transferToId: receiving.id,
    });

    const events = await prisma.auditEvent.findMany({
      where: { action: "user.delete", targetId: leaving.id },
    });
    assert.equal(events.length, 1);
    assert.match(events[0]!.detail, /moved to/);
  });

  test("a refused deletion leaves no audit row behind", async () => {
    const admin = await makeUser("ADMIN");
    const leaving = await makeUser("SALESMAN");
    await makeLead({ ownerId: leaving.id });

    const session = await sessionFor(admin.id);
    await assert.rejects(() => deleteUser(session, leaving.id));

    // The audit write is inside the transaction, so a rollback takes it too.
    assert.equal(
      await prisma.auditEvent.count({ where: { targetId: leaving.id } }),
      0,
    );
  });

  test("previewDeletion counts what deleteUser would actually move", async () => {
    const admin = await makeUser("ADMIN");
    const leaving = await makeUser("SALESMAN");
    const cre = await makeUser("CRE");
    await linkCre(cre.id, leaving.id);
    await makeLead({ ownerId: leaving.id });
    await makeLead({ ownerId: leaving.id });
    await makeOrder(leaving.id, 10_000);

    const preview = await previewDeletion(await sessionFor(admin.id), leaving.id);

    assert.equal(preview.moving.leads, 2);
    assert.equal(preview.moving.orders, 1);
    assert.equal(preview.moving.cres, 1);
  });
});
