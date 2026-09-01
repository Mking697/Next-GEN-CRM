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
      name: text(formData, "name"),
      legalName: optional(formData, "legalName"),
      address: optional(formData, "address"),
      gstin: optional(formData, "gstin"),
      phone: optional(formData, "phone"),
      email: optional(formData, "email"),
      website: optional(formData, "website"),
      bankBeneficiary: optional(formData, "bankBeneficiary"),
      bankName: optional(formData, "bankName"),
      bankAccount: optional(formData, "bankAccount"),
      bankIfsc: optional(formData, "bankIfsc"),
      bankAccountType: optional(formData, "bankAccountType"),
      bankBranch: optional(formData, "bankBranch"),
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
