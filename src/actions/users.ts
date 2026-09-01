"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUserOrThrow } from "@/lib/auth";
import { actionGuard, fail, ok, type ActionResult } from "@/lib/errors";
import {
  createUser,
  deleteUser,
  resetPassword,
  setCreSalesmen,
  setUserActive,
  updateUser,
} from "@/server/users";
import { syncIndiamart } from "@/server/ingest/indiamart";
import type { Role } from "@/generated/prisma/enums";

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

/**
 * The salesmen a CRE works for arrive as repeated checkbox values, so getAll
 * rather than get: a single-salesman CRE and a three-salesman one come back
 * through the same code path.
 */
function salesmanIds(formData: FormData): string[] {
  return formData
    .getAll("salesmanIds")
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0);
}

function refreshPeople(): void {
  revalidatePath("/people");
  revalidatePath("/overview");
}

export async function createUserAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const actor = await requireUserOrThrow();
    const role = text(formData, "role") as Role;

    if (!["ADMIN", "SALESMAN", "CRE"].includes(role)) {
      return fail("Pick a role.", "VALIDATION", { role: "Choose a role" });
    }

    await createUser(actor, {
      name: text(formData, "name"),
      email: text(formData, "email"),
      password: String(formData.get("password") ?? ""),
      phone: text(formData, "phone") || null,
      role,
      salesmanIds: salesmanIds(formData),
    });

    refreshPeople();
    return ok(
      undefined,
      "Account created. Give them the email address and password you just set.",
    );
  });
}

/**
 * Delete an account and move its work.
 *
 * The whole move happens in one transaction in the data layer. If the caller
 * did not name a destination and one is needed, that comes back here as a
 * field error rather than a half-finished delete.
 */
export async function deleteUserAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const actor = await requireUserOrThrow();
    const targetId = text(formData, "targetId");
    const transferToId = text(formData, "transferToId") || null;

    const result = await deleteUser(actor, targetId, { transferToId });

    refreshPeople();
    revalidatePath("/leads");
    revalidatePath("/orders");

    const moved =
      result.moved.leads +
      result.moved.orders +
      result.moved.creOrders +
      result.moved.cres;

    const summary =
      moved === 0
        ? "Account deleted. It was holding no leads, orders or CREs."
        : `Account deleted. ${result.moved.leads} lead(s), ${
            result.moved.orders + result.moved.creOrders
          } order(s) and ${result.moved.cres} CRE(s) moved to ${result.movedTo}, with their stage and payment history unchanged.`;

    redirect(`/people?deleted=${encodeURIComponent(summary)}`);
  });
}

export async function assignCreAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const actor = await requireUserOrThrow();
    const creId = text(formData, "creId");
    const chosen = salesmanIds(formData);

    if (chosen.length === 0) {
      return fail("Choose at least one salesman.", "VALIDATION", {
        salesmanIds: "Pick at least one salesman",
      });
    }

    await setCreSalesmen(actor, creId, chosen);
    refreshPeople();
    return ok(
      undefined,
      chosen.length === 1
        ? "Saved. This CRE now works for one salesman."
        : `Saved. This CRE now works for ${chosen.length} salesmen and can switch between them.`,
    );
  });
}

/**
 * Switch which salesman a CRE is working as.
 *
 * The cookie this writes is validated again on every read in readSession(),
 * because an admin can unassign a CRE at any moment. Checking here as well
 * means the switcher cannot be used to probe for salesman ids: an id that is
 * not theirs is refused rather than quietly ignored.
 */
export async function setActingSalesmanAction(formData: FormData): Promise<void> {
  const user = await requireUserOrThrow();
  const salesmanId = text(formData, "salesmanId");

  // Silently ignore anything that is not one of theirs. readSession() would
  // reject it on the next read anyway; refusing to write it means the cookie
  // never holds a salesman id this CRE has no business knowing.
  const salesman = user.salesmen.find((entry) => entry.id === salesmanId);
  if (!salesman) return;

  const { setActingSalesman } = await import("@/lib/session");
  await setActingSalesman(salesman.id);

  // The active salesman feeds the scope clauses, so every cached page below
  // is now answering for the wrong person.
  revalidatePath("/", "layout");
}

/** Edit somebody's name, email or phone. */
export async function updateUserAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const actor = await requireUserOrThrow();

    await updateUser(actor, text(formData, "targetId"), {
      name: text(formData, "name"),
      email: text(formData, "email"),
      phone: text(formData, "phone") || null,
    });

    refreshPeople();
    revalidatePath("/account");
    return ok(undefined, "Saved.");
  });
}

export async function resetPasswordAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const actor = await requireUserOrThrow();
    const targetId = text(formData, "targetId");
    const password = String(formData.get("password") ?? "");

    await resetPassword(actor, targetId, password);
    refreshPeople();
    return ok(
      undefined,
      "Password reset. They have been signed out of every device.",
    );
  });
}

export async function setUserActiveAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const actor = await requireUserOrThrow();
    const targetId = text(formData, "targetId");
    const isActive = text(formData, "isActive") === "true";

    await setUserActive(actor, targetId, isActive);
    refreshPeople();
    return ok(undefined, isActive ? "Reactivated." : "Deactivated.");
  });
}

/** Manual IndiaMART pull, subject to the same 5-minute rule as the cron. */
export async function runIndiamartSyncAction(
  _previous: unknown,
  _formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const { requireAuth } = await import("@/lib/auth");
    await requireAuth("integration.sync.run");

    // The credentials are global, so they belong to one named workspace.
    // Anyone else pressing this gets an honest refusal rather than somebody
    // else's enquiries.
    const { integrationOrgId } = await import("@/server/ingest/common");
    const orgId = await integrationOrgId();
    if (!orgId) {
      return fail(
        "No workspace is set up to receive IndiaMART leads. Set INTEGRATIONS_ORG_SLUG.",
        "VALIDATION",
      );
    }
    const result = await syncIndiamart(orgId);
    revalidatePath("/sources");
    revalidatePath("/pool");

    if (result.status === "ok") return ok(undefined, result.message);
    return fail(result.message, result.status.toUpperCase());
  });
}
