"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { formatPaise } from "@/lib/money";
import {
  GRID_COLUMNS,
  UOM_OPTIONS,
  computeTotals,
  emptyRow,
  evaluateFormula,
  FormulaError,
  isRowEmpty,
  looksLikeFormula,
  formatQuantityTotals,
  previewAmountPaise,
  quantityTotals,
  type GridRow,
} from "@/lib/quotation-math";
import { cx } from "./ui";

/**
 * The quotation line-item grid.
 *
 * It behaves like a spreadsheet because that is what the people using it are
 * used to: every cell is typed by hand, Enter and the arrow keys move between
 * cells, and a block pasted straight out of Excel fills the cells it covers
 * instead of dumping tab characters into one input.
 *
 * Amounts are never typed. Each line is qty x rate, and the totals below are
 * recomputed from the rows on every keystroke, so what the CRE sees while
 * typing is exactly what the server will store.
 */

const TEXT_COLUMNS = GRID_COLUMNS.length;
const QTY_COL = TEXT_COLUMNS;
const RATE_COL = TEXT_COLUMNS + 1;
const COL_COUNT = TEXT_COLUMNS + 2;

/** What has been typed into the spec columns before, most-used first. */
export interface GridSuggestions {
  particular?: string[];
  panelThickness?: string[];
  specs?: string[];
  sheetThickness?: string[];
}

export interface QuoteGridProps {
  initialRows: GridRow[];
  initialFreight: string;
  initialGstPercent: number;
  readOnly?: boolean;
  name?: string;
  suggestions?: GridSuggestions;
}

