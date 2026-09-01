import "server-only";
import { prisma } from "@/lib/db";
import type { Db } from "@/lib/db";
import { formatPaise, toBigIntPaise, toPaise } from "@/lib/money";
import { formatQtyMilli } from "@/lib/quotation-math";
import type { SessionUser } from "@/lib/session";

/**
 * Rework history.
 *
 * A quotation gets negotiated: a rate moves, a line is added, freight
 * appears. "What did we send them last time, and what has changed since?" is
 * a question people genuinely need answered, and reassembling it from a log of
 * individual field writes is guesswork. So every save stores the whole
 * document, and the difference against the previous save is worked out and
 * written down in sentences at the moment it happens, while both versions are
 * in hand.
 */

export interface RevisionSnapshot {
  status: string;
  partyName: string;
  contactPerson: string | null;
  customerMobile: string | null;
  customerEmail: string | null;
  customerGst: string | null;
  billing: string;
  shipping: string;
  subject: string | null;
  note: string | null;
  terms: string | null;
  freightPaise: number;
  gstPercent: number;
  subTotalPaise: number;
  gstPaise: number;
  payablePaise: number;
  items: SnapshotItem[];
}

export interface SnapshotItem {
  particular: string;
  panelThickness: string;
  specs: string;
  sheetThickness: string;
  description: string;
  uom: string;
  /** The expression the quantity came from, so an archived version keeps
   *  the working and not just the answer. */
  qtyFormula: string;
  qtyMilli: number;
  ratePaise: number;
  amountPaise: number;
}

function addressLine(parts: (string | null)[]): string {
  return parts.filter((p) => p && p.trim().length > 0).join(", ");
}

