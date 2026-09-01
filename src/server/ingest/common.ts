import "server-only";
import { prisma } from "@/lib/db";
import type { LeadSource } from "@/generated/prisma/enums";
import { cleanText, normalizeEmail, normalizePhone } from "@/lib/dedupe";

/**
 * The single door every automatically-ingested lead comes through.
 *
 * Deduplication happens on three levels, cheapest first:
 *
 *   1. The provider's own id, so replaying the same IndiaMART window or the
 *      same Meta webhook delivery is a no-op.
 *   2. The normalised phone and email keys, so the same person arriving once
 *      through IndiaMART and once through a Meta form is one lead.
 *   3. The unique indexes themselves. Two concurrent webhook deliveries can
 *      both pass step 2, and the database still refuses the second write.
 *      That is caught here and reported as a duplicate rather than a failure.
 *
 * When a duplicate carries information the stored lead is missing, the gaps
 * are filled in. Nothing that is already there is ever overwritten.
 */

export interface IncomingLead {
  source: LeadSource;
  externalId?: string | null;
  personName: string;
  phone?: string | null;
  email?: string | null;
  companyName?: string | null;
  city?: string | null;
  state?: string | null;
  product?: string | null;
  message?: string | null;
  receivedAt?: Date | null;
}

export type IngestOutcome = "created" | "duplicate" | "enriched" | "skipped";

export interface IngestResult {
  outcome: IngestOutcome;
  leadId: string | null;
}

export async function ingestLead(input: IncomingLead): Promise<IngestResult> {
  const personName =
    cleanText(input.personName, 160) ??
    cleanText(input.companyName, 160) ??
    cleanText(input.phone, 160) ??
    "Unknown";

  const phone = cleanText(input.phone, 40);
  const email = cleanText(input.email, 254);
  const phoneKey = normalizePhone(phone);
  const emailKey = normalizeEmail(email);
  const externalId = cleanText(input.externalId, 120);

  // 1. Same delivery, seen before.
  if (externalId) {
    const seen = await prisma.lead.findUnique({
      where: { source_externalId: { source: input.source, externalId } },
      select: { id: true },
    });
    if (seen) return { outcome: "duplicate", leadId: seen.id };
  }

  const fields = {
    phone,
    email,
    companyName: cleanText(input.companyName, 200),
    city: cleanText(input.city, 100),
    state: cleanText(input.state, 100),
    product: cleanText(input.product, 200),
    message: cleanText(input.message, 2000),
  };

  // 2. Same person, different source.
  const keyClauses: ({ phoneKey: string } | { emailKey: string })[] = [];
  if (phoneKey) keyClauses.push({ phoneKey });
  if (emailKey) keyClauses.push({ emailKey });

  if (keyClauses.length > 0) {
    const existing = await prisma.lead.findFirst({
      where: { OR: keyClauses },
      select: {
        id: true,
        phone: true,
        email: true,
        companyName: true,
        city: true,
        state: true,
        product: true,
        message: true,
      },
    });
    if (existing) {
      const filled = fillGaps(existing, fields);
      if (Object.keys(filled).length > 0) {
        await prisma.lead.update({ where: { id: existing.id }, data: filled });
        await prisma.leadActivity.create({
          data: {
            leadId: existing.id,
            kind: "NOTE",
            message: `The same enquiry arrived again from ${input.source}. Missing details were filled in; nothing existing was changed.`,
          },
        });
        return { outcome: "enriched", leadId: existing.id };
      }
      return { outcome: "duplicate", leadId: existing.id };
    }
  }

  // 3. Genuinely new.
  try {
    const lead = await prisma.lead.create({
      data: {
        source: input.source,
        status: "NEW",
        externalId,
        personName,
        phoneKey,
        emailKey,
        receivedAt: input.receivedAt ?? new Date(),
        ...fields,
        activities: {
          create: {
            kind: "NOTE",
            message: `Lead received from ${input.source}`,
          },
        },
      },
      select: { id: true },
    });
    return { outcome: "created", leadId: lead.id };
  } catch (error) {
    // Another delivery of the same lead landed between our check and our
    // write. The unique index did its job.
    if (isUniqueViolation(error)) {
      const clash = await findByKeys(input.source, externalId, phoneKey, emailKey);
      return { outcome: "duplicate", leadId: clash };
    }
    throw error;
  }
}

type Gapful = Record<string, string | null>;

/** Only writes keys the stored row has left empty. */
function fillGaps(existing: Gapful, incoming: Gapful): Record<string, string> {
  const patch: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value && !existing[key]) patch[key] = value;
  }
  return patch;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

async function findByKeys(
  source: LeadSource,
  externalId: string | null,
  phoneKey: string | null,
  emailKey: string | null,
): Promise<string | null> {
  const clauses: object[] = [];
  if (externalId) clauses.push({ source, externalId });
  if (phoneKey) clauses.push({ phoneKey });
  if (emailKey) clauses.push({ emailKey });
  if (clauses.length === 0) return null;

  const found = await prisma.lead.findFirst({
    where: { OR: clauses },
    select: { id: true },
  });
  return found?.id ?? null;
}

// ---------------------------------------------------------------------------
// Sync bookkeeping
// ---------------------------------------------------------------------------

export interface SyncTally {
  fetched: number;
  created: number;
  duplicates: number;
}

export function emptyTally(): SyncTally {
  return { fetched: 0, created: 0, duplicates: 0 };
}

export function tally(result: IngestResult, into: SyncTally): void {
  into.fetched += 1;
  if (result.outcome === "created") into.created += 1;
  else into.duplicates += 1;
}
