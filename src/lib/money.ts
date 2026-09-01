/**
 * All money in this application is Indian Rupees stored as an integer number
 * of paise. There is no floating point anywhere in the money path.
 *
 * The database column is BigInt, because a large order in paise overflows a
 * 32-bit integer at only around 21 lakh rupees. BigInt does not survive the
 * React Server Component boundary, so every read converts to a JS number the
 * moment it leaves the data layer. Number is safe up to 9,007,199,254,740,991
 * paise, which is about 9 lakh crore rupees.
 */

export const MAX_PAISE = Number.MAX_SAFE_INTEGER;

/** BigInt column -> plain number of paise, for anything crossing to the UI. */
export function toPaise(value: bigint | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Math.trunc(value);
  if (value > BigInt(MAX_PAISE)) {
    throw new Error(`Money value ${value} exceeds the safe integer range`);
  }
  return Number(value);
}

/** Plain number of paise -> BigInt, for writing to a BigInt column. */
export function toBigIntPaise(paise: number): bigint {
  if (!Number.isFinite(paise) || !Number.isInteger(paise)) {
    throw new Error(`Expected an integer number of paise, received ${paise}`);
  }
  return BigInt(paise);
}

/**
 * Parse a rupee amount typed by a human into integer paise.
 *
 * Accepts "1,25,000", "1250.50", "Rs 1250", "₹1,250.5". Rejects anything
 * that is not a clean non-negative amount with at most two decimal places,
 * because a silently rounded third decimal is a silently wrong invoice.
 */
export function parseRupeesToPaise(input: string): number {
  const cleaned = input
    .trim()
    .replace(/^(?:rs\.?|inr|₹)\s*/i, "")
    .replace(/,/g, "")
    .replace(/\s+/g, "");

  if (cleaned.length === 0) {
    throw new MoneyParseError("Enter an amount");
  }
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new MoneyParseError(
      "Enter a plain amount in rupees, up to two decimal places",
    );
  }

  const [wholeRaw, fractionRaw = ""] = cleaned.split(".");
  const whole = wholeRaw ?? "0";
  const fraction = fractionRaw.padEnd(2, "0");
  const paise = Number(whole) * 100 + Number(fraction);

  if (!Number.isSafeInteger(paise)) {
    throw new MoneyParseError("That amount is too large");
  }
  return paise;
}

export class MoneyParseError extends Error {}

/** Paise -> rupees as a number, for chart axes only. Never for arithmetic. */
export function paiseToRupees(paise: number): number {
  return paise / 100;
}

/**
 * Indian-format currency, e.g. 12,34,567 paise -> "12,345.67".
 * Grouping is done by hand so server and client always agree, regardless of
 * the ICU data the runtime happens to ship.
 */
export function formatPaise(
  paise: number,
  options: { decimals?: boolean; symbol?: boolean } = {},
): string {
  const { decimals = true, symbol = true } = options;

  const negative = paise < 0;
  const absolute = Math.abs(Math.trunc(paise));
  const rupees = Math.trunc(absolute / 100);
  const remainder = absolute % 100;

  let body = groupIndian(rupees);
  if (decimals) body += "." + String(remainder).padStart(2, "0");

  return `${negative ? "-" : ""}${symbol ? "₹" : ""}${body}`;
}

/** Rupees only, no paise. Used where the decimals are noise. */
export function formatRupees(paise: number): string {
  return formatPaise(paise, { decimals: false });
}

/**
 * Compact Indian notation for dashboard tiles: 1.2Cr, 4.5L, 32.4K.
 * Falls back to the full number below a thousand rupees.
 */
export function formatCompactPaise(paise: number): string {
  const negative = paise < 0;
  const rupees = Math.abs(Math.trunc(paise)) / 100;
  const sign = negative ? "-" : "";

  const shorten = (value: number, suffix: string) => {
    const rounded = Math.round(value * 10) / 10;
    const text = Number.isInteger(rounded)
      ? String(rounded)
      : rounded.toFixed(1);
    return `${sign}₹${text}${suffix}`;
  };

  if (rupees >= 1_00_00_000) return shorten(rupees / 1_00_00_000, "Cr");
  if (rupees >= 1_00_000) return shorten(rupees / 1_00_000, "L");
  if (rupees >= 1_000) return shorten(rupees / 1_000, "K");
  return formatPaise(paise, { decimals: false });
}

/** 2-3-3 grouping: 1234567 -> "12,34,567". */
function groupIndian(value: number): string {
  const digits = String(value);
  if (digits.length <= 3) return digits;

  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + last3;
}
