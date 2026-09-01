import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  canClose,
  derivePaymentState,
  orderMoney,
  summarise,
} from "@/server/order-state";

/**
 * There is no paymentState column anywhere in the schema. The only truth is
 * the sum of the Payment rows, which is what lets a deleted payment walk an
 * order back from PAID to PARTIAL on its own. These tests pin that fold down.
 */

const ORDER = 100_000; // 1000 rupees in paise

describe("derivePaymentState", () => {
  test("nothing received is UNPAID", () => {
    assert.equal(derivePaymentState(ORDER, 0), "UNPAID");
  });

  test("something short of the total is PARTIAL", () => {
    assert.equal(derivePaymentState(ORDER, 1), "PARTIAL");
    assert.equal(derivePaymentState(ORDER, ORDER - 1), "PARTIAL");
  });

  test("the exact total is PAID", () => {
    assert.equal(derivePaymentState(ORDER, ORDER), "PAID");
  });

  test("an overshoot still reads as PAID rather than something impossible", () => {
    // recordPayment refuses to create this, but the fold must not produce a
    // fourth state if a row is ever adjusted by hand.
    assert.equal(derivePaymentState(ORDER, ORDER + 500), "PAID");
  });
});

describe("orderMoney", () => {
  test("folds the payment rows into the money view", () => {
    const money = orderMoney(ORDER, [
      { amountPaise: 30_000 },
      { amountPaise: 20_000 },
    ]);
    assert.equal(money.amountPaise, ORDER);
    assert.equal(money.receivedPaise, 50_000);
    assert.equal(money.duePaise, 50_000);
    assert.equal(money.paymentState, "PARTIAL");
    assert.equal(money.percentReceived, 50);
  });

  test("reads the BigInt columns the database actually returns", () => {
    const money = orderMoney(BigInt(ORDER), [{ amountPaise: BigInt(100_000) }]);
    assert.equal(money.paymentState, "PAID");
    assert.equal(money.duePaise, 0);
  });

  test("no payments at all is UNPAID with everything due", () => {
    const money = orderMoney(ORDER, []);
    assert.equal(money.receivedPaise, 0);
    assert.equal(money.duePaise, ORDER);
    assert.equal(money.paymentState, "UNPAID");
    assert.equal(money.percentReceived, 0);
  });

  test("deleting a payment walks the order back from PAID to PARTIAL", () => {
    const payments = [{ amountPaise: 60_000 }, { amountPaise: 40_000 }];
    assert.equal(orderMoney(ORDER, payments).paymentState, "PAID");

    // Same order, one payment removed. Nothing was written to undo this.
    assert.equal(orderMoney(ORDER, payments.slice(0, 1)).paymentState, "PARTIAL");
  });
});

describe("summarise", () => {
  test("due never goes negative", () => {
    assert.equal(summarise(ORDER, ORDER + 5_000).duePaise, 0);
  });

  test("percent is clamped to 100 and rounded", () => {
    assert.equal(summarise(ORDER, ORDER * 2).percentReceived, 100);
    assert.equal(summarise(300, 100).percentReceived, 33);
  });

  test("a zero-value order does not divide by zero", () => {
    assert.equal(summarise(0, 0).percentReceived, 0);
  });
});

describe("canClose", () => {
  test("an order may be closed only when nothing is due", () => {
    assert.equal(canClose(summarise(ORDER, ORDER)), true);
    assert.equal(canClose(summarise(ORDER, ORDER - 1)), false);
    assert.equal(canClose(summarise(ORDER, 0)), false);
  });

  test("a zero-value order cannot be closed, even though nothing is due", () => {
    // Otherwise an order raised by mistake at zero would look complete.
    assert.equal(canClose(summarise(0, 0)), false);
  });
});
