import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  TEST_DB,
  assertSchema,
  disconnect,
  linkCre,
  makeOrder,
  makeOrg,
  makeUser,
  receivedPaise,
  resetDatabase,
  sessionFor,
  skipWithoutDb,
} from "../helpers/db";
import { closeOrder, deletePayment, recordPayment } from "@/server/orders";
import { prisma } from "@/lib/db";

/**
 * recordPayment takes `SELECT ... FOR UPDATE` on the order row before it sums
 * the existing payments. Without that lock, two CREs recording the last two
 * part-payments at the same instant both read the old sum and together
 * overshoot the order.
 *
 * That is a claim about row locking in Postgres. It cannot be tested anywhere
 * else, and it is the one bug in this codebase that would silently take money
 * it should have refused.
 */

const ORDER_VALUE = 100_000; // 1000 rupees in paise

describe("recordPayment, under contention", { skip: skipWithoutDb }, () => {
  before(async () => {
    assert.ok(TEST_DB);
    await assertSchema();
  });
  // A fresh organisation per test. Every row in the schema names one now,
  // so there is no such thing as a fixture that belongs to nobody.
  let org: { id: string };
  beforeEach(async () => {
    await resetDatabase();
    org = await makeOrg();
  });
  after(disconnect);

  /**
   * The two people who can genuinely collide on one order.
   *
   * Not two CREs: a CRE's order scope is ASSIGNED, which is `creId = me`, so
   * only the CRE actually holding an order can touch it. The real race is the
   * CRE who holds it and the salesman it is credited to - the salesman keeps
   * payment.record on their own orders - both recording the same cheque.
   */
  async function bothPartiesOnOneOrder(amountPaise = ORDER_VALUE) {
    const salesman = await makeUser(org.id, "SALESMAN");
    const cre = await makeUser(org.id, "CRE");
    await linkCre(org.id, cre.id, salesman.id);
    const order = await makeOrder(org.id, salesman.id, amountPaise, { creId: cre.id });
    const [a, b] = await Promise.all([sessionFor(cre.id), sessionFor(salesman.id)]);
    return { order, a, b, salesman, cre };
  }

  test("two payments that would together overshoot: one is refused", async () => {
    const { order, a, b } = await bothPartiesOnOneOrder();

    // 600 + 600 = 1200 against an order of 1000.
    const results = await Promise.allSettled([
      recordPayment(a, order.id, { amountPaise: 60_000, mode: "UPI" }),
      recordPayment(b, order.id, { amountPaise: 60_000, mode: "UPI" }),
    ]);

    const accepted = results.filter((r) => r.status === "fulfilled").length;
    assert.equal(accepted, 1, "the second payment must be refused, not queued");
    assert.equal(await receivedPaise(order.id), 60_000);
  });

  test("the received total can never exceed the order value, at any concurrency", async () => {
    const { order, a, b } = await bothPartiesOnOneOrder();

    // Ten attempts at a quarter of the order each. At most four can fit.
    const attempts = Array.from({ length: 10 }, (_, i) =>
      recordPayment(i % 2 === 0 ? a : b, order.id, {
        amountPaise: 25_000,
        mode: "CASH",
      }),
    );
    const results = await Promise.allSettled(attempts);

    const total = await receivedPaise(order.id);
    assert.ok(
      total <= ORDER_VALUE,
      `received ${total} against an order of ${ORDER_VALUE}`,
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, total / 25_000);
  });

  test("concurrent part-payments that fit are all accepted", async () => {
    const { order, a, b } = await bothPartiesOnOneOrder();

    const results = await Promise.allSettled([
      recordPayment(a, order.id, { amountPaise: 30_000, mode: "UPI" }),
      recordPayment(b, order.id, { amountPaise: 20_000, mode: "CHEQUE" }),
    ]);

    assert.equal(results.filter((r) => r.status === "rejected").length, 0);
    assert.equal(await receivedPaise(order.id), 50_000);
  });

  test("payment state is derived: deleting one walks a PAID order back", async () => {
    const { order, a } = await bothPartiesOnOneOrder();

    await recordPayment(a, order.id, { amountPaise: 60_000, mode: "UPI" });
    await recordPayment(a, order.id, { amountPaise: 40_000, mode: "UPI" });
    assert.equal(await receivedPaise(order.id), ORDER_VALUE);

    // Nothing is due, so it can be closed.
    await closeOrder(a, order.id);
    assert.equal(
      (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).stage,
      "CLOSED",
    );

    const last = await prisma.payment.findFirstOrThrow({
      where: { orderId: order.id },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    // Deleting a payment is deliberately not a CRE's to do - they record
    // money, they do not unrecord it. An admin undoes a mis-entry.
    const admin = await sessionFor((await makeUser(org.id, "ADMIN")).id);
    await deletePayment(admin, last.id);

    // The order walks back on its own: there is no paymentState column to fix.
    assert.equal(await receivedPaise(order.id), 60_000);
    const reopened = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { stage: true, closedAt: true },
    });
    assert.notEqual(reopened.stage, "CLOSED", "deleting a payment must reopen it");
    assert.equal(reopened.closedAt, null);
  });

  test("an order cannot be closed while anything is due", async () => {
    const { order, a } = await bothPartiesOnOneOrder();
    await recordPayment(a, order.id, { amountPaise: 99_999, mode: "UPI" });

    await assert.rejects(() => closeOrder(a, order.id));
  });

  test("a CRE working for the same salesman still cannot record on an order they do not hold", async () => {
    // ASSIGNED means `creId = me`, not "anything my salesman owns". This is
    // the property the two-CRE race does not exist because of.
    const { order, salesman } = await bothPartiesOnOneOrder();
    const stranger = await makeUser(org.id, "CRE");
    await linkCre(org.id, stranger.id, salesman.id);

    const session = await sessionFor(stranger.id);
    await assert.rejects(() =>
      recordPayment(session, order.id, { amountPaise: 1_000, mode: "CASH" }),
    );
    assert.equal(await receivedPaise(order.id), 0);
  });
});
