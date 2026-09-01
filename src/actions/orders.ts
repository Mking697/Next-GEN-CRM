"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUserOrThrow } from "@/lib/auth";
import { actionGuard, fail, ok, type ActionResult } from "@/lib/errors";
import { MoneyParseError, formatPaise, parseRupeesToPaise } from "@/lib/money";
import { fromDateInputValue } from "@/lib/dates";
import {
  closeOrder,
  confirmOrder,
  deleteOrder,
  deletePayment,
  handOverOrder,
  recordPayment,
  reopenOrder,
  updateOrder,
} from "@/server/orders";
import type { PaymentMode } from "@/generated/prisma/enums";

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function optional(formData: FormData, key: string): string | null {
  const value = text(formData, key);
  return value.length > 0 ? value : null;
}

/** Rupees typed by a human -> integer paise, or a field-level message. */
function readAmount(formData: FormData, key = "amount"): number | string {
  try {
    return parseRupeesToPaise(text(formData, key));
  } catch (error) {
    return error instanceof MoneyParseError ? error.message : "Enter an amount";
  }
}

function refreshOrderViews(orderId?: string, leadId?: string): void {
  revalidatePath("/orders");
  revalidatePath("/overview");
  revalidatePath("/leads");
  if (orderId) revalidatePath(`/orders/${orderId}`);
  if (leadId) revalidatePath(`/leads/${leadId}`);
}

export async function confirmOrderAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<{ orderId: string }>> {
  return actionGuard(async () => {
    const user = await requireUserOrThrow();
    const leadId = text(formData, "leadId");

    const amount = readAmount(formData);
    if (typeof amount === "string") {
      return fail(amount, "VALIDATION", { amount });
    }

    const result = await confirmOrder(user, leadId, {
      amountPaise: amount,
      companyName: optional(formData, "companyName"),
      contactName: optional(formData, "contactName"),
      contactPhone: optional(formData, "contactPhone"),
      contactEmail: optional(formData, "contactEmail"),
      city: optional(formData, "city"),
      state: optional(formData, "state"),
      gstin: optional(formData, "gstin"),
      title: optional(formData, "title"),
      notes: optional(formData, "notes"),
    });

    refreshOrderViews(result.orderId, leadId);
    redirect(`/orders/${result.orderId}`);
  });
}

export async function handOverAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const user = await requireUserOrThrow();
    const orderId = text(formData, "orderId");
    const creId = text(formData, "creId");

    if (!creId) {
      return fail("Choose a CRE.", "VALIDATION", { creId: "Pick one of your CREs" });
    }

    await handOverOrder(user, orderId, creId);
    refreshOrderViews(orderId);
    return ok(undefined, "Handed over.");
  });
}

/**
 * Record a payment. The over-limit refusal happens in the data layer under a
 * row lock; here it just becomes a readable message.
 */
export async function recordPaymentAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const user = await requireUserOrThrow();
    const orderId = text(formData, "orderId");

    const amount = readAmount(formData);
    if (typeof amount === "string") {
      return fail(amount, "VALIDATION", { amount });
    }

    const receivedRaw = text(formData, "receivedAt");
    const mode = (text(formData, "mode") || "BANK_TRANSFER") as PaymentMode;

    const result = await recordPayment(user, orderId, {
      amountPaise: amount,
      mode,
      reference: optional(formData, "reference"),
      note: optional(formData, "note"),
      receivedAt: receivedRaw ? fromDateInputValue(receivedRaw) : null,
    });

    refreshOrderViews(orderId);

    return ok(
      undefined,
      result.duePaise === 0
        ? `Recorded. This order is now fully paid and can be closed.`
        : `Recorded. ${formatPaise(result.duePaise)} still due.`,
    );
  });
}

export async function deletePaymentAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const user = await requireUserOrThrow();
    const paymentId = text(formData, "paymentId");
    const orderId = text(formData, "orderId");

    await deletePayment(user, paymentId);
    refreshOrderViews(orderId);
    return ok(undefined, "Payment removed.");
  });
}

export async function closeOrderAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const user = await requireUserOrThrow();
    const orderId = text(formData, "orderId");

    await closeOrder(user, orderId);
    refreshOrderViews(orderId);
    return ok(undefined, "Order closed.");
  });
}

export async function reopenOrderAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const user = await requireUserOrThrow();
    const orderId = text(formData, "orderId");

    await reopenOrder(user, orderId);
    refreshOrderViews(orderId);
    return ok(undefined, "Order reopened.");
  });
}

/**
 * Delete an order raised by mistake.
 *
 * Redirects to the list rather than returning a message, because the page the
 * user is standing on stops existing.
 */
export async function deleteOrderAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const user = await requireUserOrThrow();
    const orderId = text(formData, "orderId");

    const result = await deleteOrder(user, orderId);

    refreshOrderViews();
    revalidatePath("/quotations", "layout");

    const summary =
      result.payments === 0
        ? `Order ${result.orderNo} deleted. It had no payments against it.`
        : `Order ${result.orderNo} deleted, along with ${result.payments} payment(s) totalling ${formatPaise(result.receivedPaise)}. The audit trail has the details.`;

    redirect(`/orders?deleted=${encodeURIComponent(summary)}`);
  });
}

export async function updateOrderAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const user = await requireUserOrThrow();
    const orderId = text(formData, "orderId");

    const amountRaw = text(formData, "amount");
    let amountPaise: number | undefined;
    if (amountRaw) {
      const parsed = readAmount(formData);
      if (typeof parsed === "string") {
        return fail(parsed, "VALIDATION", { amount: parsed });
      }
      amountPaise = parsed;
    }

    await updateOrder(user, orderId, {
      amountPaise,
      title: optional(formData, "title"),
      notes: optional(formData, "notes"),
    });

    refreshOrderViews(orderId);
    return ok(undefined, "Saved.");
  });
}
