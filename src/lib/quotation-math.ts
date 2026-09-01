import { MoneyParseError, parseRupeesToPaise } from "./money";

/**
 * Quantity and line-total arithmetic for the quotation grid.
 *
 * Same rule as the rest of the money path: no floating point survives a
 * write. Quantities are integers in thousandths (123.45 SQM -> 123450) and
 * rates are integers in paise, so a line amount is one integer multiply and
 * one rounding step, done in exactly one place.
 */

export const QTY_SCALE = 1000;

/** Largest quantity we accept, so a fat-fingered paste cannot overflow. */
const MAX_QTY_MILLI = 1_000_000_000; // one million units

export class QuantityParseError extends Error {}

/**
 * "123.45" -> 123450. Accepts up to three decimal places, rejects anything
 * else rather than rounding it away silently.
 */
export function parseQtyToMilli(input: string): number {
  const cleaned = input.trim().replace(/,/g, "");
  if (cleaned.length === 0) return 0;

  if (!/^\d+(\.\d{1,3})?$/.test(cleaned)) {
    throw new QuantityParseError(
      "Enter a plain quantity, up to three decimal places",
    );
  }

  const [wholeRaw, fractionRaw = ""] = cleaned.split(".");
  const milli =
    Number(wholeRaw ?? "0") * QTY_SCALE + Number(fractionRaw.padEnd(3, "0"));

  if (!Number.isSafeInteger(milli) || milli > MAX_QTY_MILLI) {
    throw new QuantityParseError("That quantity is too large");
  }
  return milli;
}

