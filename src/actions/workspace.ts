"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUserOrThrow } from "@/lib/auth";
import { actionGuard, fail, ok, type ActionResult } from "@/lib/errors";
import { createSession } from "@/lib/session";
import { signUp, slugFrom } from "@/server/signup";
import {
  clearLogo,
  setLogo,
  updateOrganisation,
} from "@/server/organisation";

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function optional(formData: FormData, key: string): string | null {
  const value = text(formData, key);
  return value.length > 0 ? value : null;
}

/**
 * The value for `key`, or `undefined` when this particular <form> never
 * included it at all.
 *
 * The Settings page posts the letterhead, the bank details and the quotation
 * defaults as three separate <form>s, all to this one action, and
 * updateOrganisation()'s whole contract rests on telling "sent as blank"
 * apart from "not part of this submission" - the first clears a field, the
 * second must leave it alone. `formData.get()` returns null for both an
 * absent key and one that was submitted empty, so `text()`/`optional()`
 * alone cannot make that distinction; `formData.has()` can.
 */
function fieldIfPresent(formData: FormData, key: string): string | null | undefined {
  return formData.has(key) ? optional(formData, key) : undefined;
}

// ---------------------------------------------------------------------------
// Signing a company up
// ---------------------------------------------------------------------------

export async function signUpAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const companyName = text(formData, "companyName");
    // Blank means "use the company name", which is what the form prefills.
    const slug = text(formData, "slug") || slugFrom(companyName);

    const result = await signUp({
      companyName,
      slug,
      ownerName: text(formData, "ownerName"),
      email: text(formData, "email"),
      password: text(formData, "password"),
    });

    // Straight in, rather than back to a login form they just filled in.
    await createSession(result.userId);

    // The company details are asked for here, not at signup: eleven fields
    // before seeing the product is how a signup gets abandoned.
    redirect("/settings?welcome=1");
  });
}

// ---------------------------------------------------------------------------
// The letterhead
// ---------------------------------------------------------------------------

export async function updateWorkspaceAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const user = await requireUserOrThrow();

    await updateOrganisation(user, {
      name: fieldIfPresent(formData, "name"),
      legalName: fieldIfPresent(formData, "legalName"),
      address: fieldIfPresent(formData, "address"),
      gstin: fieldIfPresent(formData, "gstin"),
      phone: fieldIfPresent(formData, "phone"),
      email: fieldIfPresent(formData, "email"),
      website: fieldIfPresent(formData, "website"),
      bankBeneficiary: fieldIfPresent(formData, "bankBeneficiary"),
      bankName: fieldIfPresent(formData, "bankName"),
      bankAccount: fieldIfPresent(formData, "bankAccount"),
      bankIfsc: fieldIfPresent(formData, "bankIfsc"),
      bankAccountType: fieldIfPresent(formData, "bankAccountType"),
      bankBranch: fieldIfPresent(formData, "bankBranch"),
      quotationSubject: fieldIfPresent(formData, "quotationSubject"),
      quotationNote: fieldIfPresent(formData, "quotationNote"),
      quotationTerms: fieldIfPresent(formData, "quotationTerms"),
      defaultUom: fieldIfPresent(formData, "defaultUom"),
    });

    refresh();
    return ok(undefined, "Saved. This is what prints on your quotations now.");
  });
}

export async function uploadLogoAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const user = await requireUserOrThrow();

    const file = formData.get("logo");
    if (!(file instanceof File) || file.size === 0) {
      return fail("Choose an image file.", "VALIDATION", { logo: "Choose a file" });
    }

    await setLogo(user, {
      bytes: new Uint8Array(await file.arrayBuffer()),
      mime: file.type,
    });

    refresh();
    return ok(undefined, "Logo updated.");
  });
}

export async function removeLogoAction(): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const user = await requireUserOrThrow();
    await clearLogo(user);
    refresh();
    return ok(undefined, "Logo removed.");
  });
}

/** Everywhere the letterhead is read from. */
function refresh(): void {
  revalidatePath("/settings");
  revalidatePath("/quotations");
  revalidatePath("/quotations/[id]", "page");
}
