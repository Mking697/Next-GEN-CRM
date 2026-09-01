import "server-only";
import { prisma } from "@/lib/db";
import { env, isGoogleEnabled } from "@/lib/env";
import { readRange } from "@/lib/google";
import { cleanText, normalizeEmail, normalizePhone } from "@/lib/dedupe";
import { requirePermission } from "@/lib/permissions";
import type { SessionUser } from "@/lib/session";
import { audit } from "./audit";

/**
 * Bringing the Clientdata sheet into the CRM.
 *
 * Read-only against Google and idempotent: running it twice does not create
 * duplicates and never overwrites something a person has since typed. Only
 * empty fields are filled in, which is the same rule lead ingest follows.
 *
 * Column A of the sheet is a person's name, typed by whoever built the sheet.
 * Matching that to a CRM account is the one genuinely risky part, so it is
 * done by exact normalised name or by an explicit alias an admin sets, never
 * by fuzzy similarity. Anything that does not match is imported unassigned
 * and reported by name, so it can be fixed deliberately.
 */

export interface ImportReport {
  read: number;
  created: number;
  updated: number;
  skipped: number;
  /** Sheet spellings that matched nobody, with how many clients each holds. */
  unmatched: { name: string; clients: number }[];
  matched: { sheetName: string; crmName: string; clients: number }[];
}

/** Lowercased, whitespace-collapsed. "  SUDHIR  KUMAR " -> "sudhir kumar". */
function normaliseName(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export async function importClientsFromSheet(
  user: SessionUser,
): Promise<ImportReport> {
  requirePermission(user.role, "integration.sync.run");

  if (!isGoogleEnabled()) {
    throw new Error(
      "Google is not configured, so there is no sheet to import from.",
    );
  }

  const rows = await readRange(`${env.GOOGLE_SHEET_CLIENTS_TAB}!A2:F`);

  // -- who can own a client ------------------------------------------------
  const salesmen = await prisma.user.findMany({
    where: { role: "SALESMAN" },
    select: { id: true, name: true, sheetAlias: true },
  });

  const byName = new Map<string, { id: string; name: string }>();
  for (const salesman of salesmen) {
    byName.set(normaliseName(salesman.name), salesman);
    if (salesman.sheetAlias) {
      // The alias wins: it exists precisely because the sheet spells this
      // person differently from the CRM.
      byName.set(normaliseName(salesman.sheetAlias), salesman);
    }
  }

  const report: ImportReport = {
    read: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    unmatched: [],
    matched: [],
  };

  const unmatchedCounts = new Map<string, number>();
  const matchedCounts = new Map<string, { crmName: string; count: number }>();

  for (const row of rows) {
    const executiveRaw = cleanText(row[0], 120);
    const clientName = cleanText(row[1], 200);
    if (!clientName) {
      report.skipped += 1;
      continue;
    }
    report.read += 1;

    const gstin = cleanText(row[2], 20);
    const emailRaw = cleanText(row[3], 254);
    const phoneRaw = cleanText(row[4], 40);
    const contactName = cleanText(row[5], 160);

    const email = emailRaw ? (normalizeEmail(emailRaw) ?? null) : null;
    const phone = phoneRaw && normalizePhone(phoneRaw) ? phoneRaw : null;

    const salesman = executiveRaw
      ? (byName.get(normaliseName(executiveRaw)) ?? null)
      : null;

    if (executiveRaw) {
      if (salesman) {
        const entry = matchedCounts.get(executiveRaw) ?? {
          crmName: salesman.name,
          count: 0,
        };
        entry.count += 1;
        matchedCounts.set(executiveRaw, entry);
      } else {
        unmatchedCounts.set(
          executiveRaw,
          (unmatchedCounts.get(executiveRaw) ?? 0) + 1,
        );
      }
    }

    // -- upsert the company ------------------------------------------------
    // Matched on name because that is the only stable identifier the sheet
    // has. Two genuinely different companies with identical names would
    // merge, which is why the sheet spelling is kept alongside.
    const existing = await prisma.company.findFirst({
      where: { name: clientName },
      select: {
        id: true,
        gstin: true,
        salesmanId: true,
        sheetSalesExecutive: true,
        contacts: { select: { id: true, name: true, phone: true, email: true } },
      },
    });

    if (!existing) {
      await prisma.company.create({
        data: {
          name: clientName,
          gstin,
          salesmanId: salesman?.id ?? null,
          sheetSalesExecutive: executiveRaw,
          contacts:
            contactName || phone || email
              ? {
                  create: {
                    name: contactName ?? clientName,
                    phone,
                    email,
                  },
                }
              : undefined,
        },
      });
      report.created += 1;
      continue;
    }

    // Fill gaps only. Anything already set was either imported before or
    // typed by a person, and neither should be clobbered by a re-run.
    const patch: Record<string, unknown> = {};
    if (!existing.gstin && gstin) patch.gstin = gstin;
    if (!existing.salesmanId && salesman) patch.salesmanId = salesman.id;
    if (!existing.sheetSalesExecutive && executiveRaw) {
      patch.sheetSalesExecutive = executiveRaw;
    }

    let touched = false;
    if (Object.keys(patch).length > 0) {
      await prisma.company.update({ where: { id: existing.id }, data: patch });
      touched = true;
    }

    if (existing.contacts.length === 0 && (contactName || phone || email)) {
      await prisma.contact.create({
        data: {
          companyId: existing.id,
          name: contactName ?? clientName,
          phone,
          email,
        },
      });
      touched = true;
    } else {
      const contact = existing.contacts[0];
      if (contact) {
        const contactPatch: Record<string, unknown> = {};
        if (!contact.phone && phone) contactPatch.phone = phone;
        if (!contact.email && email) contactPatch.email = email;
        if (Object.keys(contactPatch).length > 0) {
          await prisma.contact.update({
            where: { id: contact.id },
            data: contactPatch,
          });
          touched = true;
        }
      }
    }

    if (touched) report.updated += 1;
    else report.skipped += 1;
  }

  report.unmatched = [...unmatchedCounts]
    .map(([name, clients]) => ({ name, clients }))
    .sort((a, b) => b.clients - a.clients);

  report.matched = [...matchedCounts]
    .map(([sheetName, entry]) => ({
      sheetName,
      crmName: entry.crmName,
      clients: entry.count,
    }))
    .sort((a, b) => b.clients - a.clients);

  await audit(prisma, {
    action: "client.import",
    actorId: user.id,
    detail: `${user.name} imported clients from the sheet: ${report.read} read, ${report.created} created, ${report.updated} updated, ${report.unmatched.length} sales executive(s) unmatched`,
  });

  return report;
}

/** What the People page needs to offer sheetAlias editing sensibly. */
export async function unmatchedExecutives(): Promise<
  { name: string; clients: number }[]
> {
  const rows = await prisma.company.groupBy({
    by: ["sheetSalesExecutive"],
    where: { salesmanId: null, sheetSalesExecutive: { not: null } },
    _count: { _all: true },
  });

  return rows
    .filter((row) => row.sheetSalesExecutive)
    .map((row) => ({
      name: row.sheetSalesExecutive as string,
      clients: row._count._all,
    }))
    .sort((a, b) => b.clients - a.clients);
}
