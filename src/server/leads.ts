import "server-only";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import type { LeadSource, LeadStatus } from "@/generated/prisma/enums";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { can, requirePermission } from "@/lib/permissions";
import type { SessionUser } from "@/lib/session";
import {
  cleanText,
  dedupeWhere,
  normalizeEmail,
  normalizePhone,
} from "@/lib/dedupe";
import {
  leadReadableWhere,
  leadWritableWhere,
  leadsWhere,
  poolWhere,
} from "./scope";
import { toPaise } from "@/lib/money";

const PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface LeadListItem {
  id: string;
  personName: string;
  phone: string | null;
  email: string | null;
  companyName: string | null;
  city: string | null;
  product: string | null;
  source: LeadSource;
  status: LeadStatus;
  receivedAt: Date;
  grabbedAt: Date | null;
  nextFollowUpAt: Date | null;
  ownerId: string | null;
  ownerName: string | null;
  creId: string | null;
  creName: string | null;
  orderId: string | null;
}

export interface LeadPage {
  items: LeadListItem[];
  total: number;
  page: number;
  pageCount: number;
}

const LIST_SELECT = {
  id: true,
  personName: true,
  phone: true,
  email: true,
  companyName: true,
  city: true,
  product: true,
  source: true,
  status: true,
  receivedAt: true,
  grabbedAt: true,
  nextFollowUpAt: true,
  ownerId: true,
  owner: { select: { name: true } },
  creId: true,
  cre: { select: { name: true } },
  order: { select: { id: true } },
} satisfies Prisma.LeadSelect;

type LeadListRow = Prisma.LeadGetPayload<{ select: typeof LIST_SELECT }>;

function toListItem(row: LeadListRow): LeadListItem {
  return {
    id: row.id,
    personName: row.personName,
    phone: row.phone,
    email: row.email,
    companyName: row.companyName,
    city: row.city,
    product: row.product,
    source: row.source,
    status: row.status,
    receivedAt: row.receivedAt,
    grabbedAt: row.grabbedAt,
    nextFollowUpAt: row.nextFollowUpAt,
    ownerId: row.ownerId,
    ownerName: row.owner?.name ?? null,
    creId: row.creId,
    creName: row.cre?.name ?? null,
    orderId: row.order?.id ?? null,
  };
}

function searchClause(q: string | undefined): Prisma.LeadWhereInput | null {
  const term = q?.trim();
  if (!term) return null;
  const contains = { contains: term, mode: "insensitive" as const };
  return {
    OR: [
      { personName: contains },
      { companyName: contains },
      { city: contains },
      { product: contains },
      { email: contains },
      { phone: { contains: term.replace(/\D/g, "") || term } },
    ],
  };
}

export interface LeadQuery {
  q?: string;
  status?: LeadStatus;
  source?: LeadSource;
  page?: number;
}