/** 123450 -> "123.45". Trailing zeros trimmed, so 5000 shows as "5". */
export function formatQtyMilli(milli: number): string {
  if (!Number.isFinite(milli)) return "0";
  const negative = milli < 0;
  const abs = Math.abs(Math.trunc(milli));
  const whole = Math.trunc(abs / QTY_SCALE);
  const fraction = String(abs % QTY_SCALE).padStart(3, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? "." + fraction : ""}`;
}

/**
 * The one place a line amount is computed.
 *
 * qtyMilli is thousandths and ratePaise is paise, so the product is in
 * thousandths of a paisa. Rounding happens once, here, on the way back to
 * whole paise. Nothing downstream re-derives it.
 */
export function lineAmountPaise(qtyMilli: number, ratePaise: number): number {
  const product = qtyMilli * ratePaise;
  if (!Number.isSafeInteger(product)) {
    throw new QuantityParseError(
      "That quantity and rate multiply out to more than we can represent exactly",
    );
  }
  return Math.round(product / QTY_SCALE);
}

/** Rupee text from the grid -> paise. Blank means zero, not an error. */
export function parseRateToPaise(input: string): number {
  const cleaned = input.trim();
  if (cleaned.length === 0) return 0;
  try {
    return parseRupeesToPaise(cleaned);
  } catch (error) {
    if (error instanceof MoneyParseError) throw error;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

export interface QuotationTotals {
  subTotalPaise: number;
  freightPaise: number;
  gstPercent: number;
  /** What the GST percentage is charged on. Printed in the UI so the
   *  customer and the CRE are looking at the same base. */
  gstBasePaise: number;
  gstPaise: number;
  payablePaise: number;
}

/**
 * GST is charged on goods PLUS freight.
 *
 * That is the composite-supply treatment: when the seller arranges the
 * transport, the freight carries the same rate as the goods. The UI prints
 * the base next to the percentage so this is never a hidden assumption.
 */
export interface QuantityTotal {
  uom: string;
  qtyMilli: number;
}

/**
 * How much was quoted, in the units it was quoted in.
 *
 * This business sells panel by the square metre, so "how many SQM" is the
 * question the plant schedules against - and until now the app could only
 * answer in rupees. Every aggregate was money or a count, which is what made
 * the screens read like any other dashboard.
 *
 * Deliberately no unit conversion. Grouping by UOM and printing each is
 * honest; silently folding SQFT into SQM, or adding NOS to SQM, would not be.
 * Blank units are dropped rather than shown as a nameless total.
 */
export function quantityTotals(
  lines: { uom?: string | null; qtyMilli: number }[],
): QuantityTotal[] {
  const byUom = new Map<string, number>();
  for (const line of lines) {
    const uom = (line.uom ?? "").trim().toUpperCase();
    if (!uom || line.qtyMilli <= 0) continue;
    byUom.set(uom, (byUom.get(uom) ?? 0) + line.qtyMilli);
  }
  return [...byUom.entries()]
    .map(([uom, qtyMilli]) => ({ uom, qtyMilli }))
    .sort((a, b) => b.qtyMilli - a.qtyMilli);
}

/** "214.6 SQM · 3 NOS", or an empty string when nothing carries a unit. */
export function formatQuantityTotals(totals: QuantityTotal[]): string {
  return totals
    .map((total) => `${formatQtyMilli(total.qtyMilli)} ${total.uom}`)
    .join(" · ");
}

export function computeTotals(
  lines: { amountPaise: number }[],
  freightPaise: number,
  gstPercent: number,
): QuotationTotals {
  const subTotalPaise = lines.reduce((sum, line) => sum + line.amountPaise, 0);
  const freight = Math.max(0, Math.trunc(freightPaise));
  const percent = Math.max(0, Math.min(100, Math.trunc(gstPercent)));

  const gstBasePaise = subTotalPaise + freight;
  const gstPaise = Math.round((gstBasePaise * percent) / 100);

  return {
    subTotalPaise,
    freightPaise: freight,
    gstPercent: percent,
    gstBasePaise,
    gstPaise,
    payablePaise: gstBasePaise + gstPaise,
  };
}

// ---------------------------------------------------------------------------
// Grid rows
// ---------------------------------------------------------------------------

/** The columns of the quotation grid, in the order they appear. */
/**
 * `placeholder` is the house format for that column, shown in every empty
 * cell.
 *
 * Without them the grid is nine unlabelled blanks under a 10px header, and
 * the format has to be learned by opening somebody else's quotation. The
 * live data already shows what that costs: panel thickness has been entered
 * as "60", "60MM" and "80mm", and sheet thickness as both "0.4/0.4" and a
 * bare "0.4".
 */
export const GRID_COLUMNS = [
  { key: "particular", label: "Particular", width: "13rem", placeholder: "Wall Panel" },
  { key: "panelThickness", label: "Panel Thickness", width: "7.5rem", placeholder: "60" },
  { key: "specs", label: "Specs", width: "7rem", placeholder: "PP/PP" },
  {
    key: "sheetThickness",
    label: "Sheet Thickness",
    hint: "Inner / Outer",
    width: "8rem",
    placeholder: "0.4/0.4",
  },
  {
    key: "description",
    label: "Description",
    width: "20rem",
    multiline: true,
    placeholder: "Anything the customer needs spelled out",
  },
  { key: "uom", label: "UOM", width: "5rem", placeholder: "SQM" },
] as const;

export type GridTextColumn = (typeof GRID_COLUMNS)[number]["key"];

/**
 * Units offered in the grid, ordered by how often a panel quotation uses
 * them: area first, then length, count, weight, volume and packaging.
 *
 * Free text is still allowed - the cell is an input with a datalist, not a
 * select - so a one-off unit can always be typed. This list is only what gets
 * suggested.
 */
export const UOM_OPTIONS = [
  // Area
  "SQM",
  "SQFT",
  // Length
  "RMT",
  "RFT",
  "MTR",
  "FT",
  // Count
  "NOS",
  "PCS",
  "SET",
  "PAIR",
  // Weight
  "KG",
  "MT",
  // Volume
  "LTR",
  "CBM",
  // Packaging
  "BAG",
  "BOX",
  "ROLL",
  "BUNDLE",
  // Whole-job
  "LOT",
  "LS",
] as const;

export interface GridRow {
  /** Stable key for React. Not the database id for a row that is still new. */
  key: string;
  particular: string;
  panelThickness: string;
  specs: string;
  sheetThickness: string;
  description: string;
  uom: string;
  /** Raw text as typed, so a half-typed "12." does not get destroyed. */
  qty: string;
  /**
   * The expression `qty` was worked out from, e.g. "2+2*8". Empty when the
   * quantity was typed as a plain number.
   *
   * `qty` is the answer and is the only thing arithmetic ever touches; this
   * is the working, kept so the line can be reopened and corrected rather
   * than recalculated from memory.
   */
  qtyFormula: string;
  rate: string;
}

export function emptyRow(key: string): GridRow {
  return {
    key,
    particular: "",
    panelThickness: "",
    specs: "",
    sheetThickness: "",
    description: "",
    uom: "SQM",
    qty: "",
    qtyFormula: "",
    rate: "",
  };
}

/**
 * Best-effort amount for live display while typing. Never throws: a row being
 * edited is allowed to be temporarily unparseable, and the grid just shows a
 * blank amount until it makes sense again.
 */
export function previewAmountPaise(row: GridRow): number | null {
  try {
    const qty = parseQtyToMilli(row.qty);
    const rate = parseRateToPaise(row.rate);
    if (qty === 0 || rate === 0) return 0;
    return lineAmountPaise(qty, rate);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The quantity calculator
// ---------------------------------------------------------------------------

/**
 * Evaluate an arithmetic expression typed into the quantity calculator.
 *
 * Quantities on a panel quotation are worked out, not known: a wall is
 * "12.5 * 3.2, twice, plus a 4.4 return". People do that on a phone
 * calculator and mistype the answer into the grid, so the expression itself
 * belongs in the app.
 *
 * A hand-written recursive-descent parser rather than eval or new Function.
 * Those would execute anything the string contained, and this string reaches
 * the server. Here the grammar is the whitelist: digits, . + - * / ( ) and
 * nothing else can even be expressed.
 */
export class FormulaError extends Error {}

export function evaluateFormula(input: string): number {
  const text = input.replace(/[x×]/gi, "*").replace(/[÷]/g, "/").replace(/,/g, "");

  let position = 0;

  const skipSpace = () => {
    while (position < text.length && /\s/.test(text[position]!)) position += 1;
  };

  const parseNumber = (): number => {
    skipSpace();
    const start = position;
    while (position < text.length && /[\d.]/.test(text[position]!)) position += 1;
    const slice = text.slice(start, position);
    if (slice.length === 0 || !/^\d*\.?\d+$|^\d+\.$/.test(slice)) {
      throw new FormulaError(`Unexpected "${text[position] ?? "end"}"`);
    }
    return Number.parseFloat(slice);
  };

  const parseFactor = (): number => {
    skipSpace();
    if (text[position] === "(") {
      position += 1;
      const value = parseExpression();
      skipSpace();
      if (text[position] !== ")") throw new FormulaError("Missing a closing bracket");
      position += 1;
      return value;
    }
    if (text[position] === "-") {
      position += 1;
      return -parseFactor();
    }
    if (text[position] === "+") {
      position += 1;
      return parseFactor();
    }
    return parseNumber();
  };

  const parseTerm = (): number => {
    let value = parseFactor();
    for (;;) {
      skipSpace();
      const operator = text[position];
      if (operator !== "*" && operator !== "/") return value;
      position += 1;
      const right = parseFactor();
      if (operator === "/") {
        if (right === 0) throw new FormulaError("Cannot divide by zero");
        value /= right;
      } else {
        value *= right;
      }
    }
  };

  function parseExpression(): number {
    let value = parseTerm();
    for (;;) {
      skipSpace();
      const operator = text[position];
      if (operator !== "+" && operator !== "-") return value;
      position += 1;
      const right = parseTerm();
      value = operator === "+" ? value + right : value - right;
    }
  }

  if (text.trim().length === 0) return 0;

  const result = parseExpression();
  skipSpace();
  if (position < text.length) {
    throw new FormulaError(`Unexpected "${text.slice(position, position + 8)}"`);
  }
  if (!Number.isFinite(result)) throw new FormulaError("That does not work out to a number");
  if (result < 0) throw new FormulaError("A quantity cannot be negative");

  // Back onto the same three-decimal grid the column stores, so what the
  // calculator shows is exactly what gets saved.
  return Math.round(result * QTY_SCALE) / QTY_SCALE;
}

/** True when the text is a calculation rather than a plain number. */
export function looksLikeFormula(input: string): boolean {
  return /[+\-*/()x×÷]/i.test(input.trim().replace(/^-/, ""));
}

/** A row with nothing typed into it is dropped on save rather than stored. */
export function isRowEmpty(row: GridRow): boolean {
  return (
    !row.particular.trim() &&
    !row.panelThickness.trim() &&
    !row.specs.trim() &&
    !row.sheetThickness.trim() &&
    !row.description.trim() &&
    !row.qty.trim() &&
    !row.rate.trim()
  );
}
