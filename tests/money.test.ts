import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PAISE,
  MoneyParseError,
  formatCompactPaise,
  formatPaise,
  formatRupees,
  parseRupeesToPaise,
  toBigIntPaise,
  toPaise,
} from "@/lib/money";

/**
 * The money path claims two things: no floating point survives a write, and
 * nothing is ever silently rounded. These tests are what makes those claims
 * checkable rather than aspirational.
 */

describe("parseRupeesToPaise", () => {
  test("parses plain rupees", () => {
    assert.equal(parseRupeesToPaise("1250"), 125_000);
    assert.equal(parseRupeesToPaise("0"), 0);
  });

  test("parses paise exactly, with no floating point drift", () => {
    // 1250.50 * 100 in floating point is 125049.99999999999.
    assert.equal(parseRupeesToPaise("1250.50"), 125_050);
    assert.equal(parseRupeesToPaise("0.07"), 7);
    assert.equal(parseRupeesToPaise("1.1"), 110);
  });

  test("strips Indian grouping, currency symbols and spaces", () => {
    assert.equal(parseRupeesToPaise("1,25,000"), 12_500_000);
    assert.equal(parseRupeesToPaise("Rs 1250"), 125_000);
    assert.equal(parseRupeesToPaise("Rs. 1250"), 125_000);
    assert.equal(parseRupeesToPaise("INR 1250"), 125_000);
    assert.equal(parseRupeesToPaise("₹1,250.5"), 125_050);
    assert.equal(parseRupeesToPaise("  1250  "), 125_000);
  });

  test("REJECTS a third decimal rather than rounding it away", () => {
    // The whole point: a silently rounded third decimal is a silently wrong
    // invoice.
    assert.throws(() => parseRupeesToPaise("10.005"), MoneyParseError);
    assert.throws(() => parseRupeesToPaise("1.234"), MoneyParseError);
  });

  test("rejects anything that is not a clean non-negative amount", () => {
    for (const bad of ["", "   ", "abc", "-5", "1,2,3.4.5", "1e3", "NaN", "12-", "+5"]) {
      assert.throws(
        () => parseRupeesToPaise(bad),
        MoneyParseError,
        `expected ${JSON.stringify(bad)} to be rejected`,
      );
    }
  });

  test("rejects an amount too large to stay exact", () => {
    assert.throws(() => parseRupeesToPaise("9".repeat(20)), MoneyParseError);
  });
});

describe("toPaise / toBigIntPaise", () => {
  test("round-trips through the BigInt column", () => {
    assert.equal(toPaise(toBigIntPaise(125_050)), 125_050);
  });

  test("treats null and undefined as zero, so a missing sum is not NaN", () => {
    assert.equal(toPaise(null), 0);
    assert.equal(toPaise(undefined), 0);
  });

  test("throws rather than silently losing precision above the safe range", () => {
    assert.throws(() => toPaise(BigInt(MAX_PAISE) + 1n), /exceeds the safe integer range/);
  });

  test("refuses a non-integer number of paise", () => {
    assert.throws(() => toBigIntPaise(1.5), /integer number of paise/);
    assert.throws(() => toBigIntPaise(Number.NaN), /integer number of paise/);
  });
});

describe("formatPaise", () => {
  test("groups 2-3-3, Indian style", () => {
    assert.equal(formatPaise(123_456_789), "₹12,34,567.89");
    assert.equal(formatPaise(100_000), "₹1,000.00");
    assert.equal(formatPaise(99_900), "₹999.00");
    assert.equal(formatPaise(10_00_00_000), "₹10,00,000.00");
    assert.equal(formatPaise(1_00_00_00_000), "₹1,00,00,000.00");
  });

  test("pads the paise, so 5 paise is .05 and not .5", () => {
    assert.equal(formatPaise(105), "₹1.05");
    assert.equal(formatPaise(150), "₹1.50");
  });

  test("honours the decimals and symbol switches", () => {
    assert.equal(formatPaise(123_456_789, { decimals: false }), "₹12,34,567");
    assert.equal(formatPaise(123_456_789, { symbol: false }), "12,34,567.89");
    assert.equal(formatRupees(123_456_789), "₹12,34,567");
  });

  test("keeps the sign outside the symbol", () => {
    assert.equal(formatPaise(-125_000), "-₹1,250.00");
  });
});

describe("formatCompactPaise", () => {
  test("uses Indian magnitudes, not Western ones", () => {
    assert.equal(formatCompactPaise(1_20_00_000_00), "₹1.2Cr");
    assert.equal(formatCompactPaise(4_50_000_00), "₹4.5L");
    assert.equal(formatCompactPaise(32_400_00), "₹32.4K");
  });

  test("falls back to the full number below a thousand rupees", () => {
    assert.equal(formatCompactPaise(99_900), "₹999");
  });

  test("drops a trailing .0 rather than printing 2.0Cr", () => {
    assert.equal(formatCompactPaise(2_00_00_000_00), "₹2Cr");
  });
});
