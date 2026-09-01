import "server-only";
import { prisma } from "@/lib/db";

/**
 * Who a quotation says it is from.
 *
 * This used to be seven environment variables, which could only ever describe
 * one company. Now it is read from the organisation the document belongs to,
 * because a quotation is a document a customer acts on - they pay against the
 * account printed on it - and every field on it has to belong to the company
 * that sent it.
 *
 * The logo is stored as bytes rather than a link. A quotation goes out and is
 * kept; pointing at an image host means the day that host moves the file,
 * every document ever sent renders with a hole in it. A few kilobytes in a
 * column buys certainty.
 */

export interface Letterhead {
  company: {
    name: string;
    legalName: string | null;
    address: string | null;
    gstin: string | null;
    phone: string | null;
    email: string | null;
    website: string | null;
  };
  bank: {
    beneficiary: string | null;
    name: string | null;
    account: string | null;
    ifsc: string | null;
    accountType: string | null;
    branch: string | null;
  };
  /** A data URI, ready to render, or null when no logo has been uploaded. */
  logo: string | null;
  /** True when nothing but the workspace name has been filled in yet. */
  isBlank: boolean;
}

export async function getLetterhead(orgId: string): Promise<Letterhead> {
  const org = await prisma.organisation.findUnique({
    where: { id: orgId },
    select: {
      name: true,
      legalName: true,
      address: true,
      gstin: true,
      phone: true,
      email: true,
      website: true,
      logo: true,
      logoMime: true,
      bankBeneficiary: true,
      bankName: true,
      bankAccount: true,
      bankIfsc: true,
      bankAccountType: true,
      bankBranch: true,
    },
  });

  if (!org) {
    // Should be unreachable: the caller holds a session in this organisation.
    throw new Error(`No organisation ${orgId}`);
  }

  return {
    company: {
      name: org.legalName?.trim() || org.name,
      legalName: org.legalName,
      address: org.address,
      gstin: org.gstin,
      phone: org.phone,
      email: org.email,
      website: org.website,
    },
    bank: {
      beneficiary: org.bankBeneficiary,
      name: org.bankName,
      account: org.bankAccount,
      ifsc: org.bankIfsc,
      accountType: org.bankAccountType,
      branch: org.bankBranch,
    },
    logo:
      org.logo && org.logoMime
        ? `data:${org.logoMime};base64,${Buffer.from(org.logo).toString("base64")}`
        : null,
    isBlank: !org.address && !org.bankAccount,
  };
}

/**
 * What a customer sees when a field has not been filled in.
 *
 * An empty string, not a placeholder. A quotation printing "SET BANK_ACCOUNT"
 * would be worse than one printing nothing: the second is visibly incomplete,
 * the first looks like a value. The settings page is where the nagging
 * belongs, and it does nag.
 */
export function line(value: string | null | undefined): string {
  return value?.trim() ?? "";
}
