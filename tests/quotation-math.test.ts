import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  FormulaError,
  QTY_SCALE,
  QuantityParseError,
  computeTotals,
  emptyRow,
  evaluateFormula,
  formatQtyMilli,
  formatQuantityTotals,
  isRowEmpty,
  lineAmountPaise,
  looksLikeFormula,
  parseQtyToMilli,
  parseRateToPaise,
  previewAmountPaise,
  quantityTotals,
} from "@/lib/quotation-math";
import { MoneyParseError } from "@/lib/money";

describe("parseQtyToMilli", () => {
  test("scales to thousandths", () => {
    assert.equal(parseQtyToMilli("123.45"), 123_450);
    assert.equal(parseQtyToMilli("1"), QTY_SCALE);
    assert.equal(parseQtyToMilli("0.001"), 1);
  });

  test("blank is zero, not an error - an empty grid cell is legal", () => {
    assert.equal(parseQtyToMilli(""), 0);
    assert.equal(parseQtyToMilli("   "), 0);
  });

  test("rejects a fourth decimal rather than rounding it away", () => {
    assert.throws(() => parseQtyToMilli("1.2345"), QuantityParseError);
  });

  test("rejects a quantity too large to be a real order", () => {
    assert.throws(() => parseQtyToMilli("2000000000"), QuantityParseError);
  });

  test("rejects negatives and junk", () => {
    for (const bad of ["-1", "abc", "1.2.3", "1e5"]) {
      assert.throws(
        () => parseQtyToMilli(bad),
        QuantityParseError,
        `expected ${bad} to be rejected`,
      );
    }
  });
});

describe("formatQtyMilli", () => {
  test("round-trips and trims trailing zeros", () => {
    assert.equal(formatQtyMilli(123_450), "123.45");
    assert.equal(formatQtyMilli(5_000), "5");
    assert.equal(formatQtyMilli(0), "0");
    assert.equal(formatQtyMilli(1), "0.001");
  });
});

describe("lineAmountPaise", () => {
  test("rounds exactly once, on the way back to whole paise", () => {
    // 1.5 units at 10.01 rupees = 15.015 rupees -> 1501.5 paise -> 1502.
    assert.equal(lineAmountPaise(1_500, 1_001), 1_502);
  });

  test("is exact for whole quantities", () => {
    assert.equal(lineAmountPaise(3_000, 125_000), 375_000);
  });

  test("throws rather than returning an inexact product", () => {
    assert.throws(
      () => lineAmountPaise(1_000_000_000, Number.MAX_SAFE_INTEGER),
      QuantityParseError,
    );
  });
});

describe("parseRateToPaise", () => {
  test("blank means zero, not an error", () => {
    assert.equal(parseRateToPaise(""), 0);
  });

  test("shares the money parser, so the same rules apply", () => {
    assert.equal(parseRateToPaise("1,250.50"), 125_050);
    assert.throws(() => parseRateToPaise("1.005"), MoneyParseError);
  });
});

describe("computeTotals", () => {
  test("charges GST on goods PLUS freight - the composite-supply rule", () => {
    const totals = computeTotals([{ amountPaise: 100_000 }], 10_000, 18);
    assert.equal(totals.subTotalPaise, 100_000);
    assert.equal(totals.freightPaise, 10_000);
    // The base is goods + freight, not goods alone.
    assert.equal(totals.gstBasePaise, 110_000);
    assert.equal(totals.gstPaise, 19_800);
    assert.equal(totals.payablePaise, 129_800);
  });

  test("payable is always base plus GST", () => {
    const totals = computeTotals(
      [{ amountPaise: 33_333 }, { amountPaise: 66_667 }],
      1_234,
      5,
    );
    assert.equal(totals.subTotalPaise, 100_000);
    assert.equal(totals.payablePaise, totals.gstBasePaise + totals.gstPaise);
  });

  test("clamps a nonsense percentage and a negative freight", () => {
    assert.equal(computeTotals([], -500, 18).freightPaise, 0);
    assert.equal(computeTotals([], 0, 250).gstPercent, 100);
    assert.equal(computeTotals([], 0, -5).gstPercent, 0);
  });

  test("zero GST leaves the payable equal to the base", () => {
    const totals = computeTotals([{ amountPaise: 50_000 }], 0, 0);
    assert.equal(totals.gstPaise, 0);
    assert.equal(totals.payablePaise, 50_000);
  });
});

