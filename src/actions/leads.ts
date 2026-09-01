"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUserOrThrow } from "@/lib/auth";
import { actionGuard, fail, ok, type ActionResult } from "@/lib/errors";
import { fromDateInputValue } from "@/lib/dates";
import {
  addLeadNote,
  assignLead,
  createManualLead,
  grabLead,
  handLeadToCre,
  setLeadStatus,
  updateLead,
} from "@/server/leads";
import type { LeadStatus } from "@/generated/prisma/enums";

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function optional(formData: FormData, key: string): string | null {
  const value = text(formData, key);
  return value.length > 0 ? value : null;
}

function refreshLeadViews(leadId?: string): void {
  revalidatePath("/pool");
  revalidatePath("/leads");
  revalidatePath("/overview");
  if (leadId) revalidatePath(`/leads/${leadId}`);
}

/**
 * Grab a lead out of the pool.
 *
 * The race is settled in the data layer by a conditional UPDATE; all this
 * does is turn the resulting conflict into a sentence the losing salesman can
 * read, rather than an error page.
 */
export async function grabLeadAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<{ leadId: string }>> {
  return actionGuard(async () => {
    const user = await requireUserOrThrow();
    const leadId = text(formData, "leadId");
    if (!leadId) return fail("Missing lead.", "VALIDATION");

    const lead = await grabLead(user, leadId);
    refreshLeadViews(leadId);

    return ok({ leadId: lead.id }, `${lead.personName} is yours.`);
  });
}

export async function assignLeadAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const user = await requireUserOrThrow();
    const leadId = text(formData, "leadId");
    const salesmanId = text(formData, "salesmanId");

    if (!salesmanId) {
      return fail("Choose a salesman.", "VALIDATION", {
        salesmanId: "Pick somebody",
      });
    }

    await assignLead(user, leadId, salesmanId);
    refreshLeadViews(leadId);
    return ok(undefined, "Assigned.");
  });
}

export async function createLeadAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<{ leadId: string; duplicate: boolean }>> {
  return actionGuard(async () => {
    const user = await requireUserOrThrow();

    const result = await createManualLead(user, {
      personName: text(formData, "personName"),
      phone: optional(formData, "phone"),
      email: optional(formData, "email"),
      companyName: optional(formData, "companyName"),
      city: optional(formData, "city"),
      state: optional(formData, "state"),
      product: optional(formData, "product"),
      message: optional(formData, "message"),
    });

    if (result.status === "duplicate") {
      // Not an error: the point of deduplication is that the person already
      // exists. Show them where, but only when the match is theirs to see -
      // otherwise this form would report the owner and the id of a lead they
      // could not open, one phone number at a time.
      if (!result.visible) {
        return fail(
          "That phone or email is already on a lead in the CRM. Ask an admin if you think it should be yours.",
          "DUPLICATE",
        );
      }
      return fail(
        result.ownerName
          ? `This phone or email is already on a lead owned by ${result.ownerName}.`
          : "This phone or email is already on a lead sitting in the pool.",
        "DUPLICATE",
        { existing: `Open the existing lead: /leads/${result.leadId}` },
      );
    }

    refreshLeadViews(result.leadId);
    redirect(`/leads/${result.leadId}`);
  });
}

export async function updateLeadAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const user = await requireUserOrThrow();
    const leadId = text(formData, "leadId");

    const followUpRaw = text(formData, "nextFollowUpAt");

    await updateLead(user, leadId, {
      personName: text(formData, "personName"),
      phone: optional(formData, "phone"),
      email: optional(formData, "email"),
      companyName: optional(formData, "companyName"),
      city: optional(formData, "city"),
      state: optional(formData, "state"),
      product: optional(formData, "product"),
      nextFollowUpAt: followUpRaw ? fromDateInputValue(followUpRaw) : null,
    });

    refreshLeadViews(leadId);
    return ok(undefined, "Saved.");
  });
}

export async function setLeadStatusAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const user = await requireUserOrThrow();
    const leadId = text(formData, "leadId");
    const status = text(formData, "status") as LeadStatus;

    if (!["NEW", "FOLLOW_UP", "LOST"].includes(status)) {
      return fail("Pick a status.", "VALIDATION");
    }

    await setLeadStatus(user, leadId, status, optional(formData, "lostReason"));
    refreshLeadViews(leadId);
    return ok(undefined, "Status updated.");
  });
}

/**
 * Hand a lead to a CRE. The salesman stays the owner; only the CRE column
 * changes, which is what keeps the Overview and the delete-transfer rules
 * behaving exactly as they did before quotations existed.
 */
export async function handLeadToCreAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const user = await requireUserOrThrow();
    const leadId = text(formData, "leadId");
    const creId = text(formData, "creId");

    if (!creId) {
      return fail("Choose a CRE.", "VALIDATION", { creId: "Pick one of your CREs" });
    }

    await handLeadToCre(user, leadId, creId);
    refreshLeadViews(leadId);
    return ok(undefined, "Handed over. They can build the quotation now.");
  });
}

export async function addLeadNoteAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const user = await requireUserOrThrow();
    const leadId = text(formData, "leadId");

    await addLeadNote(user, leadId, text(formData, "message"));
    revalidatePath(`/leads/${leadId}`);
    return ok(undefined, "Note added.");
  });
}
