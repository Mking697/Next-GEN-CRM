/**
 * The letterhead.
 *
 * One definition, read by both the on-screen quotation and the PDF, so the
 * document a customer sees on a link and the document they get as a file can
 * never disagree about who sent it or where to pay.
 *
 * Everything is overridable from the environment for the same reason the rest
 * of the app is: none of it should need a code change and a redeploy.
 *
 * The fallbacks below are deliberately obvious placeholders, not real details.
 * A quotation is a document a customer acts on - they pay against the account
 * printed on it - so a fallback that LOOKS like a real bank account is the
 * dangerous kind. If the environment is not configured, the PDF has to say so
 * loudly rather than quietly print something plausible and wrong.
 */

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : fallback;
}

export const COMPANY = {
  get name() {
    return env("COMPANY_NAME", "SET COMPANY_NAME");
  },
  get address() {
    return env("COMPANY_ADDRESS", "SET COMPANY_ADDRESS");
  },
  /** Empty is valid: the PDF simply renders without a logo. */
  get logoUrl() {
    return env("COMPANY_LOGO_URL", "");
  },
} as const;

export const BANK = {
  get beneficiary() {
    return env("BANK_BENEFICIARY", "SET BANK_BENEFICIARY");
  },
  get name() {
    return env("BANK_NAME", "SET BANK_NAME");
  },
  get account() {
    return env("BANK_ACCOUNT", "SET BANK_ACCOUNT");
  },
  get ifsc() {
    return env("BANK_IFSC", "SET BANK_IFSC");
  },
  get accountType() {
    return env("BANK_ACCOUNT_TYPE", "SET BANK_ACCOUNT_TYPE");
  },
  get branch() {
    return env("BANK_BRANCH", "SET BANK_BRANCH");
  },
} as const;

/** Flattened for the PDF renderer, which cannot use getters lazily. */
export function letterhead() {
  return {
    company: {
      name: COMPANY.name,
      address: COMPANY.address,
      logoUrl: COMPANY.logoUrl,
    },
    bank: {
      beneficiary: BANK.beneficiary,
      name: BANK.name,
      account: BANK.account,
      ifsc: BANK.ifsc,
      accountType: BANK.accountType,
      branch: BANK.branch,
    },
  };
}