/** Read the current state of a quotation into a comparable shape. */
export async function snapshotQuotation(
  db: Db,
  quotationId: string,
): Promise<RevisionSnapshot> {
  const row = await db.quotation.findUniqueOrThrow({
    where: { id: quotationId },
    select: {
      status: true,
      partyName: true,
      contactPerson: true,
      customerMobile: true,
      customerEmail: true,
      customerGst: true,
      billingStreet: true,
      billingCity: true,
      billingState: true,
      billingPincode: true,
      shippingPartyName: true,
      shippingStreet: true,
      shippingCity: true,
      shippingState: true,
      shippingPincode: true,
      subject: true,
      note: true,
      terms: true,
      freightPaise: true,
      gstPercent: true,
      subTotalPaise: true,
      gstPaise: true,
      payablePaise: true,
      items: { orderBy: { position: "asc" } },
    },
  });

  return {
    status: row.status,
    partyName: row.partyName,
    contactPerson: row.contactPerson,
    customerMobile: row.customerMobile,
    customerEmail: row.customerEmail,
    customerGst: row.customerGst,
    billing: addressLine([
      row.billingStreet,
      row.billingCity,
      row.billingState,
      row.billingPincode,
    ]),
    shipping: addressLine([
      row.shippingPartyName,
      row.shippingStreet,
      row.shippingCity,
      row.shippingState,
      row.shippingPincode,
    ]),
    subject: row.subject,
    note: row.note,
    terms: row.terms,
    freightPaise: toPaise(row.freightPaise),
    gstPercent: row.gstPercent,
    subTotalPaise: toPaise(row.subTotalPaise),
    gstPaise: toPaise(row.gstPaise),
    payablePaise: toPaise(row.payablePaise),
    items: row.items.map((item) => ({
      particular: item.particular ?? "",
      panelThickness: item.panelThickness ?? "",
      specs: item.specs ?? "",
      sheetThickness: item.sheetThickness ?? "",
      description: item.description ?? "",
      uom: item.uom ?? "",
      qtyFormula: item.qtyFormula ?? "",
      qtyMilli: item.qtyMilli,
      ratePaise: toPaise(item.ratePaise),
      amountPaise: toPaise(item.amountPaise),
    })),
  };
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

const HEADER_FIELDS: {
  key: keyof RevisionSnapshot;
  label: string;
  money?: boolean;
  percent?: boolean;
  long?: boolean;
}[] = [
  { key: "partyName", label: "Party name" },
  { key: "contactPerson", label: "Kind attention" },
  { key: "customerMobile", label: "Mobile" },
  { key: "customerEmail", label: "Email" },
  { key: "customerGst", label: "GST" },
  { key: "billing", label: "Billing address" },
  { key: "shipping", label: "Delivery address" },
  { key: "subject", label: "Subject", long: true },
  { key: "note", label: "Note", long: true },
  { key: "terms", label: "Terms", long: true },
  { key: "freightPaise", label: "Freight", money: true },
  { key: "gstPercent", label: "GST rate", percent: true },
];

const ITEM_FIELDS: { key: keyof SnapshotItem; label: string }[] = [
  { key: "particular", label: "particular" },
  { key: "panelThickness", label: "panel thickness" },
  { key: "specs", label: "specs" },
  { key: "sheetThickness", label: "sheet thickness" },
  { key: "description", label: "description" },
  { key: "uom", label: "UOM" },
];

function show(value: unknown): string {
  if (value === null || value === undefined || value === "") return "(blank)";
  return String(value);
}

/** A long field is reported as changed rather than quoted in full. */
function describeLong(label: string, before: unknown, after: unknown): string {
  const a = String(before ?? "").trim();
  const b = String(after ?? "").trim();
  if (a.length === 0 && b.length > 0) return `${label} added`;
  if (a.length > 0 && b.length === 0) return `${label} cleared`;
  return `${label} edited`;
}

function itemLabel(item: SnapshotItem, position: number): string {
  const name = item.particular.trim() || item.description.trim().slice(0, 30);
  return name ? `line ${position} (${name})` : `line ${position}`;
}

/**
 * Compare two saves and describe the difference in sentences.
 *
 * Lines are matched by position, which is how the person editing thinks about
 * them: row 2 is row 2. Reordering therefore reads as several changed lines
 * rather than a move, which is honest about what the grid actually stored.
 */
export function diffSnapshots(
  before: RevisionSnapshot,
  after: RevisionSnapshot,
): string[] {
  const changes: string[] = [];

  for (const field of HEADER_FIELDS) {
    const a = before[field.key];
    const b = after[field.key];
    if (a === b) continue;

    if (field.long) {
      changes.push(describeLong(field.label, a, b));
    } else if (field.money) {
      changes.push(
        `${field.label}: ${formatPaise(Number(a))} to ${formatPaise(Number(b))}`,
      );
    } else if (field.percent) {
      changes.push(`${field.label}: ${a}% to ${b}%`);
    } else {
      changes.push(`${field.label}: ${show(a)} to ${show(b)}`);
    }
  }

  const maxLines = Math.max(before.items.length, after.items.length);
  for (let index = 0; index < maxLines; index += 1) {
    const a = before.items[index];
    const b = after.items[index];
    const position = index + 1;

    if (!a && b) {
      changes.push(
        `Added ${itemLabel(b, position)}: ${formatQtyMilli(b.qtyMilli)} ${b.uom} at ${formatPaise(b.ratePaise)} = ${formatPaise(b.amountPaise)}`,
      );
      continue;
    }
    if (a && !b) {
      changes.push(
        `Removed ${itemLabel(a, position)} (was ${formatPaise(a.amountPaise)})`,
      );
      continue;
    }
    if (!a || !b) continue;

    for (const field of ITEM_FIELDS) {
      if (a[field.key] !== b[field.key]) {
        changes.push(
          `Line ${position} ${field.label}: ${show(a[field.key])} to ${show(b[field.key])}`,
        );
      }
    }
    if (a.qtyMilli !== b.qtyMilli) {
      changes.push(
        `Line ${position} quantity: ${formatQtyMilli(a.qtyMilli)} to ${formatQtyMilli(b.qtyMilli)}`,
      );
    }
    if (a.ratePaise !== b.ratePaise) {
      changes.push(
        `Line ${position} rate: ${formatPaise(a.ratePaise)} to ${formatPaise(b.ratePaise)}`,
      );
    }
  }

  if (before.payablePaise !== after.payablePaise) {
    const delta = after.payablePaise - before.payablePaise;
    changes.push(
      `Payable: ${formatPaise(before.payablePaise)} to ${formatPaise(after.payablePaise)} (${delta > 0 ? "+" : ""}${formatPaise(delta)})`,
    );
  }

  if (before.status !== after.status) {
    changes.push(`Status: ${before.status} to ${after.status}`);
  }

  return changes;
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export interface RecordedRevision {
  revision: number;
  changes: string[];
}

/**
 * Store the current state as the next revision.
 *
 * Returns null when nothing actually changed, so pressing Save twice does not
 * manufacture a rework that never happened.
 */
export async function recordRevision(
  user: SessionUser,
  quotationId: string,
): Promise<RecordedRevision | null> {
  const snapshot = await snapshotQuotation(prisma, quotationId);

  const previous = await prisma.quotationRevision.findFirst({
    where: { quotationId },
    orderBy: { revision: "desc" },
    select: { revision: true, snapshot: true },
  });

  let changes: string[] = [];
  if (previous) {
    changes = diffSnapshots(
      previous.snapshot as unknown as RevisionSnapshot,
      snapshot,
    );
    if (changes.length === 0) return null;
  }

  const revision = (previous?.revision ?? 0) + 1;

  await prisma.$transaction(async (tx) => {
    await tx.quotationRevision.create({
      data: {
        quotationId,
        revision,
        actorId: user.id,
        snapshot: snapshot as unknown as object,
        summary: changes.join("\n"),
        itemCount: snapshot.items.length,
        subTotalPaise: toBigIntPaise(snapshot.subTotalPaise),
        payablePaise: toBigIntPaise(snapshot.payablePaise),
      },
    });
    await tx.quotation.update({
      where: { id: quotationId },
      data: { revisionCount: revision },
    });
  });

  return { revision, changes };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface RevisionView {
  id: string;
  revision: number;
  actorName: string | null;
  /** Stamped on every revision so the history says exactly who changed what. */
  actorEmail: string | null;
  changes: string[];
  itemCount: number;
  payablePaise: number;
  createdAt: Date;
}

export async function listRevisions(
  quotationId: string,
): Promise<RevisionView[]> {
  const rows = await prisma.quotationRevision.findMany({
    where: { quotationId },
    orderBy: { revision: "desc" },
    select: {
      id: true,
      revision: true,
      summary: true,
      itemCount: true,
      payablePaise: true,
      createdAt: true,
      actor: { select: { name: true, email: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    revision: row.revision,
    actorName: row.actor?.name ?? null,
    actorEmail: row.actor?.email ?? null,
    changes: row.summary ? row.summary.split("\n").filter(Boolean) : [],
    itemCount: row.itemCount,
    payablePaise: toPaise(row.payablePaise),
    createdAt: row.createdAt,
  }));
}

export interface ArchivedRevision extends RevisionView {
  /** The whole document as it stood at that revision. */
  snapshot: RevisionSnapshot;
  /** How many revisions exist in total, for "3 of 5" style navigation. */
  latestRevision: number;
}

/**
 * One archived version of a quotation, in full.
 *
 * Callers must have resolved the quotation through getQuotation() first: this
 * is keyed on quotationId and applies no scope of its own, exactly like
 * listRevisions.
 */
export async function getRevision(
  quotationId: string,
  revision: number,
): Promise<ArchivedRevision | null> {
  const [row, latest] = await Promise.all([
    prisma.quotationRevision.findFirst({
      where: { quotationId, revision },
      select: {
        id: true,
        revision: true,
        summary: true,
        itemCount: true,
        payablePaise: true,
        createdAt: true,
        snapshot: true,
        actor: { select: { name: true, email: true } },
      },
    }),
    prisma.quotationRevision.findFirst({
      where: { quotationId },
      orderBy: { revision: "desc" },
      select: { revision: true },
    }),
  ]);
  if (!row) return null;

  return {
    id: row.id,
    revision: row.revision,
    actorName: row.actor?.name ?? null,
    actorEmail: row.actor?.email ?? null,
    changes: row.summary ? row.summary.split("\n").filter(Boolean) : [],
    itemCount: row.itemCount,
    payablePaise: toPaise(row.payablePaise),
    createdAt: row.createdAt,
    snapshot: row.snapshot as unknown as RevisionSnapshot,
    latestRevision: latest?.revision ?? row.revision,
  };
}
