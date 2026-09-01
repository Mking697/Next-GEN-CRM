import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import {
  currentMonthKey,
  currentYear,
  monthRange,
  recentMonths,
  toDateInputValue,
  fromDateInputValue,
  zonedToUtc,
} from "@/lib/dates";

/**
 * Every figure on the Overview obeys a month, and "the month" has to mean the
 * month in the business's own timezone. India is UTC+5:30 and observes no DST,
 * so the first five and a half hours of every IST day are the previous day in
 * UTC - which is exactly where these functions earn their keep.
 */

const IST = "Asia/Kolkata";

/** 1 January 2027, 00:30 IST. In UTC this instant is still 31 Dec 2026. */
const NEW_YEAR_IST = Date.UTC(2026, 11, 31, 19, 0, 0);

describe("currentYear", () => {
  test("is the year in the app timezone, not in UTC", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: NEW_YEAR_IST });

    // The bug this replaced: getUTCFullYear() stamps the order ORD-2026-...
    // for the first five and a half hours of every year.
    assert.equal(new Date().getUTCFullYear(), 2026);
    assert.equal(currentYear(IST), 2027);

    t.mock.timers.reset();
  });

  test("agrees with currentMonthKey", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: NEW_YEAR_IST });
    assert.equal(currentMonthKey(IST), "2027-01");
    assert.equal(currentYear(IST), Number(currentMonthKey(IST).slice(0, 4)));
    t.mock.timers.reset();
  });

  test("a zone behind UTC gets the earlier year at the same instant", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: NEW_YEAR_IST });
    // Same instant, New York: still 31 December 2026, 14:00.
    assert.equal(currentYear("America/New_York"), 2026);
    t.mock.timers.reset();
  });
});

describe("monthRange", () => {
  test("starts and ends at IST midnight, not UTC midnight", () => {
    const range = monthRange("2026-08");

    // 1 Aug 2026 00:00 IST is 31 Jul 2026 18:30 UTC.
    assert.equal(range.start.toISOString(), "2026-07-31T18:30:00.000Z");
    // Exclusive end: 1 Sep 2026 00:00 IST.
    assert.equal(range.endExclusive.toISOString(), "2026-08-31T18:30:00.000Z");
  });

  test("labels the month it was asked for", () => {
    const range = monthRange("2026-08");
    assert.equal(range.key, "2026-08");
    assert.equal(range.label, "August 2026");
    assert.equal(range.shortLabel, "Aug 2026");
  });

  test("an order at 3am IST on the 1st falls in the new month", () => {
    const august = monthRange("2026-08");
    // 1 Aug 2026, 03:00 IST = 31 Jul 2026, 21:30 UTC.
    const confirmedAt = new Date(Date.UTC(2026, 6, 31, 21, 30, 0));

    assert.ok(confirmedAt >= august.start, "should be inside August in IST");
    assert.ok(confirmedAt < august.endExclusive);
    // And it is genuinely July by UTC, which is the whole point.
    assert.equal(confirmedAt.getUTCMonth(), 6);
  });

  test("crosses a year boundary correctly", () => {
    const december = monthRange("2026-12");
    assert.equal(december.endExclusive.toISOString(), "2026-12-31T18:30:00.000Z");
  });

  test("falls back to the current month rather than throwing on junk", () => {
    // The value arrives from a query string a user can type into.
    for (const junk of ["", "nonsense", "2026-13", "1800-01", null, undefined]) {
      assert.doesNotThrow(() => monthRange(junk));
      assert.match(monthRange(junk).key, /^\d{4}-\d{2}$/);
    }
  });
});

describe("zonedToUtc", () => {
  test("reads wall-clock IST as the instant it refers to", () => {
    assert.equal(
      zonedToUtc(2026, 8, 1, 0, 0, 0, IST).toISOString(),
      "2026-07-31T18:30:00.000Z",
    );
  });
});

describe("recentMonths", () => {
  test("returns the requested count, newest first, without duplicates", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: NEW_YEAR_IST });

    const months = recentMonths(6);
    assert.equal(months.length, 6);
    assert.equal(months[0]?.key, "2027-01");
    assert.equal(new Set(months.map((m) => m.key)).size, 6);

    t.mock.timers.reset();
  });
});

describe("date input round-trip", () => {
  test("a value put into a date input comes back as the same day", () => {
    const value = toDateInputValue(new Date(Date.UTC(2026, 7, 15, 6, 0, 0)));
    assert.match(value, /^\d{4}-\d{2}-\d{2}$/);
    const back = fromDateInputValue(value);
    assert.ok(back instanceof Date);
    assert.equal(toDateInputValue(back), value);
  });

  test("junk in the input is null, not an Invalid Date", () => {
    assert.equal(fromDateInputValue(""), null);
    assert.equal(fromDateInputValue("not-a-date"), null);
  });
});

// Keep the module-level mock registry clean for any file that runs after this.
mock.reset();
