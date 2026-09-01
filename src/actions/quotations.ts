"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUserOrThrow } from "@/lib/auth";
import { actionGuard, fail, ok, type ActionResult } from "@/lib/errors";
import { MoneyParseError } from "@/lib/money";
import {
  parseQtyToMilli,
  parseRateToPaise,
  QuantityParseError,
  type GridRow,
} from "@/lib/quotation-math";
import {
  createQuotation,
  deleteQuotation,
  handOverQuotation,
  placeOrderFromQuotation,
  saveQuotationItems,
  setQuotationStatus,
  updateQuotationHeader,
  type ItemInput,
} from "@/server/quotations";
import { recordRevision } from "@/server/quotation-revisions";
import type { QuotationStatus } from "@/generated/prisma/enums";

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}
function optional(formData: FormData, key: string): string | null {
  const value = text(formData, key);
  return value.length > 0 ? value : null;
}

function refresh(id?: string, leadId?: string | null): void {
  revalidatePath("/quotations");
  revalidatePath("/overview");
  // Editing a quotation that already has an order moves the order value with
  // it, so the order pages are stale too. "layout" so /orders/[id] is covered
  // without the action needing to know the order id.
  revalidatePath("/orders", "layout");
  if (id) revalidatePath(`/quotations/${id}`);
  if (leadId) revalidatePath(`/leads/${leadId}`);
}

// ---------------------------------------------------------------------------

export async function createQuotationAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  return actionGuard(async () => {
    const user = await requireUserOrThrow();

    const result = await createQuotation(user, {
      leadId: optional(formData, "leadId"),
      companyId: optional(formData, "companyId"),
      partyName: optional(formData, "partyName"),
    });

    refresh(result.id, optional(formData, "leadId"));
    redirect(`/quotations/${result.id}`);
  });
}

/**
 * Saves the whole document in one go: the party details, the document text,
 * and the grid.
 *
 * The grid arrives as JSON from the client component. Parsing it here rather
 * than trusting the numbers the browser computed is the point: the client
 * shows a live total for the person typing, the server recomputes it from the
 * same rows, and only the server's answer is ever stored.
 */
export async function saveQuotationAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const user = await requireUserOrThrow();
    const id = text(formData, "quotationId");

    // The grid is parsed before anything is written. It used to be parsed
    // after the header had already been saved, so "Nothing was saved" was not
    // true of an unreadable grid.
    const parsed = parseGrid(String(formData.get("grid") ?? ""));
    if ("error" in parsed) {
      return fail(parsed.error, "VALIDATION", parsed.fieldErrors);
    }

    // Items first, because the one save that genuinely gets refused is a
    // re-price below what an order has already collected, and that refusal
    // has to leave the whole document untouched.
    const totals = await saveQuotationItems(user, id, parsed.items, {
      freightPaise: parsed.freightPaise,
      gstPercent: parsed.gstPercent,
    });

    await updateQuotationHeader(user, id, {
      partyName: text(formData, "partyName"),
      contactPerson: optional(formData, "contactPerson"),
      customerMobile: optional(formData, "customerMobile"),
      customerEmail: optional(formData, "customerEmail"),
      customerGst: optional(formData, "customerGst"),
      billing: {
        street: optional(formData, "billingStreet"),
        city: optional(formData, "billingCity"),
        state: optional(formData, "billingState"),
        pincode: optional(formData, "billingPincode"),
        country: optional(formData, "billingCountry"),
      },
      shipping: {
        partyName: optional(formData, "shippingPartyName"),
        contactPerson: optional(formData, "shippingContactPerson"),
        street: optional(formData, "shippingStreet"),
        city: optional(formData, "shippingCity"),
        state: optional(formData, "shippingState"),
        pincode: optional(formData, "shippingPincode"),
        country: optional(formData, "shippingCountry"),
      },
      subject: optional(formData, "subject"),
      note: optional(formData, "note"),
      terms: String(formData.get("terms") ?? ""),
    });

    // One revision per save, after both halves have landed, so the history
    // records the document as it ended up rather than a half-applied state.
    const revision = await recordRevision(user, id);

    refresh(id);

    if (revision && revision.revision > 1) {
      return ok(
        undefined,
        `Saved as revision ${revision.revision}. ${revision.changes.length} change${revision.changes.length === 1 ? "" : "s"} recorded.`,
      );
    }

    return ok(
      undefined,
      `Saved. ${parsed.items.length} line${parsed.items.length === 1 ? "" : "s"}, payable ${formatShort(totals.payablePaise)}.`,
    );
  });
}

