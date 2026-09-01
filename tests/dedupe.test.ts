import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  cleanText,
  dedupeWhere,
  formatPhone,
  normalizeEmail,
  normalizePhone,
} from "@/lib/dedupe";

/**
 * These two keys carry a unique index, so what they collapse to decides
 * whether the same enquiry arriving twice becomes one lead or two.
 */

describe("normalizePhone", () => {
  test("the same Indian number written five ways is one key", () => {
    const written = [
      "+91 98765 43210",
      "09876543210",
      "9876543210",
      "+919876543210",
      "0091 98765 43210",
      "98765-43210",
      "(98765) 43210",
    ];
    const keys = new Set(written.map((n) => normalizePhone(n)));
    assert.equal(keys.size, 1, `expected one key, got ${[...keys].join(", ")}`);
    assert.equal([...keys][0], "9876543210");
  });

  test("a non-Indian number keeps its full digit string", () => {
    // 44 is not 91, and the length does not match the trunk-zero rule either,
    // so nothing is stripped.
    assert.equal(normalizePhone("+44 20 7946 0958"), "442079460958");
  });

  test("returns null for anything too short to identify anybody", () => {
    assert.equal(normalizePhone("12345"), null);
    assert.equal(normalizePhone("-"), null);
    assert.equal(normalizePhone("NA"), null);
    assert.equal(normalizePhone(""), null);
    assert.equal(normalizePhone(null), null);
    assert.equal(normalizePhone(undefined), null);
  });

  test("caps an absurdly long value so junk cannot bloat the index", () => {
    const key = normalizePhone("9".repeat(40));
    assert.equal(key?.length, 15);
  });
});

describe("normalizeEmail", () => {
  test("lowercases and trims, so one address is one key", () => {
    assert.equal(normalizeEmail("  Ravi.Kumar@Example.COM "), "ravi.kumar@example.com");
  });

  test("rejects the junk lead sources put in the email field", () => {
    // These must not all collide on one unique key, which is what would
    // happen if they were stored verbatim.
    for (const junk of ["NA", "-", "test", "none", "n/a", "", "   ", "@", "a@b"]) {
      assert.equal(normalizeEmail(junk), null, `expected ${JSON.stringify(junk)} rejected`);
    }
  });

  test("rejects the placeholder addresses that are shaped like real ones", () => {
    for (const placeholder of [
      "na@na.com",
      "test@test.com",
      "NO@EMAIL.COM",
      "none@none.com",
      "abc@abc.com",
    ]) {
      assert.equal(normalizeEmail(placeholder), null, `expected ${placeholder} rejected`);
    }
  });

  test("rejects an address too long for the column", () => {
    assert.equal(normalizeEmail(`${"a".repeat(250)}@example.com`), null);
  });

  test("accepts an ordinary address", () => {
    assert.equal(normalizeEmail("ravi@hicon.co.in"), "ravi@hicon.co.in");
  });
});

describe("cleanText", () => {
  test("collapses whitespace and drops empties", () => {
    assert.equal(cleanText("  Wall   Panel \n 60mm "), "Wall Panel 60mm");
    assert.equal(cleanText("   "), null);
    assert.equal(cleanText(null), null);
  });

  test("truncates to the column width", () => {
    assert.equal(cleanText("a".repeat(50), 10)?.length, 10);
  });
});

describe("formatPhone", () => {
  test("splits a ten-digit number for reading", () => {
    assert.equal(formatPhone("+91 98765 43210"), "98765 43210");
  });

  test("falls back to the raw string when it cannot be sure", () => {
    assert.equal(formatPhone("ext. 4471"), "ext. 4471");
    assert.equal(formatPhone(null), "-");
  });
});

describe("dedupeWhere", () => {
  test("matches on either key", () => {
    assert.deepEqual(dedupeWhere("9876543210", "ravi@example.com"), {
      OR: [{ phoneKey: "9876543210" }, { emailKey: "ravi@example.com" }],
    });
  });

  test("uses whichever key survived normalisation", () => {
    assert.deepEqual(dedupeWhere("9876543210", null), {
      OR: [{ phoneKey: "9876543210" }],
    });
  });

  test("returns null when there is nothing to deduplicate on", () => {
    // The caller must create the lead rather than match every row with no
    // phone and no email.
    assert.equal(dedupeWhere(null, null), null);
  });
});