export function QuoteGrid({
  initialRows,
  initialFreight,
  initialGstPercent,
  readOnly = false,
  name = "grid",
  suggestions = {},
}: QuoteGridProps) {
  const [rows, setRows] = useState<GridRow[]>(() =>
    initialRows.length > 0 ? initialRows : [emptyRow(newKey())],
  );
  const [freight, setFreight] = useState(initialFreight);
  const [gstPercent, setGstPercent] = useState(String(initialGstPercent));
  const [calcRow, setCalcRow] = useState<number | null>(null);

  const cellRefs = useRef(new Map<string, HTMLTextAreaElement | HTMLInputElement>());
  const register =
    (row: number, col: number) =>
    (el: HTMLTextAreaElement | HTMLInputElement | null) => {
      const key = `${row}:${col}`;
      if (el) cellRefs.current.set(key, el);
      else cellRefs.current.delete(key);
    };

  const focusCell = useCallback((row: number, col: number) => {
    const el = cellRefs.current.get(`${row}:${col}`);
    if (el) {
      el.focus();
      if ("select" in el) el.select();
    }
  }, []);

  const setCell = useCallback(
    (rowIndex: number, key: keyof GridRow, value: string) => {
      setRows((current) =>
        current.map((row, index) =>
          index === rowIndex ? { ...row, [key]: value } : row,
        ),
      );
    },
    [],
  );

  /**
   * A datalist is filtered by whatever is already in the input, so a cell
   * reading "SQM" dropped down to exactly one suggestion: SQM. Every other
   * unit was reachable only by deleting the text first, which is not
   * something anybody discovers.
   *
   * So a known unit is blanked on focus and put back on blur if nothing was
   * chosen. Only values that are in UOM_OPTIONS get blanked - text somebody
   * typed by hand is never touched, because we would have nothing to restore.
   */
  const blankedUom = useRef<string | null>(null);

  const openUomList = useCallback(
    (rowIndex: number, current: string) => {
      if ((UOM_OPTIONS as readonly string[]).includes(current)) {
        blankedUom.current = current;
        setCell(rowIndex, "uom", "");
      }
    },
    [setCell],
  );

  const closeUomList = useCallback(
    (rowIndex: number, current: string) => {
      const previous = blankedUom.current;
      blankedUom.current = null;
      if (previous !== null && current === "") {
        setCell(rowIndex, "uom", previous);
      }
    },
    [setCell],
  );

  const addRow = useCallback((afterIndex?: number) => {
    setRows((current) => {
      const next = [...current];
      const at = afterIndex === undefined ? next.length : afterIndex + 1;
      next.splice(at, 0, emptyRow(newKey()));
      return next;
    });
  }, []);

  const removeRow = useCallback((rowIndex: number) => {
    setRows((current) =>
      current.length === 1
        ? [emptyRow(newKey())]
        : current.filter((_, index) => index !== rowIndex),
    );
  }, []);

  // -- keyboard ------------------------------------------------------------

  const onKeyDown = (
    event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    rowIndex: number,
    col: number,
  ) => {
    if (readOnly) return;
    const isMultiline = event.currentTarget.tagName === "TEXTAREA";

    if (event.key === "Enter" && !event.shiftKey && !isMultiline) {
      event.preventDefault();
      if (rowIndex === rows.length - 1) {
        addRow(rowIndex);
        window.setTimeout(() => focusCell(rowIndex + 1, col), 0);
      } else {
        focusCell(rowIndex + 1, col);
      }
      return;
    }
    if (event.key === "ArrowDown" && !isMultiline) {
      event.preventDefault();
      focusCell(Math.min(rowIndex + 1, rows.length - 1), col);
      return;
    }
    if (event.key === "ArrowUp" && !isMultiline) {
      event.preventDefault();
      focusCell(Math.max(rowIndex - 1, 0), col);
      return;
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      addRow(rowIndex);
      window.setTimeout(() => focusCell(rowIndex + 1, 0), 0);
    }
  };

  // -- paste ---------------------------------------------------------------

  const onPaste = (
    event: ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    rowIndex: number,
    col: number,
  ) => {
    if (readOnly) return;
    const text = event.clipboardData.getData("text/plain");
    if (!text.includes("\t") && !text.includes("\n")) return;

    // A tab is the only unambiguous sign of a spreadsheet block. Without one,
    // a multi-line paste into a multi-line cell is just multi-line text -
    // three lines of a panel description, not three rows - so it is left to
    // the browser to paste natively. Single-line columns keep the old
    // behaviour, where a column of values pasted down the rows is the useful
    // reading.
    const target = GRID_COLUMNS[col];
    const multiline =
      target !== undefined && "multiline" in target && target.multiline;
    if (multiline && !text.includes("\t")) return;

    event.preventDefault();
    const block = text
      .replace(/\r\n?/g, "\n")
      .replace(/\n$/, "")
      .split("\n")
      .map((line) => line.split("\t"));

    setRows((current) => {
      const next = [...current];
      block.forEach((cells, r) => {
        const target = rowIndex + r;
        while (next.length <= target) next.push(emptyRow(newKey()));
        const row = { ...next[target]! };
        cells.forEach((value, c) => {
          const column = col + c;
          if (column >= COL_COUNT) return;
          assignCell(row, column, value.trim());
        });
        next[target] = row;
      });
      return next;
    });
  };

  // -- totals --------------------------------------------------------------

  const priced = useMemo(
    () => rows.map((row) => ({ row, amountPaise: previewAmountPaise(row) })),
    [rows],
  );

  const totals = useMemo(() => {
    const lines = priced
      .filter((entry) => entry.amountPaise !== null)
      .map((entry) => ({ amountPaise: entry.amountPaise as number }));
    return computeTotals(lines, safeRupeesToPaise(freight), Number(gstPercent) || 0);
  }, [priced, freight, gstPercent]);

  /** "214.6 SQM · 3 NOS", recomputed as the grid is typed into. */
  const quantityText = useMemo(() => {
    return formatQuantityTotals(
      quantityTotals(
        rows.map((row) => ({ uom: row.uom, qtyMilli: safeQtyMilli(row.qty) })),
      ),
    );
  }, [rows]);

  const payload = useMemo(
    () =>
      JSON.stringify({
        rows: rows.filter((row) => !isRowEmpty(row)),
        freight,
        gstPercent,
      }),
    [rows, freight, gstPercent],
  );

  const filledCount = rows.filter((row) => !isRowEmpty(row)).length;

  return (
    <div className="space-y-3">
      <input type="hidden" name={name} value={payload} />

      {/*
        Capped height plus sticky header and sticky row-number column. A CRE
        working forty lines used to lose both the column names and the line
        number as soon as they scrolled; now the frame stays and only the
        cells move. All of this is CSS - no state, no handlers, so the
        keyboard behaviour below is untouched.
      */}
      <div className="scroll-x max-h-[min(65vh,42rem)] overflow-y-auto rounded-xl border">
        <table className="crm-table w-full min-w-[58rem] border-collapse text-sm">
          <thead>
            <tr className="bg-[var(--bg-sunken)]">
              <th className="sticky top-0 left-0 z-30 w-10 border-b border-r bg-[var(--bg-sunken)] px-1 py-2 text-2xs font-medium tracking-wide text-[var(--text-faint)] uppercase">
                #
              </th>
              {GRID_COLUMNS.map((column) => (
                <th
                  key={column.key}
                  style={{ minWidth: column.width }}
                  className="sticky top-0 z-20 border-b border-r bg-[var(--bg-sunken)] px-2 py-2 text-left text-2xs font-medium tracking-wide text-[var(--text-faint)] uppercase"
                >
                  {column.label}
                  {"hint" in column && column.hint ? (
                    <span className="block text-2xs normal-case opacity-70">
                      {column.hint}
                    </span>
                  ) : null}
                </th>
              ))}
              <th className="sticky top-0 z-20 w-28 border-b border-r bg-[var(--bg-sunken)] px-2 py-2 text-right text-2xs font-medium tracking-wide text-[var(--text-faint)] uppercase">
                Qty
              </th>
              <th className="sticky top-0 z-20 w-28 border-b border-r bg-[var(--bg-sunken)] px-2 py-2 text-right text-2xs font-medium tracking-wide text-[var(--text-faint)] uppercase">
                Rate
              </th>
              <th className="sticky top-0 z-20 w-32 border-b border-r bg-[var(--bg-sunken)] px-2 py-2 text-right text-2xs font-medium tracking-wide text-[var(--text-faint)] uppercase">
                Amount
              </th>
              {readOnly ? null : <th className="sticky top-0 z-20 w-9 border-b bg-[var(--bg-sunken)]" />}
            </tr>
          </thead>
          <tbody>
            {priced.map(({ row, amountPaise }, rowIndex) => (
              <tr key={row.key} className="group">
                <td className="sticky left-0 z-10 border-b border-r bg-[var(--bg-raised)] px-1 py-0 text-center text-xs text-[var(--text-faint)] group-focus-within:bg-[var(--bg-row-active)]">
                  {rowIndex + 1}
                </td>

                {GRID_COLUMNS.map((column, col) => (
                  <td key={column.key} className="border-b border-r p-0">
                    {"multiline" in column && column.multiline ? (
                      <textarea
                        ref={register(rowIndex, col)}
                        value={row[column.key]}
                        onChange={(e) => setCell(rowIndex, column.key, e.target.value)}
                        onKeyDown={(e) => onKeyDown(e, rowIndex, col)}
                        onPaste={(e) => onPaste(e, rowIndex, col)}
                        readOnly={readOnly}
                        rows={2}
                        placeholder={readOnly ? undefined : column.placeholder}
                        className={CELL_CLASS + " resize-y leading-snug"}
                      />
                    ) : (
                      <input
                        ref={register(rowIndex, col)}
                        value={row[column.key]}
                        onChange={(e) => setCell(rowIndex, column.key, e.target.value)}
                        onKeyDown={(e) => onKeyDown(e, rowIndex, col)}
                        onPaste={(e) => onPaste(e, rowIndex, col)}
                        readOnly={readOnly}
                        placeholder={readOnly ? undefined : column.placeholder}
                        // The spec columns offer what the factory has quoted
                        // before, which is what keeps "60", "60MM" and "80mm"
                        // from all meaning the same panel.
                        list={
                          readOnly
                            ? undefined
                            : column.key === "uom"
                              ? "uom-options"
                              : column.key in suggestions
                                ? `sugg-${column.key}`
                                : undefined
                        }
                        onFocus={
                          column.key === "uom" && !readOnly
                            ? () => openUomList(rowIndex, row.uom)
                            : undefined
                        }
                        onBlur={
                          column.key === "uom" && !readOnly
                            ? () => closeUomList(rowIndex, row.uom)
                            : undefined
                        }
                        className={cx(
                          CELL_CLASS,
                          column.key === "uom" && "text-center",
                        )}
                      />
                    )}
                  </td>
                ))}

                {/* Quantity opens the calculator: these numbers are worked
                    out, not known, and doing the sum somewhere else and
                    typing the answer in is where mistakes come from. */}
                <td className="border-b border-r p-0">
                  <button
                    type="button"
                    onClick={() => !readOnly && setCalcRow(rowIndex)}
                    disabled={readOnly}
                    title={readOnly ? undefined : "Open the calculator"}
                    className={cx(
                      "tnum flex w-full items-center justify-end gap-1 px-2 py-1.5 text-right text-sm",
                      readOnly
                        ? "cursor-default text-[var(--text-muted)]"
                        : "cursor-pointer hover:bg-[var(--accent-soft)]",
                    )}
                  >
                    {/*
                      The calculator is the most domain-specific thing in the
                      app - it is how 6.1 x 6.33 becomes 38.613 SQM - and it
                      used to be reachable only by hovering a cell, so on a
                      touch screen it did not exist at all. The fx is always
                      visible now, and an empty cell leads with it rather than
                      with a 0, because empty is exactly when it is wanted.
                    */}
                    {row.qty ? (
                      <span>{row.qty}</span>
                    ) : readOnly ? (
                      <span className="text-[var(--text-faint)]">0</span>
                    ) : null}
                    {/* A solid fx means there is working behind this number,
                        so it is worth opening rather than retyping. */}
                    {readOnly ? null : (
                      <span
                        title={
                          row.qtyFormula
                            ? `Worked out from ${row.qtyFormula}`
                            : undefined
                        }
                        className={cx(
                          "text-2xs font-semibold transition-colors",
                          row.qtyFormula || !row.qty
                            ? "text-[var(--accent-text)]"
                            : "text-[var(--text-faint)] group-hover:text-[var(--accent-text)]",
                        )}
                      >
                        fx
                      </span>
                    )}
                  </button>
                </td>

                <td className="border-b border-r p-0">
                  <input
                    ref={register(rowIndex, RATE_COL)}
                    value={row.rate}
                    onChange={(e) => setCell(rowIndex, "rate", e.target.value)}
                    onKeyDown={(e) => onKeyDown(e, rowIndex, RATE_COL)}
                    onPaste={(e) => onPaste(e, rowIndex, RATE_COL)}
                    readOnly={readOnly}
                    inputMode="decimal"
                    placeholder="0.00"
                    className={cx(CELL_CLASS, "tnum text-right")}
                  />
                </td>

                <td className="tnum border-b border-r px-2 py-1.5 text-right font-medium">
                  {amountPaise === null ? (
                    <span
                      className="text-[var(--danger)]"
                      title="Check the quantity and rate on this line"
                    >
                      &mdash;
                    </span>
                  ) : (
                    formatPaise(amountPaise)
                  )}
                </td>

                {readOnly ? null : (
                  <td className="border-b p-0 text-center">
                    <button
                      type="button"
                      onClick={() => removeRow(rowIndex)}
                      title="Remove this line"
                      aria-label={`Remove line ${rowIndex + 1}`}
                      className="h-full w-full px-1 py-2 text-base text-[var(--text-faint)] opacity-0 transition-opacity group-hover:opacity-100 hover:text-[var(--danger)] focus:opacity-100"
                    >
                      &times;
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <datalist id="uom-options">
        {UOM_OPTIONS.map((uom) => (
          <option key={uom} value={uom} />
        ))}
      </datalist>

      {(Object.entries(suggestions) as [string, string[] | undefined][]).map(
        ([key, values]) =>
          values && values.length > 0 ? (
            <datalist key={key} id={`sugg-${key}`}>
              {values.map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
          ) : null,
      )}

      {readOnly ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => addRow()}
            className="inline-flex items-center gap-1.5 rounded-lg border bg-[var(--bg-raised)] px-3 py-1.5 text-base font-medium hover:bg-[var(--bg-hover)]"
          >
            + Add line
          </button>
          <span className="text-xs text-[var(--text-faint)]">
            Click a quantity to calculate it &middot; Enter moves down &middot;
            arrows move between rows &middot; paste a block straight from Excel
          </span>
        </div>
      )}

      {/* -- totals ------------------------------------------------------- */}
      <div className="flex justify-end">
        <div className="w-full max-w-sm space-y-1.5 rounded-xl border bg-[var(--bg-raised)] p-4">
          {/*
            How much panel, not just how much money. This factory sells by the
            square metre, and until now the document could not answer "what is
            the total area?" without opening the calculator.
          */}
          {quantityText ? (
            <div className="flex items-center justify-between gap-3 border-b pb-1.5 text-base">
              <span className="text-[var(--text-muted)]">Quantity</span>
              <span className="tnum font-medium">{quantityText}</span>
            </div>
          ) : null}

          <div className="flex items-center justify-between gap-3 text-base">
            <span className="text-[var(--text-muted)]">
              Sub total
              {filledCount
                ? ` (${filledCount} line${filledCount === 1 ? "" : "s"})`
                : ""}
            </span>
            <span className="tnum">{formatPaise(totals.subTotalPaise)}</span>
          </div>

          <div className="flex items-center justify-between gap-3 text-base">
            <span className="text-[var(--text-muted)]">Freight charges</span>
            <div className="relative w-32">
              <span className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-sm text-[var(--text-faint)]">
                &#8377;
              </span>
              <input
                value={freight}
                onChange={(e) => setFreight(e.target.value)}
                readOnly={readOnly}
                inputMode="decimal"
                placeholder="0.00"
                className="tnum w-full rounded-md border bg-[var(--bg-raised)] py-1 pr-2 pl-6 text-right text-base"
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 text-base">
            <span className="text-[var(--text-muted)]">
              GST
              <span className="ml-1 text-xs text-[var(--text-faint)]">
                on {formatPaise(totals.gstBasePaise)}
              </span>
            </span>
            <div className="flex items-center gap-1.5">
              <input
                value={gstPercent}
                onChange={(e) => setGstPercent(e.target.value)}
                readOnly={readOnly}
                inputMode="numeric"
                className="tnum w-14 rounded-md border bg-[var(--bg-raised)] px-2 py-1 text-right text-base"
              />
              <span className="text-sm text-[var(--text-faint)]">%</span>
              <span className="tnum w-24 text-right">
                {formatPaise(totals.gstPaise)}
              </span>
            </div>
          </div>

          <div className="mt-1 flex items-center justify-between border-t pt-2 text-md font-semibold">
            <span>Payable amount</span>
            <span className="tnum">{formatPaise(totals.payablePaise)}</span>
          </div>

          <p className="pt-1 text-2xs leading-snug text-[var(--text-faint)]">
            GST is charged on goods plus freight, which is the composite-supply
            treatment when we arrange the transport.
          </p>
        </div>
      </div>

      {calcRow !== null ? (
        <QtyCalculator
          lineNumber={calcRow + 1}
          particular={rows[calcRow]?.particular ?? ""}
          uom={rows[calcRow]?.uom ?? ""}
          // Reopen on the working, not the answer. A line that was worked out
          // as 2+2*8 comes back as 2+2*8, so it can be corrected rather than
          // recalculated from memory.
          initial={rows[calcRow]?.qtyFormula || rows[calcRow]?.qty || ""}
          onCancel={() => setCalcRow(null)}
          onApply={(value, formula) => {
            setRows((current) =>
              current.map((row, index) =>
                index === calcRow ? { ...row, qty: value, qtyFormula: formula } : row,
              ),
            );
            setCalcRow(null);
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The calculator
// ---------------------------------------------------------------------------

/**
 * Quantities on a panel quotation are worked out rather than known: a wall is
 * "12.5 * 3.2, twice, plus a 4.4 return". Doing that on a phone and typing
 * the answer into a tiny cell is where the mistakes come from, so the
 * expression lives here, in a box big enough to read, and only its result
 * goes into the grid.
 */
function QtyCalculator({
  lineNumber,
  particular,
  uom,
  initial,
  onApply,
  onCancel,
}: {
  lineNumber: number;
  particular: string;
  uom: string;
  initial: string;
  onApply: (value: string, formula: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [onCancel]);

  const result = useMemo((): { value: number } | { error: string } | null => {
    if (text.trim().length === 0) return null;
    try {
      return { value: evaluateFormula(text) };
    } catch (error) {
      return {
        error: error instanceof FormulaError ? error.message : "Cannot work that out",
      };
    }
  }, [text]);

  const ok = result !== null && "value" in result;

  const apply = () => {
    if (result === null) {
      onApply("", "");
      return;
    }
    if (!("value" in result)) return;

    // Both halves go back: the answer, which is what arithmetic uses, and the
    // working, which is what a person needs to change it later. A plain
    // number is its own answer, so nothing is recorded as working for it.
    const typed = text.trim();
    const answer = String(result.value);
    onApply(answer, typed === answer ? "" : typed);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Quantity for line ${lineNumber}`}
        className="rise w-full max-w-md rounded-xl border bg-[var(--bg-raised)] p-5 shadow-[var(--shadow)]"
      >
        <div className="mb-3">
          <h3 className="text-md font-semibold tracking-tight">
            Quantity &middot; line {lineNumber}
          </h3>
          <p className="mt-0.5 text-sm text-[var(--text-muted)]">
            {particular.trim() || "This line"}
            {uom ? ` · in ${uom}` : ""}
          </p>
        </div>

        <input
          ref={inputRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (ok || text.trim().length === 0) apply();
            }
          }}
          inputMode="text"
          placeholder="12.5 * 3.2 * 2 + 4.4"
          className="tnum w-full rounded-lg border bg-[var(--bg-raised)] px-4 py-3 text-right font-mono text-xl outline-none focus:border-[var(--accent)]"
        />

        <div className="mt-2 flex min-h-9 items-center justify-between gap-3">
          <span className="text-xs text-[var(--text-faint)]">
            + &minus; &times; &divide; and brackets
          </span>
          {result === null ? (
            <span className="text-base text-[var(--text-faint)]">
              Leave it blank to clear
            </span>
          ) : "error" in result ? (
            <span className="text-base text-[var(--danger)]">{result.error}</span>
          ) : (
            <span className="tnum text-xl font-semibold">
              = {result.value}
              {uom ? (
                <span className="ml-1 text-sm font-normal text-[var(--text-faint)]">
                  {uom}
                </span>
              ) : null}
            </span>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2 border-t pt-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-1.5 text-base font-medium text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={apply}
            disabled={result !== null && "error" in result}
            className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-base font-medium text-white hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-55"
          >
            Use this quantity
          </button>
        </div>

        <p className="mt-3 text-xs leading-snug text-[var(--text-faint)]">
          The working is kept with the line, so reopening this brings the sum
          back exactly as it is written here. Only the result reaches the
          customer; put it in the description if they should see how it was
          arrived at.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * The cell sets outline-none, so the focus tint was the only thing telling
 * you which cell you were in - and against a white card that was 0.05 of
 * lightness. The tint is stronger now and an inset ring goes with it, which
 * is what makes the current cell findable at a glance while typing.
 */
const CELL_CLASS =
  "w-full border-0 bg-transparent px-2 py-[var(--cell-py)] text-sm outline-none focus:bg-[var(--accent-soft)] focus:shadow-[inset_0_0_0_2px_var(--accent)] read-only:text-[var(--text-muted)]";

function assignCell(row: GridRow, column: number, value: string): void {
  if (column < TEXT_COLUMNS) {
    const key = GRID_COLUMNS[column]?.key;
    if (key) row[key] = value;
    return;
  }
  if (column === QTY_COL) {
    // A pasted cell may itself be a formula, e.g. "=12*3" out of Excel. That
    // is working worth keeping, exactly like something typed into the
    // calculator, so it is recorded rather than thrown away once evaluated.
    const cleaned = value.replace(/^=/, "");
    if (looksLikeFormula(cleaned)) {
      try {
        row.qty = String(evaluateFormula(cleaned));
        row.qtyFormula = cleaned;
        return;
      } catch {
        // fall through and keep the raw text so it can be corrected
      }
    }
    row.qty = cleaned;
    // A plain pasted number replaces whatever working was there; leaving the
    // old formula would leave it describing a quantity it no longer produces.
    row.qtyFormula = "";
  }
  if (column === RATE_COL) row.rate = value;
}

function safeRupeesToPaise(input: string): number {
  const cleaned = input.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return 0;
  const [whole, fraction = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

/**
 * Same shape as safeRupeesToPaise: a half-typed cell is worth nothing rather
 * than throwing, because this runs on every keystroke.
 */
function safeQtyMilli(input: string): number {
  const cleaned = input.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,3})?$/.test(cleaned)) return 0;
  const [whole, fraction = ""] = cleaned.split(".");
  return Number(whole) * 1000 + Number(fraction.padEnd(3, "0"));
}

let counter = 0;
function newKey(): string {
  counter += 1;
  return `r${counter}`;
}
