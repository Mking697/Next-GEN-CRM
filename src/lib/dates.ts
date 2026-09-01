import "server-only";
import { env } from "./env";

/**
 * Month handling for the Overview.
 *
 * Every figure on that page obeys a month picked at the top, and "the month"
 * has to mean the month in the business's own timezone (Asia/Kolkata by
 * default), not UTC. An order confirmed at 3am IST on the 1st belongs to the
 * new month, and UTC would file it under the old one.
 *
 * Rather than pull in a date library, the conversion uses Intl to read the
 * zone offset at a given instant. Two passes handle zones that observe DST;
 * India does not, but the code should not quietly break if the deployment
 * moves.
 */

export interface MonthRange {
  /** "2026-08" */
  key: string;
  /** Inclusive start, as a UTC instant. */
  start: Date;
  /** Exclusive end, as a UTC instant. */
  endExclusive: Date;
  /** "August 2026" */
  label: string;
  /** "Aug 2026" */
  shortLabel: string;
}

const MONTH_KEY = /^(\d{4})-(\d{2})$/;

function timeZone(): string {
  return env.APP_TIMEZONE;
}

/** Milliseconds that the zone is ahead of UTC at this instant. */
function zoneOffsetMs(instant: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : 0;
  };

  // Intl renders hour 24 for midnight in some engines.
  const hour = read("hour") % 24;

  const asIfUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    hour,
    read("minute"),
    read("second"),
  );
  return asIfUtc - instant.getTime();
}

/** Wall-clock time in `zone` -> the UTC instant it refers to. */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  zone = timeZone(),
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstGuess = new Date(naive - zoneOffsetMs(new Date(naive), zone));
  // Second pass, in case the first guess landed on the other side of a
  // DST transition.
  return new Date(naive - zoneOffsetMs(firstGuess, zone));
}

/** Today's "YYYY-MM" in the app timezone. */
export function currentMonthKey(zone = timeZone()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((p) => p.type === "year")?.value ?? "1970";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  return `${year}-${month}`;
}

/**
 * This year, in the app timezone.
 *
 * Order numbers are stamped with it, and an order confirmed at 3am IST on
 * 1 January belongs to the new year. `getUTCFullYear()` would file it under
 * the old one for the first five and a half hours of every year, which is
 * exactly the bug the rest of this module exists to avoid.
 */
export function currentYear(zone = timeZone()): number {
  return Number(currentMonthKey(zone).slice(0, 4));
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/**
 * Turn "2026-08" into a half-open UTC interval. Anything unparseable falls
 * back to the current month rather than throwing, because the value arrives
 * from a query string a user can type into.
 */
export function monthRange(key: string | null | undefined): MonthRange {
  const zone = timeZone();
  const match = key ? MONTH_KEY.exec(key) : null;

  let year: number;
  let month: number;

  if (match) {
    year = Number(match[1]);
    month = Number(match[2]);
  } else {
    const parts = currentMonthKey(zone).split("-");
    year = Number(parts[0]);
    month = Number(parts[1]);
  }

  if (!Number.isInteger(year) || year < 2000 || year > 2200) {
    year = Number(currentMonthKey(zone).slice(0, 4));
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    month = Number(currentMonthKey(zone).slice(5, 7));
  }

  const start = zonedToUtc(year, month, 1, 0, 0, 0, zone);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const endExclusive = zonedToUtc(nextYear, nextMonth, 1, 0, 0, 0, zone);

  const name = MONTH_NAMES[month - 1] ?? "January";
  return {
    key: `${year}-${String(month).padStart(2, "0")}`,
    start,
    endExclusive,
    label: `${name} ${year}`,
    shortLabel: `${name.slice(0, 3)} ${year}`,
  };
}

/** The last `count` months, newest first, for the picker. */
export function recentMonths(count = 18): { key: string; label: string }[] {
  const zone = timeZone();
  const parts = currentMonthKey(zone).split("-");
  let year = Number(parts[0]);
  let month = Number(parts[1]);

  const out: { key: string; label: string }[] = [];
  for (let i = 0; i < count; i += 1) {
    const name = MONTH_NAMES[month - 1] ?? "January";
    out.push({
      key: `${year}-${String(month).padStart(2, "0")}`,
      label: `${name} ${year}`,
    });
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export function formatDate(value: Date | null | undefined): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: timeZone(),
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(value);
}

export function formatDateTime(value: Date | null | undefined): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: timeZone(),
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(value);
}

/** "2026-08-24", suitable for an <input type="date"> default. */
export function toDateInputValue(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

/** An <input type="date"> value -> the UTC instant of that local midnight. */
export function fromDateInputValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  return zonedToUtc(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    12, // midday, so the date cannot slide across a zone boundary
  );
}

/** "3 days ago", "in 2 hours". */
export function relativeTime(value: Date | null | undefined): string {
  if (!value) return "-";
  const deltaSeconds = Math.round((value.getTime() - Date.now()) / 1000);
  const absolute = Math.abs(deltaSeconds);

  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 7],
    ["week", 4.348],
    ["month", 12],
    ["year", Number.POSITIVE_INFINITY],
  ];

  let value_ = deltaSeconds;
  for (const [unit, size] of units) {
    if (Math.abs(value_) < size || unit === "year") {
      return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(
        Math.round(value_),
        unit,
      );
    }
    value_ /= size;
  }
  return new Intl.RelativeTimeFormat("en").format(Math.round(absolute), "second");
}
