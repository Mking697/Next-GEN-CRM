import "server-only";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { ValidationError } from "@/lib/errors";
import { requirePermission } from "@/lib/permissions";
import type { SessionUser } from "@/lib/session";
import { cleanText, normalizeEmail } from "@/lib/dedupe";
import { audit } from "./audit";

/**
 * A company's own details: what prints at the top of its quotations, and the
 * account its customers pay into.
 *
 * Every field here is read by a customer, which is why the validation is
 * stricter than it looks like it needs to be. A GSTIN with a typo or an IFSC
 * with the wrong number of characters does not fail loudly - it prints, the
 * customer pays into nowhere, and somebody finds out a week later.
 */

export interface OrganisationSettings {
  id: string;
  slug: string;
  name: string;
  legalName: string | null;
  address: string | null;
  gstin: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  bankBeneficiary: string | null;
  bankName: string | null;
  bankAccount: string | null;
  bankIfsc: string | null;
  bankAccountType: string | null;
  bankBranch: string | null;
  hasLogo: boolean;
  quotationNumberStart: number;
  quotationSubject: string | null;
  quotationNote: string | null;
  quotationTerms: string | null;
}

export async function getOrganisation(
  user: SessionUser,
): Promise<OrganisationSettings> {
  requirePermission(user.role, "workspace.view");

  const org = await prisma.organisation.findUniqueOrThrow({
    where: { id: user.orgId },
    select: {
      id: true,
      slug: true,
      name: true,
      legalName: true,
      address: true,
      gstin: true,
      phone: true,
      email: true,
      website: true,
      bankBeneficiary: true,
      bankName: true,
      bankAccount: true,
      bankIfsc: true,
      bankAccountType: true,
      bankBranch: true,
      logoMime: true,
      quotationNumberStart: true,
      quotationSubject: true,
      quotationNote: true,
      quotationTerms: true,
    },
  });

  const { logoMime, ...rest } = org;
  return { ...rest, hasLogo: logoMime !== null };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** 22AAAAA0000A1Z5 - state code, PAN, entity digit, Z, checksum. */
const GSTIN = /^[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
/** Four letters, a 0, then six alphanumerics. */
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export interface OrganisationInput {
  name?: string | null;
  legalName?: string | null;
  address?: string | null;
  gstin?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  bankBeneficiary?: string | null;
  bankName?: string | null;
  bankAccount?: string | null;
  bankIfsc?: string | null;
  bankAccountType?: string | null;
  bankBranch?: string | null;
  quotationSubject?: string | null;
  quotationNote?: string | null;
  quotationTerms?: string | null;
}

export async function updateOrganisation(
  user: SessionUser,
  input: OrganisationInput,
): Promise<void> {
  requirePermission(user.role, "workspace.edit");

  const fieldErrors: Record<string, string> = {};

  const name = cleanText(input.name, 120);
  if (input.name !== undefined && !name) {
    fieldErrors.name = "Your company needs a name";
  }

  const gstin = cleanText(input.gstin, 20)?.toUpperCase() ?? null;
  if (gstin && !GSTIN.test(gstin)) {
    fieldErrors.gstin = "That is not a valid GSTIN - 15 characters, like 09AAACH7409R1ZZ";
  }

  const bankIfsc = cleanText(input.bankIfsc, 11)?.toUpperCase() ?? null;
  if (bankIfsc && !IFSC.test(bankIfsc)) {
    fieldErrors.bankIfsc = "That is not a valid IFSC - 11 characters, like HDFC0001234";
  }

  const bankAccount = cleanText(input.bankAccount, 30);
  if (bankAccount && !/^[0-9]{5,20}$/.test(bankAccount.replace(/\s/g, ""))) {
    fieldErrors.bankAccount = "An account number is 5 to 20 digits";
  }

  const emailRaw = cleanText(input.email, 254);
  const email = emailRaw ? normalizeEmail(emailRaw) : null;
  if (emailRaw && !email) {
    fieldErrors.email = "That does not look like an email address";
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new ValidationError(
      "Some of these are not right. A customer reads every one of them.",
      fieldErrors,
    );
  }

  /*
   * Only the fields that were actually sent.
   *
   * The Settings page has three separate forms, each posting its own section,
   * and a field this one does not mention has to be LEFT ALONE. Treating an
   * absent field as "clear it" meant saving the letterhead silently wiped the
   * bank account - the customer's next quotation would have told them to pay
   * into nothing. Undefined means untouched; an empty string still clears.
   */
  const data: Prisma.OrganisationUpdateInput = {};
  const set = <K extends keyof Prisma.OrganisationUpdateInput>(
    key: K,
    provided: unknown,
    value: Prisma.OrganisationUpdateInput[K],
  ) => {
    if (provided !== undefined) data[key] = value;
  };

  if (name) data.name = name;
  set("legalName", input.legalName, cleanText(input.legalName, 160));
  set("address", input.address, cleanText(input.address, 400));
  set("gstin", input.gstin, gstin);
  set("phone", input.phone, cleanText(input.phone, 40));
  set("email", input.email, email);
  set("website", input.website, cleanText(input.website, 200));
  set("bankBeneficiary", input.bankBeneficiary, cleanText(input.bankBeneficiary, 160));
  set("bankName", input.bankName, cleanText(input.bankName, 120));
  set("bankAccount", input.bankAccount, bankAccount?.replace(/\s/g, "") ?? null);
  set("bankIfsc", input.bankIfsc, bankIfsc);
  set("bankAccountType", input.bankAccountType, cleanText(input.bankAccountType, 40));
  set("bankBranch", input.bankBranch, cleanText(input.bankBranch, 120));
  // Long free text, so cleanText's whitespace collapsing would destroy the
  // line breaks that make a terms list readable.
  set("quotationSubject", input.quotationSubject, longText(input.quotationSubject, 500));
  set("quotationNote", input.quotationNote, longText(input.quotationNote, 2000));
  set("quotationTerms", input.quotationTerms, longText(input.quotationTerms, 8000));

  await prisma.$transaction(async (tx) => {
    await tx.organisation.update({ where: { id: user.orgId }, data });

    await audit(tx, {
      orgId: user.orgId,
      action: "workspace.update",
      actorId: user.id,
      targetType: "Organisation",
      targetId: user.orgId,
      detail: `${user.name} changed the company details that print on quotations`,
    });
  });
}

/**
 * Free text that has to keep its line breaks.
 *
 * cleanText collapses every run of whitespace into one space, which is right
 * for a name or a city and wrong for nine numbered terms - it would run them
 * into a single paragraph.
 */
function longText(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  const trimmed = value.replace(/\r\n/g, "\n").trim().slice(0, max);
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// The logo
// ---------------------------------------------------------------------------

/** What a quotation can actually render. */
const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/gif"]);
const LOGO_MAX_BYTES = 512 * 1024;

export async function setLogo(
  user: SessionUser,
  file: { bytes: Uint8Array; mime: string },
): Promise<void> {
  requirePermission(user.role, "workspace.edit");

  if (!LOGO_TYPES.has(file.mime)) {
    throw new ValidationError(
      "A logo has to be a PNG, JPEG or GIF. SVG is not accepted, because the PDF renderer cannot draw one.",
      { logo: "PNG, JPEG or GIF only" },
    );
  }
  if (file.bytes.byteLength === 0) {
    throw new ValidationError("That file is empty.", { logo: "Choose a file" });
  }
  if (file.bytes.byteLength > LOGO_MAX_BYTES) {
    throw new ValidationError(
      `That logo is ${Math.round(file.bytes.byteLength / 1024)}KB. Keep it under 512KB - it is printed about 3cm wide.`,
      { logo: "Too large" },
    );
  }

  await prisma.organisation.update({
    where: { id: user.orgId },
    data: { logo: new Uint8Array(file.bytes), logoMime: file.mime },
  });
}

export async function clearLogo(user: SessionUser): Promise<void> {
  requirePermission(user.role, "workspace.edit");
  await prisma.organisation.update({
    where: { id: user.orgId },
    data: { logo: null, logoMime: null },
  });
}

/** The raw bytes, for the route that serves them. */
export async function readLogo(
  orgId: string,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const org = await prisma.organisation.findUnique({
    where: { id: orgId },
    select: { logo: true, logoMime: true },
  });
  if (!org?.logo || !org.logoMime) return null;
  return { bytes: new Uint8Array(org.logo), mime: org.logoMime };
}