export async function setQuotationStatusAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const user = await requireUserOrThrow();
    const id = text(formData, "quotationId");
    const status = text(formData, "status") as QuotationStatus;

    if (!["SENT", "REJECTED", "DRAFT"].includes(status)) {
      return fail("Pick a status.", "VALIDATION");
    }

    await setQuotationStatus(user, id, status as "SENT" | "REJECTED" | "DRAFT");
    refresh(id);

    return ok(
      undefined,
      status === "SENT" ? "Marked as sent." : "Updated.",
    );
  });
}

export async function placeOrderAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const user = await requireUserOrThrow();
    const id = text(formData, "quotationId");

    const result = await placeOrderFromQuotation(user, id);

    refresh(id);
    revalidatePath("/orders");
    revalidatePath("/leads");
    redirect(`/orders/${result.orderId}`);
  });
}

/**
 * Hand the whole job to a CRE: the quotation, its order and its lead.
 *
 * Works at any stage, because a salesman can now carry a job as far as they
 * like before deciding to involve a CRE at all.
 */
export async function handOverQuotationAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const user = await requireUserOrThrow();
    const id = text(formData, "quotationId");
    const creId = text(formData, "creId");

    if (!creId) {
      return fail("Choose a CRE.", "VALIDATION", {
        creId: "Pick one of your CREs",
      });
    }

    const result = await handOverQuotation(user, id, creId);

    refresh(id, optional(formData, "leadId"));

    return ok(
      undefined,
      result.movedOrder
        ? `${result.quoteNo} and order ${result.movedOrder} are now with ${result.creName}.`
        : `${result.quoteNo} is now with ${result.creName}.`,
    );
  });
}

export async function deleteQuotationAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const user = await requireUserOrThrow();
    await deleteQuotation(user, text(formData, "quotationId"));
    refresh();
    redirect("/quotations?deleted=1");
  });
}

// ---------------------------------------------------------------------------
// Grid parsing
// ---------------------------------------------------------------------------

interface ParsedGrid {
  items: ItemInput[];
  freightPaise: number;
  gstPercent: number;
}

/**
 * Turn the client's JSON back into typed rows, reporting the exact line and
 * column that failed rather than a blanket "invalid input".
 */
function parseGrid(
  raw: string,
): ParsedGrid | { error: string; fieldErrors?: Record<string, string> } {
  if (!raw) return { items: [], freightPaise: 0, gstPercent: 18 };

  let payload: { rows?: GridRow[]; freight?: string; gstPercent?: string };
  try {
    payload = JSON.parse(raw);
  } catch {
    return { error: "The line items could not be read. Reload and try again." };
  }

  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const items: ItemInput[] = [];
  const fieldErrors: Record<string, string> = {};

  rows.forEach((row, index) => {
    let qtyMilli = 0;
    let ratePaise = 0;

    try {
      qtyMilli = parseQtyToMilli(String(row.qty ?? ""));
    } catch (error) {
      fieldErrors[`line${index + 1}qty`] =
        `Line ${index + 1} quantity: ${error instanceof QuantityParseError ? error.message : "not a number"}`;
    }

    try {
      ratePaise = parseRateToPaise(String(row.rate ?? ""));
    } catch (error) {
      fieldErrors[`line${index + 1}rate`] =
        `Line ${index + 1} rate: ${error instanceof MoneyParseError ? error.message : "not an amount"}`;
    }

    items.push({
      particular: row.particular ?? null,
      panelThickness: row.panelThickness ?? null,
      specs: row.specs ?? null,
      sheetThickness: row.sheetThickness ?? null,
      description: row.description ?? null,
      uom: row.uom ?? null,
      qtyFormula: row.qtyFormula ?? null,
      qtyMilli,
      ratePaise,
    });
  });

  if (Object.keys(fieldErrors).length > 0) {
    return {
      error: "Some lines could not be read. Nothing was saved.",
      fieldErrors,
    };
  }

  let freightPaise = 0;
  try {
    freightPaise = parseRateToPaise(String(payload.freight ?? ""));
  } catch {
    return {
      error: "Freight charges must be a plain amount in rupees.",
      fieldErrors: { freight: "Check the freight amount" },
    };
  }

  const gstPercent = Number(payload.gstPercent ?? 18);
  if (!Number.isFinite(gstPercent) || gstPercent < 0 || gstPercent > 100) {
    return {
      error: "GST must be a percentage between 0 and 100.",
      fieldErrors: { gst: "Check the GST percentage" },
    };
  }

  return { items, freightPaise, gstPercent: Math.trunc(gstPercent) };
}

function formatShort(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
