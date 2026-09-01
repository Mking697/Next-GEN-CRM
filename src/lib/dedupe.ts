/**
 * Normalisation for the two fields leads are deduplicated on.
 *
 * The same enquiry routinely arrives twice: once through IndiaMART and once
 * through a Meta lead form, written differently each time. "+91 98765 43210",
 * "098765 43210" and "9876543210" are one person. The normalised value is
 * stored in Lead.phoneKey / Lead.emailKey, both of which carry a unique index,
 * so the database itself is the last line of defence against a duplicate.
 */

/**
 * Digits-only phone key. Indian numbers collapse to the 10-digit subscriber
 * number so the country code cannot create a second row; anything else keeps
 * its full digit string.
 *
 * Returns null for anything too short to be a real number, which correctly
 * leaves the column NULL. Postgres treats every NULL in a unique index as
 * distinct, so any number of leads may have no phone at all.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let digits = raw.replace(/\D/g, "");
  if (digits.length === 0) return null;

  // 00 prefix is an alternative way of writing +
  if (digits.startsWith("00")) digits = digits.slice(2);

  // India: 91 + 10 digits, or a single trunk 0 + 10 digits.
  if (digits.length === 12 && digits.startsWith("91")) {
    digits = digits.slice(2);
  } else if (digits.length === 11 && digits.startsWith("0")) {
    digits = digits.slice(1);
  }

  // Too short to identify anybody.
  if (digits.length < 7) return null;
  // Absurdly long: keep it, but cap so a junk field cannot bloat the index.
  if (digits.length > 15) digits = digits.slice(-15);

  return digits;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * Lowercased, trimmed email key. Returns null for anything that is not
 * email-shaped, because lead sources happily send "NA", "-" and "test" in
 * that field and those must not all collide on one unique key.
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;

  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 254) return null;
  if (!EMAIL_SHAPE.test(trimmed)) return null;

  // Obvious placeholders the lead sources emit.
  const placeholders = new Set([
    "na@na.com",
    "test@test.com",
    "no@email.com",
    "none@none.com",
    "abc@abc.com",
  ]);
  if (placeholders.has(trimmed)) return null;

  return trimmed;
}

/** Collapse whitespace and drop empties, for optional free-text fields. */
export function cleanText(
  raw: string | null | undefined,
  maxLength = 500,
): string | null {
  if (!raw) return null;
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, maxLength);
}

/** Display phone, for the UI. Falls back to the raw string when unsure. */
export function formatPhone(raw: string | null | undefined): string {
  if (!raw) return "-";
  const key = normalizePhone(raw);
  if (key && key.length === 10) return `${key.slice(0, 5)} ${key.slice(5)}`;
  return raw;
}

/**
 * The `where` clause that finds an existing lead for this phone or email.
 * Returns null when neither key is usable, meaning there is nothing to
 * deduplicate on and the lead should simply be created.
 */
export function dedupeWhere(
  phoneKey: string | null,
  emailKey: string | null,
): { OR: ({ phoneKey: string } | { emailKey: string })[] } | null {
  const clauses: ({ phoneKey: string } | { emailKey: string })[] = [];
  if (phoneKey) clauses.push({ phoneKey });
  if (emailKey) clauses.push({ emailKey });
  return clauses.length > 0 ? { OR: clauses } : null;
}
