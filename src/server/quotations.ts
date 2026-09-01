import "server-only";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import type { Prisma } from "@/generated/prisma/client";
import type { QuotationStatus, MirrorStatus } from "@/generated/prisma/enums";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { requirePermission } from "@/lib/permissions";
import type { SessionUser } from "@/lib/session";
import { cleanText, normalizeEmail } from "@/lib/dedupe";
import { formatPaise, toBigIntPaise, toPaise } from "@/lib/money";
import {
  computeTotals,
  formatQuantityTotals,
  lineAmountPaise,
  quantityTotals,
  type QuotationTotals,
} from "@/lib/quotation-math";
import {
  companiesWhere,
  leadReadableWhere,
  quotationsWhere,
  quotationWritableWhere,
} from "./scope";
import { withOrderNumber } from "./orders";

const PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Document defaults
// ---------------------------------------------------------------------------

/**
 * The boilerplate every quotation starts with, carried over verbatim from the
 * Apps Script system so the documents customers receive do not suddenly read
 * differently. Every one of these is editable per quotation.
 */
export const DEFAULT_SUBJECT =
  "Supply and installation of PUF/PIR insulated panels as per specifications below:";

export const DEFAULT_NOTE =
  "All panels will be manufactured and supplied as per customer specifications and requirements.";

export const DEFAULT_TERMS = [
  "1. Delivery Period: Within 12-15 Days from Date of Confirmed Order along with advance",
  "2. Price: The above mentioned price is basic. GST 18% extra.",
  "3. Lifting of the material has to be as per the committed date any delay in lifting of material than payment due date will be considered from the date of readiness of the material.",
  "4. Transportation: Will be charged Extra at actuals and will be billed accordingly. Our Responsibility is to arrange the transportation on behalf of customer. Any damage during transportation will not be in our scope.",
  "5. Insurance: To your Account",
  "6. Payment Terms: 50% advance with Purchase Order and 50 % before dispatch against PI.",
  "7. The Offer is valid 15 days from the date of quotation.",
  "8. All Civil, Fabrication work is under your scope",
  "9. Jurisdiction: Any dispute is subject to jurisdiction of Delhi Court only.",
].join("\n");

/** How long a quotation is good for, matching term 7. */
const VALID_FOR_DAYS = 15;

// ---------------------------------------------------------------------------
// Numbering
// ---------------------------------------------------------------------------

/**
 * REF-020, continuing the series the Apps Script system left at REF-019.
 *
 * Same shape as the order-number allocator: read the highest, add one, and
 * let the unique index settle any race by making us try again. It reads the
 * highest with MAX() over the numeric part for the same reason - a TEXT sort
 * would rank REF-999 above REF-1000 and quietly stop allocating.
 *
 * The starting number comes through lib/env, not from process.env directly.
 * Reading the raw variable here meant one setting in this app skipped the
 * validation and the defaulting every other setting goes through.
 */
async function withQuoteNumber<T>(
  run: (quoteNo: string) => Promise<T>,
): Promise<T> {
  const start = env.QUOTATION_NUMBER_START;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const [row] = await prisma.$queryRaw<{ max: number | null }[]>`
      SELECT MAX(CAST(SUBSTRING("quoteNo" FROM '[0-9]+$') AS INTEGER))::int AS max
      FROM "Quotation"
      WHERE "quoteNo" ~ '^REF-[0-9]+$'
    `;

    const lastNumber = row?.max ?? 0;
    const next = Math.max(lastNumber + 1, start) + attempt;

    try {
      return await run(`REF-${String(next).padStart(3, "0")}`);
    } catch (error) {
      if (isUniqueViolation(error, "quoteNo")) continue;
      throw error;
    }
  }
  throw new ConflictError(
    "Could not allocate a quotation number. Try again in a moment.",
  );
}