/** The pool: every unowned lead, newest arrival first. */
export async function listPool(
  user: SessionUser,
  query: LeadQuery = {},
): Promise<LeadPage> {
  requirePermission(user.role, "pool.view");

  const page = Math.max(1, query.page ?? 1);
  const where: Prisma.LeadWhereInput = {
    AND: [
      poolWhere(user),
      query.source ? { source: query.source } : {},
      // A lead already turned into an order is not up for grabs even if some
      // migration left it unowned.
      { status: { in: ["NEW", "FOLLOW_UP"] } },
      searchClause(query.q) ?? {},
    ],
  };

  const [rows, total] = await Promise.all([
    prisma.lead.findMany({
      where,
      select: LIST_SELECT,
      orderBy: { receivedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.lead.count({ where }),
  ]);

  return {
    items: rows.map(toListItem),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

/** Leads that belong to this user (or everybody, for admin and owner). */
export async function listLeads(
  user: SessionUser,
  query: LeadQuery = {},
): Promise<LeadPage> {
  const page = Math.max(1, query.page ?? 1);
  const where: Prisma.LeadWhereInput = {
    AND: [
      leadsWhere(user),
      query.status ? { status: query.status } : {},
      query.source ? { source: query.source } : {},
      searchClause(query.q) ?? {},
    ],
  };

  const [rows, total] = await Promise.all([
    prisma.lead.findMany({
      where,
      select: LIST_SELECT,
      orderBy: [{ nextFollowUpAt: { sort: "asc", nulls: "last" } }, { receivedAt: "desc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.lead.count({ where }),
  ]);

  return {
    items: rows.map(toListItem),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

export interface LeadDetail extends LeadListItem {
  state: string | null;
  message: string | null;
  lostReason: string | null;
  externalId: string | null;
  createdAt: Date;
  canEdit: boolean;
  canGrab: boolean;
  /** True for the CRE this lead was handed to, and for management. */
  canQuote: boolean;
  quotations: {
    id: string;
    quoteNo: string;
    status: string;
    payablePaise: number;
  }[];
  order: {
    id: string;
    orderNo: string;
    amountPaise: number;
    stage: string;
    creName: string | null;
  } | null;
  activities: {
    id: string;
    kind: string;
    message: string;
    actorName: string | null;
    createdAt: Date;
  }[];
}

/**
 * A lead the user is allowed to open. Returns null rather than throwing so
 * the caller can decide between a 404 page and an inline message; either way
 * "does not exist" and "not yours" look identical from outside.
 */
export async function getLead(
  user: SessionUser,
  leadId: string,
): Promise<LeadDetail | null> {
  const row = await prisma.lead.findFirst({
    where: { AND: [{ id: leadId }, leadReadableWhere(user)] },
    select: {
      ...LIST_SELECT,
      state: true,
      message: true,
      lostReason: true,
      externalId: true,
      createdAt: true,
      order: {
        select: {
          id: true,
          orderNo: true,
          amountPaise: true,
          stage: true,
          cre: { select: { name: true } },
        },
      },
      quotations: {
        orderBy: { createdAt: "desc" },
        select: { id: true, quoteNo: true, status: true, payablePaise: true },
      },
      activities: {
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          id: true,
          kind: true,
          message: true,
          createdAt: true,
          actor: { select: { name: true } },
        },
      },
    },
  });

  if (!row) return null;

  const writable = await prisma.lead.count({
    where: { AND: [{ id: leadId }, leadWritableWhere(user)] },
  });

  return {
    ...toListItem({ ...row, order: row.order ? { id: row.order.id } : null }),
    state: row.state,
    message: row.message,
    lostReason: row.lostReason,
    externalId: row.externalId,
    createdAt: row.createdAt,
    canEdit: writable === 1,
    canGrab: row.ownerId === null && can(user.role, "lead.grab"),
    canQuote:
      can(user.role, "quotation.create") &&
      (user.role !== "CRE" || row.creId === user.id),
    quotations: row.quotations.map((quote) => ({
      id: quote.id,
      quoteNo: quote.quoteNo,
      status: quote.status,
      payablePaise: toPaise(quote.payablePaise),
    })),
    order: row.order
      ? {
          id: row.order.id,
          orderNo: row.order.orderNo,
          amountPaise: toPaise(row.order.amountPaise),
          stage: row.order.stage,
          creName: row.order.cre?.name ?? null,
        }
      : null,
    activities: row.activities.map((activity) => ({
      id: activity.id,
      kind: activity.kind,
      message: activity.message,
      actorName: activity.actor?.name ?? null,
      createdAt: activity.createdAt,
    })),
  };
}

/** How many leads are sitting in the pool right now. For the nav badge. */
export async function countPool(user: SessionUser): Promise<number> {
  // No role check: poolWhere() already matches nothing for a scope of NONE,
  // which is what a CRE has.
  return prisma.lead.count({
    where: {
      AND: [poolWhere(user), { status: { in: ["NEW", "FOLLOW_UP"] } }],
    },
  });
}

// ---------------------------------------------------------------------------
// Grabbing
// ---------------------------------------------------------------------------

/**
 * Take a lead out of the pool.
 *
 * The whole correctness of this lives in one conditional UPDATE. The WHERE
 * clause carries `ownerId: null`, so Postgres itself decides the winner under
 * concurrency: whichever transaction commits first leaves the row with a
 * non-null owner, and the second one matches zero rows. `count` is the only
 * thing we trust; a read-then-write would race.
 */
export async function grabLead(
  user: SessionUser,
  leadId: string,
): Promise<LeadDetail> {
  requirePermission(user.role, "lead.grab");

  const now = new Date();
  // poolWhere() rather than a hand-written `ownerId: null`, so the grab can
  // never reach further than the pool this user is allowed to see.
  const result = await prisma.lead.updateMany({
    where: { AND: [{ id: leadId, ownerId: null }, poolWhere(user)] },
    data: { ownerId: user.id, grabbedAt: now },
  });

  if (result.count !== 1) {
    // Either it never existed, or somebody else won the race a moment ago.
    // Scoped the same as the update above - a foreign org's lead must read as
    // not-found, never leak who owns it.
    const taken = await prisma.lead.findFirst({
      where: { id: leadId, orgId: user.orgId },
      select: { owner: { select: { name: true } } },
    });
    if (!taken) throw new NotFoundError("That lead");
    throw new ConflictError(
      taken.owner
        ? `Too late. ${taken.owner.name} grabbed this lead first.`
        : "That lead is no longer available.",
    );
  }

  await prisma.leadActivity.create({
    data: {
      orgId: user.orgId,
      leadId,
      kind: "GRAB",
      actorId: user.id,
      message: `${user.name} grabbed this lead from the pool`,
    },
  });

  const lead = await getLead(user, leadId);
  if (!lead) throw new NotFoundError("That lead");
  return lead;
}

/** Admin/owner alternative to grabbing: push a pooled lead to a salesman. */
export async function assignLead(
  user: SessionUser,
  leadId: string,
  salesmanId: string,
): Promise<void> {
  requirePermission(user.role, "lead.assign");

  const salesman = await prisma.user.findFirst({
    where: { id: salesmanId, orgId: user.orgId, role: "SALESMAN", isActive: true },
    select: { id: true, name: true },
  });
  if (!salesman) throw new ValidationError("Pick an active salesman.");

  // poolWhere() rather than a hand-written `ownerId: null`, same as grabLead -
  // this is what keeps the assignment from ever reaching another org's lead.
  const result = await prisma.lead.updateMany({
    where: { AND: [{ id: leadId, ownerId: null }, poolWhere(user)] },
    data: { ownerId: salesman.id, grabbedAt: new Date() },
  });

  if (result.count !== 1) {
    throw new ConflictError("That lead has already been taken.");
  }

  await prisma.leadActivity.create({
    data: {
      orgId: user.orgId,
      leadId,
      kind: "TRANSFER",
      actorId: user.id,
      message: `${user.name} assigned this lead to ${salesman.name}`,
    },
  });
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface ManualLeadInput {
  personName: string;
  phone?: string | null;
  email?: string | null;
  companyName?: string | null;
  city?: string | null;
  state?: string | null;
  product?: string | null;
  message?: string | null;
}

export type CreateLeadOutcome =
  | { status: "created"; leadId: string }
  /** The match is inside this user's scope, so they can be pointed at it. */
  | {
      status: "duplicate";
      visible: true;
      leadId: string;
      ownerName: string | null;
    }
  /** The match exists but belongs to somebody this user cannot see. */
  | { status: "duplicate"; visible: false };

/**
 * Manual lead entry. Only a name is required.
 *
 * A salesman keeps what they type in; an admin or the owner types into the
 * pool, because neither of them works leads themselves.
 */
export async function createManualLead(
  user: SessionUser,
  input: ManualLeadInput,
): Promise<CreateLeadOutcome> {
  requirePermission(user.role, "lead.create");

  const personName = cleanText(input.personName, 160);
  if (!personName) throw new ValidationError("A name is required.", {
    personName: "Enter the person's name",
  });

  const phone = cleanText(input.phone, 40);
  const email = cleanText(input.email, 254);
  const phoneKey = normalizePhone(phone);
  const emailKey = normalizeEmail(email);

  if (email && !emailKey) {
    throw new ValidationError("That email address does not look right.", {
      email: "Enter a valid email address, or leave it blank",
    });
  }

  const duplicateFilter = dedupeWhere(phoneKey, emailKey);
  if (duplicateFilter) {
    // Deduplication has to look across the whole company, otherwise two
    // salesmen would each hold their own copy of the same enquiry. What the
    // caller is then TOLD about the match is scoped: a lead outside their
    // view gives back existence and nothing else, so typing phone numbers
    // into this form cannot be used to read another book.
    const existing = await prisma.lead.findFirst({
      where: duplicateFilter,
      select: { id: true, owner: { select: { name: true } } },
    });
    if (existing) {
      const readable = await prisma.lead.count({
        where: { AND: [{ id: existing.id }, leadReadableWhere(user)] },
      });
      if (readable !== 1) return { status: "duplicate", visible: false };
      return {
        status: "duplicate",
        visible: true,
        leadId: existing.id,
        ownerName: existing.owner?.name ?? null,
      };
    }
  }

  const ownsItImmediately = user.role === "SALESMAN";
  const now = new Date();

  const lead = await prisma.lead.create({
    data: {
      orgId: user.orgId,
      source: "MANUAL",
      status: "NEW",
      personName,
      phone,
      email,
      phoneKey,
      emailKey,
      companyName: cleanText(input.companyName, 200),
      city: cleanText(input.city, 100),
      state: cleanText(input.state, 100),
      product: cleanText(input.product, 200),
      message: cleanText(input.message, 2000),
      receivedAt: now,
      ownerId: ownsItImmediately ? user.id : null,
      grabbedAt: ownsItImmediately ? now : null,
      activities: {
        create: {
          orgId: user.orgId,
          kind: "NOTE",
          actorId: user.id,
          message: ownsItImmediately
            ? `${user.name} added this lead by hand`
            : `${user.name} added this lead by hand into the pool`,
        },
      },
    },
    select: { id: true },
  });

  return { status: "created", leadId: lead.id };
}

export interface LeadUpdateInput {
  personName?: string;
  phone?: string | null;
  email?: string | null;
  companyName?: string | null;
  city?: string | null;
  state?: string | null;
  product?: string | null;
  nextFollowUpAt?: Date | null;
}

/** Fill in what the source did not send. Own leads only, unless admin. */
export async function updateLead(
  user: SessionUser,
  leadId: string,
  input: LeadUpdateInput,
): Promise<void> {
  requirePermission(user.role, "lead.update");

  const lead = await prisma.lead.findFirst({
    where: { AND: [{ id: leadId }, leadWritableWhere(user)] },
    select: { id: true, phoneKey: true, emailKey: true },
  });
  if (!lead) throw new NotFoundError("That lead");

  const data: Prisma.LeadUpdateInput = {};

  if (input.personName !== undefined) {
    const name = cleanText(input.personName, 160);
    if (!name) {
      throw new ValidationError("A name is required.", {
        personName: "Enter the person's name",
      });
    }
    data.personName = name;
  }

  if (input.phone !== undefined) {
    const phone = cleanText(input.phone, 40);
    const phoneKey = normalizePhone(phone);
    if (phoneKey && phoneKey !== lead.phoneKey) {
      await assertKeyFree(leadId, { phoneKey });
    }
    data.phone = phone;
    data.phoneKey = phoneKey;
  }

  if (input.email !== undefined) {
    const email = cleanText(input.email, 254);
    const emailKey = normalizeEmail(email);
    if (email && !emailKey) {
      throw new ValidationError("That email address does not look right.", {
        email: "Enter a valid email address, or leave it blank",
      });
    }
    if (emailKey && emailKey !== lead.emailKey) {
      await assertKeyFree(leadId, { emailKey });
    }
    data.email = email;
    data.emailKey = emailKey;
  }

  if (input.companyName !== undefined) data.companyName = cleanText(input.companyName, 200);
  if (input.city !== undefined) data.city = cleanText(input.city, 100);
  if (input.state !== undefined) data.state = cleanText(input.state, 100);
  if (input.product !== undefined) data.product = cleanText(input.product, 200);
  if (input.nextFollowUpAt !== undefined) data.nextFollowUpAt = input.nextFollowUpAt;

  if (Object.keys(data).length === 0) return;

  await prisma.lead.update({ where: { id: leadId }, data });

  await prisma.leadActivity.create({
    data: {
      orgId: user.orgId,
      leadId,
      kind: "NOTE",
      actorId: user.id,
      message: `${user.name} updated the lead details`,
    },
  });
}

async function assertKeyFree(
  leadId: string,
  key: { phoneKey?: string; emailKey?: string },
): Promise<void> {
  const clash = await prisma.lead.findFirst({
    where: { ...key, NOT: { id: leadId } },
    select: { id: true },
  });
  if (clash) {
    const field = key.phoneKey ? "phone" : "email";
    throw new ConflictError(
      `Another lead already has that ${field} number. Leads are deduplicated on phone and email.`,
    );
  }
}

/** NEW <-> FOLLOW_UP <-> LOST. ORDER_CONFIRMED is set by confirming an order. */
export async function setLeadStatus(
  user: SessionUser,
  leadId: string,
  status: LeadStatus,
  lostReason?: string | null,
): Promise<void> {
  requirePermission(user.role, "lead.status.set");

  if (status === "ORDER_CONFIRMED") {
    throw new ValidationError(
      "A lead becomes ORDER_CONFIRMED by confirming an order against it, not by setting the status.",
    );
  }

  const lead = await prisma.lead.findFirst({
    where: { AND: [{ id: leadId }, leadWritableWhere(user)] },
    select: { id: true, status: true },
  });
  if (!lead) throw new NotFoundError("That lead");

  if (lead.status === "ORDER_CONFIRMED") {
    throw new ConflictError(
      "This lead already has a confirmed order. Change the order instead.",
    );
  }

  const reason = status === "LOST" ? cleanText(lostReason, 500) : null;
  if (status === "LOST" && !reason) {
    throw new ValidationError("Say why the lead was lost.", {
      lostReason: "A reason is required",
    });
  }

  await prisma.lead.update({
    where: { id: leadId },
    data: {
      status,
      lostReason: reason,
      nextFollowUpAt: status === "LOST" ? null : undefined,
    },
  });

  await prisma.leadActivity.create({
    data: {
      orgId: user.orgId,
      leadId,
      kind: "STATUS_CHANGE",
      actorId: user.id,
      message:
        status === "LOST"
          ? `${user.name} marked the lead lost: ${reason}`
          : `${user.name} moved the lead to ${status}`,
    },
  });
}

/** Free-text note on the timeline. */
export async function addLeadNote(
  user: SessionUser,
  leadId: string,
  message: string,
): Promise<void> {
  requirePermission(user.role, "lead.update");

  const text = cleanText(message, 2000);
  if (!text) throw new ValidationError("Write something first.", {
    message: "The note is empty",
  });

  const lead = await prisma.lead.findFirst({
    where: { AND: [{ id: leadId }, leadWritableWhere(user)] },
    select: { id: true },
  });
  if (!lead) throw new NotFoundError("That lead");

  await prisma.leadActivity.create({
    data: {
      orgId: user.orgId,
      leadId,
      kind: "NOTE",
      actorId: user.id,
      message: `${user.name}: ${text}`,
    },
  });
}

/**
 * Hand a lead to a CRE so they can quote it.
 *
 * The lead's owner does NOT change. The salesman stays the owner, which is
 * what keeps the Overview crediting their grab and keeps deleteUser()'s
 * transfer rules working exactly as they did before quotations existed.
 *
 * Only CREs reporting to the lead's owner qualify, so an admin acting on a
 * salesman's behalf still cannot push work across team lines.
 */
export async function handLeadToCre(
  user: SessionUser,
  leadId: string,
  creId: string,
): Promise<void> {
  requirePermission(user.role, "lead.handover.cre");

  const lead = await prisma.lead.findFirst({
    where: { AND: [{ id: leadId }, leadWritableWhere(user)] },
    select: {
      id: true,
      personName: true,
      status: true,
      ownerId: true,
      owner: { select: { name: true } },
    },
  });
  if (!lead) throw new NotFoundError("That lead");

  if (!lead.ownerId) {
    throw new ConflictError(
      "This lead is still in the pool. Grab it before handing it to a CRE.",
    );
  }
  if (lead.status === "LOST") {
    throw new ConflictError("This lead is marked lost.");
  }

  const cre = await prisma.user.findFirst({
    where: {
      id: creId,
      role: "CRE",
      isActive: true,
      salesmen: { some: { salesmanId: lead.ownerId } },
    },
    select: { id: true, name: true },
  });
  if (!cre) {
    throw new ValidationError(
      `Pick a CRE assigned to ${lead.owner?.name ?? "this salesman"}. A CRE from another salesman cannot take this lead.`,
      { creId: "Choose one of your CREs" },
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.lead.update({
      where: { id: lead.id },
      data: { creId: cre.id, handedToCreAt: new Date() },
    });
    await tx.leadActivity.create({
      data: {
        orgId: user.orgId,
        leadId: lead.id,
        kind: "HANDOVER",
        actorId: user.id,
        message: `${user.name} handed this lead to ${cre.name} to quote`,
      },
    });
  });
}

/** Active salesmen, for the assign dropdown. */
export async function listSalesmenForAssign(
  orgId: string,
): Promise<{ id: string; name: string; email: string }[]> {
  return prisma.user.findMany({
    where: { orgId, role: "SALESMAN", isActive: true },
    select: { id: true, name: true, email: true },
    orderBy: { name: "asc" },
  });
}