describe("quantityTotals", () => {
  test("groups by unit and never folds one unit into another", () => {
    const totals = quantityTotals([
      { uom: "SQM", qtyMilli: 100_000 },
      { uom: "sqm", qtyMilli: 14_600 },
      { uom: "NOS", qtyMilli: 3_000 },
    ]);
    assert.deepEqual(totals, [
      { uom: "SQM", qtyMilli: 114_600 },
      { uom: "NOS", qtyMilli: 3_000 },
    ]);
    assert.equal(formatQuantityTotals(totals), "114.6 SQM · 3 NOS");
  });

  test("drops blank units rather than showing a nameless total", () => {
    assert.deepEqual(quantityTotals([{ uom: "  ", qtyMilli: 500 }]), []);
    assert.deepEqual(quantityTotals([{ uom: null, qtyMilli: 500 }]), []);
  });

  test("ignores zero and negative quantities", () => {
    assert.deepEqual(quantityTotals([{ uom: "SQM", qtyMilli: 0 }]), []);
  });
});

describe("evaluateFormula", () => {
  test("respects operator precedence", () => {
    assert.equal(evaluateFormula("2+2*8"), 18);
    assert.equal(evaluateFormula("2*8+2"), 18);
  });

  test("handles brackets, unary signs and the typed multiply/divide symbols", () => {
    assert.equal(evaluateFormula("(2+2)*8"), 32);
    assert.equal(evaluateFormula("-2+10"), 8);
    assert.equal(evaluateFormula("12.5 x 3.2"), 40);
    assert.equal(evaluateFormula("10 ÷ 4"), 2.5);
    assert.equal(evaluateFormula("1,000+1"), 1001);
  });

  test("blank is zero", () => {
    assert.equal(evaluateFormula(""), 0);
    assert.equal(evaluateFormula("   "), 0);
  });

  test("lands on the same three-decimal grid the column stores", () => {
    // 10/3 is 3.3333...; the grid can only hold 3.333.
    assert.equal(evaluateFormula("10/3"), 3.333);
    assert.equal(parseQtyToMilli(String(evaluateFormula("10/3"))), 3_333);
  });

  test("refuses to divide by zero instead of returning Infinity", () => {
    assert.throws(() => evaluateFormula("5/0"), FormulaError);
  });

  test("refuses a negative result - a quantity cannot be negative", () => {
    assert.throws(() => evaluateFormula("2-10"), FormulaError);
  });

  test("reports an unclosed bracket", () => {
    assert.throws(() => evaluateFormula("(2+2"), FormulaError);
  });

  /**
   * The grammar IS the whitelist. This string reaches the server, so the
   * parser must be incapable of expressing anything but arithmetic - no
   * identifiers, no calls, no property access, no template literals.
   */
  test("cannot express code, only arithmetic", () => {
    const attacks = [
      "process.exit(1)",
      "require(1)",
      "1;2",
      "globalThis",
      "2**64",
      "[]",
      "{}",
      "1&&2",
    ];
    for (const attack of attacks) {
      assert.throws(
        () => evaluateFormula(attack),
        FormulaError,
        `expected ${JSON.stringify(attack)} to be rejected`,
      );
    }
  });

  test("a hex literal is unreachable, because x already means multiply", () => {
    // "0x10" is not 16 here and never can be: the x is rewritten to * before
    // parsing, so it reads as nought times ten. Worth pinning down - it is
    // the reason the grammar needs no separate rule against hex.
    assert.equal(evaluateFormula("0x10"), 0);
    assert.equal(evaluateFormula("2x10"), 20);
  });
});

describe("looksLikeFormula", () => {
  test("a plain number is not working worth keeping", () => {
    assert.equal(looksLikeFormula("18"), false);
    assert.equal(looksLikeFormula("18.5"), false);
    assert.equal(looksLikeFormula("-18"), false);
  });

  test("anything with an operator is", () => {
    assert.equal(looksLikeFormula("2+2*8"), true);
    assert.equal(looksLikeFormula("12.5x3"), true);
    assert.equal(looksLikeFormula("(2)"), true);
  });
});

describe("grid rows", () => {
  test("a row with nothing typed into it is empty, even though UOM defaults", () => {
    // emptyRow() seeds uom to SQM. That default must not make the row look
    // filled in, or every untouched row would be saved.
    assert.equal(isRowEmpty(emptyRow("k1")), true);
  });

  test("a row with only a quantity is not empty", () => {
    assert.equal(isRowEmpty({ ...emptyRow("k1"), qty: "5" }), false);
  });

  test("preview is null while a cell is mid-edit, not a crash", () => {
    assert.equal(previewAmountPaise({ ...emptyRow("k"), qty: "12.", rate: "5" }), null);
    assert.equal(previewAmountPaise({ ...emptyRow("k"), qty: "2", rate: "10" }), 2_000);
    assert.equal(previewAmountPaise(emptyRow("k")), 0);
  });
});