function isUniqueViolation(error: unknown, field: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ((error as { code?: unknown }).code !== "P2002") return false;
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  return Array.isArray(target) ? target.includes(field) : true;
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface QuotationItemView {
  id: string;
  position: number;
  particular: string;
  panelThickness: string;
  density: string;
  specs: string;
  sheetThickness: string;
  description: string;
  uom: string;
  /** The expression the quantity was worked out from, or "". */
  qtyFormula: string;
  qtyMilli: number;
  ratePaise: number;
  amountPaise: number;
}

export interface QuotationListItem {
  id: string;
  quoteNo: string;
  status: QuotationStatus;
  partyName: string;
  creName: string;
  leadId: string | null;
  orderId: string | null;
  orderNo: string | null;
  payablePaise: number;
  itemCount: number;
  /** "214.6 SQM · 3 NOS". Empty when no line carries a unit. */
  quantityText: string;
  pdfUrl: string | null;
  sheetStatus: MirrorStatus;
  createdAt: Date;
  validUntil: Date | null;
  /** 1 means saved once and never reworked. */
  revisionCount: number;
}

export interface QuotationDetail extends QuotationListItem {
  contactPerson: string | null;
  customerMobile: string | null;
  customerEmail: string | null;
  customerGst: string | null;
  billing: AddressView;
  shipping: AddressView & { partyName: string | null; contactPerson: string | null };
  subject: string;
  note: string;
  terms: string;
  totals: QuotationTotals;
  items: QuotationItemView[];
  companyId: string | null;
  /** Whose CREs are eligible to take this quotation on. */
  salesmanId: string | null;
  /**
   * The salesman the document is issued in the name of, and the only contact
   * the customer sees. For a CRE-built quotation this is the salesman they
   * were working as, never the CRE.
   */
  salesmanName: string | null;
  salesmanMobile: string | null;
  salesmanEmail: string | null;
  /** Who actually built it. Shown in the CRM, deliberately not on the PDF. */
  creMobile: string | null;
  creEmail: string | null;
  sheetError: string | null;
  sheetSyncedAt: Date | null;
  /** Which row of the mirror tab this quotation owns, once appended. */
  sheetRowNumber: number | null;
  /**
   * Editing stays open after an order exists. The order value follows the
   * new payable amount, and the superseded version is kept as a revision.
   */
  canEdit: boolean;
  canPlaceOrder: boolean;
  /** True once an order exists, so the UI can warn before a re-price. */
  hasOrder: boolean;
}

export interface AddressView {
  street: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  country: string | null;
}

const LIST_SELECT = {
  id: true,
  quoteNo: true,
  status: true,
  partyName: true,
  leadId: true,
  payablePaise: true,
  pdfUrl: true,
  sheetStatus: true,
  createdAt: true,
  validUntil: true,
  revisionCount: true,
  cre: { select: { name: true } },
  order: { select: { id: true, orderNo: true } },
  // uom + qty only: enough to roll the line items up into an area, without
  // pulling the whole grid into a list query.
  items: { select: { uom: true, qtyMilli: true } },
  _count: { select: { items: true } },
} satisfies Prisma.QuotationSelect;

type ListRow = Prisma.QuotationGetPayload<{ select: typeof LIST_SELECT }>;

function toListItem(row: ListRow): QuotationListItem {
  return {
    id: row.id,
    quoteNo: row.quoteNo,
    status: row.status,
    partyName: row.partyName,
    creName: row.cre.name,
    leadId: row.leadId,
    orderId: row.order?.id ?? null,
    orderNo: row.order?.orderNo ?? null,
    payablePaise: toPaise(row.payablePaise),
    itemCount: row._count.items,
    quantityText: formatQuantityTotals(quantityTotals(row.items)),
    pdfUrl: row.pdfUrl,
    sheetStatus: row.sheetStatus,
    createdAt: row.createdAt,
    validUntil: row.validUntil,
    revisionCount: row.revisionCount,
  };
}

/**
 * The viewer background jobs act as.
 *
 * The Google mirror and the PDF job legitimately need to read a quotation
 * that belongs to somebody else. Rather than adding an unscoped query that
 * could be called by mistake from a request path, they pass this explicitly,
 * so every read still goes through the same scope machinery and the intent is
 * visible at the call site.
 */
export const SYSTEM_VIEWER: SessionUser = {
  id: "__system__",
  email: "system@internal",
  name: "System",
  role: "OWNER",
  salesmen: [],
  activeSalesmanId: null,
  activeSalesmanName: null,
  isActive: true,
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface QuotationQuery {
  q?: string;
  status?: QuotationStatus;
  page?: number;
}

export async function listQuotations(
  user: SessionUser,
  query: QuotationQuery = {},
): Promise<{
  items: QuotationListItem[];
  total: number;
  page: number;
  pageCount: number;
}> {
  const page = Math.max(1, query.page ?? 1);
  const term = query.q?.trim();

  const where: Prisma.QuotationWhereInput = {
    AND: [
      quotationsWhere(user),
      query.status ? { status: query.status } : {},
      term
        ? {
            OR: [
              { quoteNo: { contains: term, mode: "insensitive" } },
              { partyName: { contains: term, mode: "insensitive" } },
              { contactPerson: { contains: term, mode: "insensitive" } },
            ],
          }
        : {},
    ],
  };

  const [rows, total] = await Promise.all([
    prisma.quotation.findMany({
      where,
      select: LIST_SELECT,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.quotation.count({ where }),
  ]);

  return {
    items: rows.map(toListItem),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

export async function getQuotation(
  user: SessionUser,
  id: string,
): Promise<QuotationDetail | null> {
  const row = await prisma.quotation.findFirst({
    where: { AND: [{ id }, quotationsWhere(user)] },
    select: {
      ...LIST_SELECT,
      companyId: true,
      salesmanId: true,
      contactPerson: true,
      customerMobile: true,
      customerEmail: true,
      customerGst: true,
      billingStreet: true,
      billingCity: true,
      billingState: true,
      billingPincode: true,
      billingCountry: true,
      shippingPartyName: true,
      shippingContactPerson: true,
      shippingStreet: true,
      shippingCity: true,
      shippingState: true,
      shippingPincode: true,
      shippingCountry: true,
      subject: true,
      note: true,
      terms: true,
      subTotalPaise: true,
      freightPaise: true,
      gstPercent: true,
      sheetError: true,
      sheetSyncedAt: true,
      sheetRow: true,
      cre: { select: { name: true, phone: true, email: true } },
      salesman: { select: { name: true, phone: true, email: true } },
      lead: {
        select: { owner: { select: { name: true, phone: true, email: true } } },
      },
      items: { orderBy: { position: "asc" } },
    },
  });
  if (!row) return null;

  const writable = await prisma.quotation.count({
    where: { AND: [{ id }, quotationWritableWhere(user)] },
  });

  const items: QuotationItemView[] = row.items.map((item) => ({
    id: item.id,
    position: item.position,
    particular: item.particular ?? "",
    panelThickness: item.panelThickness ?? "",
    density: item.density ?? "",
    specs: item.specs ?? "",
    sheetThickness: item.sheetThickness ?? "",
    description: item.description ?? "",
    uom: item.uom ?? "",
    qtyFormula: item.qtyFormula ?? "",
    qtyMilli: item.qtyMilli,
    ratePaise: toPaise(item.ratePaise),
    amountPaise: toPaise(item.amountPaise),
  }));

  const totals = computeTotals(
    items,
    toPaise(row.freightPaise),
    row.gstPercent,
  );

  const base = toListItem(row);
  const hasOrder = row.order !== null;

  return {
    ...base,
    companyId: row.companyId,
    salesmanId: row.salesmanId,
    contactPerson: row.contactPerson,
    customerMobile: row.customerMobile,
    customerEmail: row.customerEmail,
    customerGst: row.customerGst,
    billing: {
      street: row.billingStreet,
      city: row.billingCity,
      state: row.billingState,
      pincode: row.billingPincode,
      country: row.billingCountry,
    },
    shipping: {
      partyName: row.shippingPartyName,
      contactPerson: row.shippingContactPerson,
      street: row.shippingStreet,
      city: row.shippingCity,
      state: row.shippingState,
      pincode: row.shippingPincode,
      country: row.shippingCountry,
    },
    subject: row.subject ?? DEFAULT_SUBJECT,
    note: row.note ?? DEFAULT_NOTE,
    terms: row.terms ?? DEFAULT_TERMS,
    totals,
    items,
    // The stored salesman wins; the lead owner is the fallback for rows the
    // migration could not resolve one for.
    salesmanName: row.salesman?.name ?? row.lead?.owner?.name ?? null,
    salesmanMobile: row.salesman?.phone ?? row.lead?.owner?.phone ?? null,
    salesmanEmail: row.salesman?.email ?? row.lead?.owner?.email ?? null,
    creMobile: row.cre.phone,
    creEmail: row.cre.email,
    sheetError: row.sheetError,
    sheetSyncedAt: row.sheetSyncedAt,
    sheetRowNumber: row.sheetRow,
    canEdit: writable === 1,
    canPlaceOrder:
      writable === 1 && !hasOrder && items.length > 0 && totals.payablePaise > 0,
    hasOrder,
  };
}

export interface ItemSuggestions {
  particular: string[];
  panelThickness: string[];
  specs: string[];
  sheetThickness: string[];
}

/**
 * The house vocabulary for the spec columns, most-used first.
 *
 * These columns are free text, and the data already shows the drift that
 * causes: panel thickness entered as "60", "60MM" and "80mm"; sheet thickness
 * as both "0.4/0.4" and a bare "0.4"; the same panel called "Wall Panel" and
 * "WALL AND CEILING". Offering what has been typed before is what stops a
 * quotation grid becoming three spellings of the same product.
 *
 * Deliberately NOT scoped to the viewer. These are product specifications -
 * the thicknesses and facings this factory makes - not customer records, and
 * a new CRE with no quotations of their own is exactly who needs them. No
 * party name, price or customer field is read here.
 */
export async function listItemSuggestions(): Promise<ItemSuggestions> {
  const columns = [
    "particular",
    "panelThickness",
    "specs",
    "sheetThickness",
  ] as const;

  const groups = await Promise.all(
    columns.map((column) =>
      prisma.quotationItem.groupBy({
        by: [column],
        _count: { _all: true },
      }),
    ),
  );

  const pick = (
    rows: { _count: { _all: number } }[],
    column: (typeof columns)[number],
  ): string[] =>
    rows
      .map((row) => ({
        value: ((row as Record<string, unknown>)[column] as string | null) ?? "",
        count: row._count._all,
      }))
      .filter((row) => row.value.trim().length > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 20)
      .map((row) => row.value);

  return {
    particular: pick(groups[0]!, "particular"),
    panelThickness: pick(groups[1]!, "panelThickness"),
    specs: pick(groups[2]!, "specs"),
    sheetThickness: pick(groups[3]!, "sheetThickness"),
  };
}

/** The client book this user may quote against. */
export async function listClients(
  user: SessionUser,
  search?: string,
): Promise<
  {
    id: string;
    name: string;
    gstin: string | null;
    city: string | null;
    salesmanName: string | null;
    contact: { name: string; phone: string | null; email: string | null } | null;
  }[]
> {
  const term = search?.trim();
  const rows = await prisma.company.findMany({
    where: {
      AND: [
        companiesWhere(user),
        term ? { name: { contains: term, mode: "insensitive" } } : {},
      ],
    },
    orderBy: { name: "asc" },
    take: 200,
    select: {
      id: true,
      name: true,
      gstin: true,
      city: true,
      salesman: { select: { name: true } },
      contacts: {
        take: 1,
        orderBy: { createdAt: "asc" },
        select: { name: true, phone: true, email: true },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    gstin: row.gstin,
    city: row.city,
    salesmanName: row.salesman?.name ?? null,
    contact: row.contacts[0] ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

export interface CreateQuotationInput {
  /** Quote against an existing lead, or leave null for a walk-in. */
  leadId?: string | null;
  /** Quote for an existing client from the book. */
  companyId?: string | null;
  /** Or type the party in by hand. */
  partyName?: string | null;
}

/**
 * Opens a new draft.
 *
 * Whatever is known already is copied in as a starting point: from the lead,
 * or from the client record. Everything stays editable, because the quotation
 * carries its own snapshot from here on.
 */
export async function createQuotation(
  user: SessionUser,
  input: CreateQuotationInput,
): Promise<{ id: string; quoteNo: string }> {
  requirePermission(user.role, "quotation.create");

  let partyName = cleanText(input.partyName, 200);
  let companyId: string | null = null;
  let contactId: string | null = null;
  let leadId: string | null = null;
  let leadOwnerId: string | null = null;

  // Plain scalars only. Typing this as QuotationCreateInput drags the relation
  // shapes in and collides with the unchecked leadId/companyId below.
  const seed: {
    contactPerson?: string | null;
    customerMobile?: string | null;
    customerEmail?: string | null;
    customerGst?: string | null;
    billingCity?: string | null;
    billingState?: string | null;
  } = {};

  if (input.leadId) {
    const lead = await prisma.lead.findFirst({
      where: { AND: [{ id: input.leadId }, leadReadableWhere(user)] },
      select: {
        id: true,
        personName: true,
        companyName: true,
        phone: true,
        email: true,
        city: true,
        state: true,
        status: true,
        ownerId: true,
      },
    });
    if (!lead) throw new NotFoundError("That lead");
    if (lead.status === "LOST") {
      throw new ConflictError(
        "That lead is marked lost. Move it back to follow-up before quoting it.",
      );
    }

    leadId = lead.id;
    leadOwnerId = lead.ownerId;
    partyName = partyName ?? cleanText(lead.companyName, 200) ?? cleanText(lead.personName, 200);
    seed.contactPerson = cleanText(lead.personName, 160);
    seed.customerMobile = cleanText(lead.phone, 40);
    seed.customerEmail = cleanText(lead.email, 254);
    seed.billingCity = cleanText(lead.city, 100);
    seed.billingState = cleanText(lead.state, 100);
  }

  if (input.companyId) {
    const company = await prisma.company.findFirst({
      where: { AND: [{ id: input.companyId }, companiesWhere(user)] },
      select: {
        id: true,
        name: true,
        gstin: true,
        city: true,
        state: true,
        contacts: {
          take: 1,
          orderBy: { createdAt: "asc" },
          select: { id: true, name: true, phone: true, email: true },
        },
      },
    });
    if (!company) {
      throw new NotFoundError("That client");
    }

    companyId = company.id;
    partyName = partyName ?? company.name;
    seed.customerGst = company.gstin;
    seed.billingCity = seed.billingCity ?? company.city;
    seed.billingState = seed.billingState ?? company.state;

    const contact = company.contacts[0];
    if (contact) {
      contactId = contact.id;
      seed.contactPerson = seed.contactPerson ?? contact.name;
      seed.customerMobile = seed.customerMobile ?? contact.phone;
      seed.customerEmail = seed.customerEmail ?? contact.email;
    }
  }

  if (!partyName) {
    throw new ValidationError("Who is this quotation for?", {
      partyName: "Pick a client or type a party name",
    });
  }

  const validUntil = new Date();
  validUntil.setDate(validUntil.getDate() + VALID_FOR_DAYS);

  // Who this quotation is FOR, which is who the customer sees on it.
  //
  // A lead settles it: the salesman who owns the lead owns the relationship.
  // Otherwise it is whoever is building it - for a CRE that means the salesman
  // they are currently working as, and for anybody else themselves. Written
  // once, here, because a CRE serving several salesmen makes this unanswerable
  // later.
  const salesmanId =
    leadOwnerId ??
    (user.salesmen.length > 0 ? user.activeSalesmanId : user.id);

  if (!salesmanId) {
    throw new ValidationError(
      "You are not assigned to any salesman, so this quotation would have nobody on it. Ask an admin to assign you first.",
    );
  }

  return withQuoteNumber(async (quoteNo) => {
    const created = await prisma.quotation.create({
      data: {
        quoteNo,
        status: "DRAFT",
        creId: user.id,
        salesmanId,
        leadId,
        companyId,
        contactId,
        partyName,
        subject: DEFAULT_SUBJECT,
        note: DEFAULT_NOTE,
        terms: DEFAULT_TERMS,
        validUntil,
        ...seed,
      },
      select: { id: true, quoteNo: true },
    });

    if (leadId) {
      await prisma.leadActivity.create({
        data: {
          leadId,
          kind: "NOTE",
          actorId: user.id,
          message: `${user.name} started quotation ${created.quoteNo}`,
        },
      });
    }

    return created;
  });
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

export interface QuotationHeaderInput {
  partyName?: string;
  contactPerson?: string | null;
  customerMobile?: string | null;
  customerEmail?: string | null;
  customerGst?: string | null;
  billing?: Partial<AddressView>;
  shipping?: Partial<AddressView> & {
    partyName?: string | null;
    contactPerson?: string | null;
  };
  subject?: string | null;
  note?: string | null;
  terms?: string | null;
}

export async function updateQuotationHeader(
  user: SessionUser,
  id: string,
  input: QuotationHeaderInput,
): Promise<void> {
  const quotation = await requireEditable(user, id);

  const data: Prisma.QuotationUpdateInput = {};

  if (input.partyName !== undefined) {
    const name = cleanText(input.partyName, 200);
    if (!name) {
      throw new ValidationError("A party name is required.", {
        partyName: "Enter who this is for",
      });
    }
    data.partyName = name;
  }

  if (input.contactPerson !== undefined) data.contactPerson = cleanText(input.contactPerson, 160);
  if (input.customerMobile !== undefined) data.customerMobile = cleanText(input.customerMobile, 40);
  if (input.customerGst !== undefined) data.customerGst = cleanText(input.customerGst, 20);

  if (input.customerEmail !== undefined) {
    const raw = cleanText(input.customerEmail, 254);
    if (raw && !normalizeEmail(raw)) {
      throw new ValidationError("That email address does not look right.", {
        customerEmail: "Enter a valid email address, or leave it blank",
      });
    }
    data.customerEmail = raw;
  }

  if (input.billing) {
    if (input.billing.street !== undefined) data.billingStreet = cleanText(input.billing.street, 300);
    if (input.billing.city !== undefined) data.billingCity = cleanText(input.billing.city, 100);
    if (input.billing.state !== undefined) data.billingState = cleanText(input.billing.state, 100);
    if (input.billing.pincode !== undefined) data.billingPincode = cleanText(input.billing.pincode, 10);
    if (input.billing.country !== undefined) data.billingCountry = cleanText(input.billing.country, 60);
  }

  if (input.shipping) {
    if (input.shipping.partyName !== undefined) data.shippingPartyName = cleanText(input.shipping.partyName, 200);
    if (input.shipping.contactPerson !== undefined) data.shippingContactPerson = cleanText(input.shipping.contactPerson, 160);
    if (input.shipping.street !== undefined) data.shippingStreet = cleanText(input.shipping.street, 300);
    if (input.shipping.city !== undefined) data.shippingCity = cleanText(input.shipping.city, 100);
    if (input.shipping.state !== undefined) data.shippingState = cleanText(input.shipping.state, 100);
    if (input.shipping.pincode !== undefined) data.shippingPincode = cleanText(input.shipping.pincode, 10);
    if (input.shipping.country !== undefined) data.shippingCountry = cleanText(input.shipping.country, 60);
  }

  if (input.subject !== undefined) data.subject = cleanText(input.subject, 1000);
  if (input.note !== undefined) data.note = cleanText(input.note, 2000);
  // Terms keep their line breaks, so cleanText (which collapses whitespace)
  // must not touch them.
  if (input.terms !== undefined) {
    data.terms = input.terms ? input.terms.trim().slice(0, 8000) || null : null;
  }

  if (Object.keys(data).length === 0) return;
  await prisma.quotation.update({ where: { id: quotation.id }, data });
}

export interface ItemInput {
  particular?: string | null;
  panelThickness?: string | null;
  density?: string | null;
  specs?: string | null;
  sheetThickness?: string | null;
  description?: string | null;
  uom?: string | null;
  qtyFormula?: string | null;
  qtyMilli: number;
  ratePaise: number;
}

/**
 * Replace the whole grid in one go.
 *
 * The grid is edited as a unit on the client, so saving row by row would let a
 * half-applied save leave the document in a state nobody typed. Deleting and
 * re-inserting inside a transaction keeps positions dense and the totals
 * exact, and the recomputed totals are written in the same transaction so
 * they can never drift from the rows they came from.
 */
export async function saveQuotationItems(
  user: SessionUser,
  id: string,
  rows: ItemInput[],
  money: { freightPaise: number; gstPercent: number },
): Promise<QuotationTotals> {
  const quotation = await requireEditable(user, id);

  if (rows.length > 200) {
    throw new ValidationError("A quotation cannot have more than 200 lines.");
  }

  const priced = rows.map((row, index) => {
    const qtyMilli = Math.max(0, Math.trunc(row.qtyMilli));
    const ratePaise = Math.max(0, Math.trunc(row.ratePaise));
    return {
      position: index + 1,
      particular: cleanText(row.particular, 200),
      panelThickness: cleanText(row.panelThickness, 60),
      density: cleanText(row.density, 60),
      specs: cleanText(row.specs, 120),
      sheetThickness: cleanText(row.sheetThickness, 80),
      // Descriptions are multi-line and must keep their line breaks.
      description: row.description ? row.description.trim().slice(0, 2000) : null,
      uom: cleanText(row.uom, 20),
      qtyFormula: cleanText(row.qtyFormula, 200),
      qtyMilli,
      ratePaise,
      amountPaise: lineAmountPaise(qtyMilli, ratePaise),
    };
  });

  const totals = computeTotals(priced, money.freightPaise, money.gstPercent);

  // Checked before a single row is written, so a refused re-price leaves the
  // document exactly as it was. syncOrderToQuotation() checks again inside
  // the transaction, which is the one that actually decides - this is here so
  // the common rejection costs nothing.
  await assertRepriceAllowed(prisma, id, totals.payablePaise);

  await prisma.$transaction(async (tx) => {
    await tx.quotationItem.deleteMany({ where: { quotationId: quotation.id } });

    if (priced.length > 0) {
      await tx.quotationItem.createMany({
        data: priced.map((row) => ({
          quotationId: quotation.id,
          position: row.position,
          particular: row.particular,
          panelThickness: row.panelThickness,
          density: row.density,
          specs: row.specs,
          sheetThickness: row.sheetThickness,
          description: row.description,
          uom: row.uom,
          qtyFormula: row.qtyFormula,
          qtyMilli: row.qtyMilli,
          ratePaise: toBigIntPaise(row.ratePaise),
          amountPaise: toBigIntPaise(row.amountPaise),
        })),
      });
    }

    await tx.quotation.update({
      where: { id: quotation.id },
      data: {
        subTotalPaise: toBigIntPaise(totals.subTotalPaise),
        freightPaise: toBigIntPaise(totals.freightPaise),
        gstPercent: totals.gstPercent,
        gstPaise: toBigIntPaise(totals.gstPaise),
        payablePaise: toBigIntPaise(totals.payablePaise),
        // Any edit puts a mirrored quotation back in the queue, so the Sheet
        // never keeps showing a superseded total.
        sheetStatus: "PENDING",
      },
    });

    await syncOrderToQuotation(tx, quotation.id, totals.payablePaise);
  });

  return totals;
}

/**
 * Carry a re-priced quotation through to the order placed from it.
 *
 * The order value is the quotation payable amount - that was true when the
 * order was created and stays true afterwards, otherwise the two documents
 * would drift the moment somebody corrected a quantity. Inside the same
 * transaction as the quotation write, so they cannot disagree even briefly.
 *
 * The one thing that is refused is a value below what has already been
 * collected, because received can never exceed the order. And an order that
 * was closed as fully paid reopens when the new value leaves something
 * outstanding, exactly as deleting a payment does.
 */
async function syncOrderToQuotation(
  tx: Prisma.TransactionClient,
  quotationId: string,
  payablePaise: number,
): Promise<void> {
  const order = await assertRepriceAllowed(tx, quotationId, payablePaise);
  if (!order) return;

  const reopen = order.stage === "CLOSED" && payablePaise > order.received;

  await tx.order.update({
    where: { id: order.id },
    data: {
      amountPaise: toBigIntPaise(payablePaise),
      ...(reopen
        ? { stage: order.creId ? "WITH_CRE" : "CONFIRMED", closedAt: null }
        : {}),
    },
  });
}

/**
 * Refuse a quotation value that has already been overtaken by collections.
 *
 * Returns the order and what has been received against it, or null when the
 * quotation has no order and there is nothing to protect.
 */
async function assertRepriceAllowed(
  db: Prisma.TransactionClient | typeof prisma,
  quotationId: string,
  payablePaise: number,
): Promise<{
  id: string;
  stage: string;
  creId: string | null;
  received: number;
} | null> {
  const order = await db.order.findUnique({
    where: { quotationId },
    select: {
      id: true,
      orderNo: true,
      stage: true,
      creId: true,
      payments: { select: { amountPaise: true } },
    },
  });
  if (!order) return null;

  const received = order.payments.reduce(
    (sum, payment) => sum + toPaise(payment.amountPaise),
    0,
  );

  if (payablePaise < received) {
    throw new ConflictError(
      `${formatPaise(received)} has already been received against order ${order.orderNo}. This edit would take the quotation down to ${formatPaise(payablePaise)}, which is below that, so it was refused and nothing changed. Delete the payment first if it was recorded in error.`,
    );
  }

  return {
    id: order.id,
    stage: order.stage,
    creId: order.creId,
    received,
  };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export async function setQuotationStatus(
  user: SessionUser,
  id: string,
  status: Extract<QuotationStatus, "SENT" | "REJECTED" | "DRAFT">,
): Promise<void> {
  requirePermission(user.role, "quotation.send");

  const quotation = await prisma.quotation.findFirst({
    where: { AND: [{ id }, quotationWritableWhere(user)] },
    select: { id: true, status: true, leadId: true, quoteNo: true, _count: { select: { items: true } } },
  });
  if (!quotation) throw new NotFoundError("That quotation");

  if (quotation.status === "ACCEPTED") {
    throw new ConflictError(
      "An order has been placed from this quotation, so it cannot be changed.",
    );
  }
  if (status === "SENT" && quotation._count.items === 0) {
    throw new ValidationError("Add at least one line before sending.");
  }

  await prisma.quotation.update({
    where: { id: quotation.id },
    data: {
      status,
      sentAt: status === "SENT" ? new Date() : null,
    },
  });

  if (quotation.leadId) {
    await prisma.leadActivity.create({
      data: {
        leadId: quotation.leadId,
        kind: "NOTE",
        actorId: user.id,
        message: `${user.name} marked quotation ${quotation.quoteNo} as ${status.toLowerCase()}`,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Placing the order
// ---------------------------------------------------------------------------

/**
 * The accepted quotation becomes an order.
 *
 * The order value is the quotation's payable amount, never a number typed
 * again, so the two documents cannot disagree. The salesman credited is the
 * lead owner, or for a walk-in the CRE's own salesman, because a CRE always
 * reports to exactly one.
 */
export async function placeOrderFromQuotation(
  user: SessionUser,
  id: string,
): Promise<{ orderId: string; orderNo: string }> {
  requirePermission(user.role, "order.confirm");

  const quotation = await prisma.quotation.findFirst({
    where: { AND: [{ id }, quotationWritableWhere(user)] },
    select: {
      id: true,
      quoteNo: true,
      status: true,
      partyName: true,
      contactPerson: true,
      customerMobile: true,
      customerEmail: true,
      customerGst: true,
      billingCity: true,
      billingState: true,
      companyId: true,
      contactId: true,
      leadId: true,
      creId: true,
      payablePaise: true,
      salesmanId: true,
      order: { select: { orderNo: true } },
      lead: { select: { id: true, ownerId: true, status: true } },
      cre: { select: { id: true, name: true, role: true } },
      _count: { select: { items: true } },
    },
  });
  if (!quotation) throw new NotFoundError("That quotation");

  // "cre" is whoever built the document, which is not always a CRE now that a
  // salesman can raise one for themselves.
  const builtByCre = quotation.cre.role === "CRE";

  if (quotation.order) {
    throw new ConflictError(
      `Order ${quotation.order.orderNo} has already been placed from this quotation.`,
    );
  }
  if (quotation._count.items === 0) {
    throw new ValidationError("This quotation has no lines to order.");
  }

  const amountPaise = toPaise(quotation.payablePaise);
  if (amountPaise <= 0) {
    throw new ValidationError(
      "The payable amount is zero. Fill in quantities and rates first.",
    );
  }

  // The quotation carries its own salesman, decided when it was created. It
  // used to be derived here as `lead.ownerId ?? cre.managerId`, which stopped
  // having a single answer once a CRE could serve more than one salesman.
  const salesmanId = quotation.salesmanId ?? quotation.lead?.ownerId;
  if (!salesmanId) {
    throw new ValidationError(
      `This quotation is not credited to any salesman, so there is nobody to record the order against. Ask an admin to check ${quotation.cre.name}'s salesman assignment.`,
    );
  }

  return withOrderNumber(async (orderNo) =>
    prisma.$transaction(async (tx) => {
      // Reuse the client record when the quotation was raised against one;
      // a walk-in creates the company and contact now.
      let companyId = quotation.companyId;
      let contactId = quotation.contactId;

      if (!companyId) {
        const company = await tx.company.create({
          data: {
            name: quotation.partyName,
            city: quotation.billingCity,
            state: quotation.billingState,
            gstin: quotation.customerGst,
            salesmanId,
            sheetSalesExecutive: null,
          },
          select: { id: true },
        });
        companyId = company.id;
      }

      if (!contactId) {
        const contact = await tx.contact.create({
          data: {
            companyId,
            name: quotation.contactPerson ?? quotation.partyName,
            phone: quotation.customerMobile,
            email: quotation.customerEmail,
          },
          select: { id: true },
        });
        contactId = contact.id;
      }

      const order = await tx.order.create({
        data: {
          orderNo,
          leadId: quotation.leadId,
          quotationId: quotation.id,
          companyId,
          contactId,
          salesmanId,
          // Only a real CRE holds an order. A salesman who quoted the job
          // themselves keeps it as a plain CONFIRMED order and collects
          // against it, until they hand it to one of their CREs.
          creId: builtByCre ? quotation.creId : null,
          handedOverAt: builtByCre ? new Date() : null,
          amountPaise: toBigIntPaise(amountPaise),
          // Straight to the CRE when a CRE quoted it, because they are the
          // one who will collect against it. A salesman-quoted job has no
          // CRE yet, so it sits at CONFIRMED with them.
          stage: builtByCre ? "WITH_CRE" : "CONFIRMED",
          title: `Against quotation ${quotation.quoteNo}`,
        },
        select: { id: true, orderNo: true },
      });

      await tx.quotation.update({
        where: { id: quotation.id },
        data: { status: "ACCEPTED", acceptedAt: new Date(), sheetStatus: "PENDING" },
      });

      if (quotation.leadId) {
        await tx.lead.update({
          where: { id: quotation.leadId },
          data: { status: "ORDER_CONFIRMED", nextFollowUpAt: null, lostReason: null },
        });
        await tx.leadActivity.create({
          data: {
            leadId: quotation.leadId,
            kind: "ORDER_CONFIRMED",
            actorId: user.id,
            message: `${user.name} placed order ${order.orderNo} from quotation ${quotation.quoteNo} for ${formatPaise(amountPaise)}`,
          },
        });
      }

      return { orderId: order.id, orderNo: order.orderNo };
    }),
  );
}

// ---------------------------------------------------------------------------
// Handing over
// ---------------------------------------------------------------------------

/**
 * Hand a quotation to a CRE, at any stage.
 *
 * A salesman can now carry a job end to end without ever involving a CRE, so
 * the handover has to work from whatever point they decide to stop. It moves
 * the whole job in one transaction - the quotation, the order it became, and
 * the lead behind it - because splitting them would leave the CRE holding a
 * quotation they cannot see the order for.
 *
 * Only CREs who work for the salesman the quotation is credited to qualify,
 * which is the same rule handOverOrder and handLeadToCre apply.
 */
export async function handOverQuotation(
  user: SessionUser,
  quotationId: string,
  creId: string,
): Promise<{ quoteNo: string; creName: string; movedOrder: string | null }> {
  requirePermission(user.role, "quotation.handover");

  const quotation = await prisma.quotation.findFirst({
    where: { AND: [{ id: quotationId }, quotationWritableWhere(user)] },
    select: {
      id: true,
      quoteNo: true,
      creId: true,
      leadId: true,
      salesmanId: true,
      salesman: { select: { name: true } },
      order: { select: { id: true, orderNo: true, stage: true } },
    },
  });
  if (!quotation) throw new NotFoundError("That quotation");

  if (!quotation.salesmanId) {
    throw new ConflictError(
      "This quotation is not credited to any salesman, so there is nobody whose CREs could take it on.",
    );
  }

  const cre = await prisma.user.findFirst({
    where: {
      id: creId,
      role: "CRE",
      isActive: true,
      salesmen: { some: { salesmanId: quotation.salesmanId } },
    },
    select: { id: true, name: true },
  });
  if (!cre) {
    throw new ValidationError(
      `Pick a CRE who works for ${quotation.salesman?.name ?? "this salesman"}. A CRE from another salesman cannot take this quotation.`,
      { creId: "Choose one of your CREs" },
    );
  }

  if (quotation.creId === cre.id) {
    return { quoteNo: quotation.quoteNo, creName: cre.name, movedOrder: null };
  }

  const movedOrder =
    quotation.order && quotation.order.stage !== "CLOSED"
      ? quotation.order.orderNo
      : null;

  await prisma.$transaction(async (tx) => {
    await tx.quotation.update({
      where: { id: quotation.id },
      // The Sheet row names the CRE, so it has to be rewritten.
      data: { creId: cre.id, sheetStatus: "PENDING" },
    });

    // A closed order is finished business and is left where it is.
    if (quotation.order && quotation.order.stage !== "CLOSED") {
      await tx.order.update({
        where: { id: quotation.order.id },
        data: { creId: cre.id, handedOverAt: new Date(), stage: "WITH_CRE" },
      });
    }

    if (quotation.leadId) {
      await tx.lead.update({
        where: { id: quotation.leadId },
        data: { creId: cre.id, handedToCreAt: new Date() },
      });
      await tx.leadActivity.create({
        data: {
          leadId: quotation.leadId,
          kind: "HANDOVER",
          actorId: user.id,
          message: movedOrder
            ? `${user.name} handed quotation ${quotation.quoteNo} and order ${movedOrder} to ${cre.name}`
            : `${user.name} handed quotation ${quotation.quoteNo} to ${cre.name}`,
        },
      });
    }
  });

  return { quoteNo: quotation.quoteNo, creName: cre.name, movedOrder };
}

// ---------------------------------------------------------------------------
// Deleting
// ---------------------------------------------------------------------------

export async function deleteQuotation(
  user: SessionUser,
  id: string,
): Promise<void> {
  requirePermission(user.role, "quotation.delete");

  const quotation = await prisma.quotation.findFirst({
    where: { AND: [{ id }, quotationsWhere(user)] },
    select: { id: true, quoteNo: true, order: { select: { orderNo: true } } },
  });
  if (!quotation) throw new NotFoundError("That quotation");

  if (quotation.order) {
    // Order.quotationId is SetNull, so deleting this first would leave an
    // order with no source document rather than refusing outright. The order
    // has to go first, which is now something an owner or admin can do.
    throw new ConflictError(
      `Order ${quotation.order.orderNo} was placed from this quotation. Delete that order first, then this can go too.`,
    );
  }

  await prisma.quotation.delete({ where: { id: quotation.id } });
}

// ---------------------------------------------------------------------------

/**
 * The quotation this user may write to.
 *
 * An order no longer locks it. A quotation that has become an order is still
 * the live document for that job: quantities get corrected, a line gets
 * added, and the order value has to follow. The reference number never
 * changes, because it is the same job - what changes is kept as a numbered
 * revision that can be opened in full, so the superseded version is archived
 * rather than lost.
 *
 * The money rule that replaces the lock lives in syncOrderToQuotation():
 * the value can never fall below what has already been collected.
 */
async function requireEditable(
  user: SessionUser,
  id: string,
): Promise<{ id: string }> {
  requirePermission(user.role, "quotation.update");

  const quotation = await prisma.quotation.findFirst({
    where: { AND: [{ id }, quotationWritableWhere(user)] },
    select: { id: true },
  });
  if (!quotation) throw new NotFoundError("That quotation");

  return { id: quotation.id };
}
