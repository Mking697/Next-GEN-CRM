import "server-only";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import type { OrderStage, PaymentMode } from "@/generated/prisma/enums";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { requirePermission } from "@/lib/permissions";
import type { SessionUser } from "@/lib/session";
import { cleanText, normalizeEmail, normalizePhone } from "@/lib/dedupe";
import { formatPaise, toBigIntPaise, toPaise } from "@/lib/money";
import { audit } from "./audit";
import { canClose, orderMoney, type OrderMoney } from "./order-state";
import { leadWritableWhere, ordersWhere } from "./scope";

const PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Confirming a lead into an order
// ---------------------------------------------------------------------------

export interface ConfirmOrderInput {
  /** Integer paise. */
  amountPaise: number;
  companyName?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  city?: string | null;
  state?: string | null;
  gstin?: string | null;
  title?: string | null;
  notes?: string | null;
}

/**
 * Confirming a lead creates a Company, a Contact and an Order in one
 * transaction, and moves the lead to ORDER_CONFIRMED.
 *
 * The salesman on the order is whoever owns the lead, not whoever pressed the
 * button, so an admin confirming on somebody's behalf does not steal the
 * credit out of the Overview.
 */
export async function confirmOrder(
  user: SessionUser,
  leadId: string,
  input: ConfirmOrderInput,
): Promise<{ orderId: string; orderNo: string }> {
  requirePermission(user.role, "order.confirm");

  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) {
    throw new ValidationError("Enter the order value.", {
      amount: "Enter an amount greater than zero",
    });
  }

  const lead = await prisma.lead.findFirst({
    where: { AND: [{ id: leadId }, leadWritableWhere(user)] },
    select: {
      id: true,
      personName: true,
      companyName: true,
      phone: true,
      email: true,
      city: true,
      state: true,
      product: true,
      status: true,
      ownerId: true,
      order: { select: { id: true, orderNo: true } },
    },
  });
  if (!lead) throw new NotFoundError("That lead");

  if (lead.order) {
    throw new ConflictError(
      `This lead is already confirmed as order ${lead.order.orderNo}.`,
    );
  }
  if (lead.status === "LOST") {
    throw new ConflictError(
      "This lead is marked lost. Move it back to follow-up before confirming an order.",
    );
  }

  // The lead owner becomes the salesman. An unowned lead confirmed by an admin
  // has nobody to credit, which the Overview cannot represent.
  const salesmanId = lead.ownerId;
  if (!salesmanId) {
    throw new ValidationError(
      "This lead is still in the pool. It has to belong to a salesman before it can become an order.",
    );
  }

  const companyName =
    cleanText(input.companyName, 200) ??
    cleanText(lead.companyName, 200) ??
    cleanText(lead.personName, 200) ??
    "Unnamed customer";

  const contactName =
    cleanText(input.contactName, 160) ?? cleanText(lead.personName, 160) ?? companyName;

  const contactPhone = cleanText(input.contactPhone, 40) ?? cleanText(lead.phone, 40);
  const contactEmailRaw = cleanText(input.contactEmail, 254) ?? cleanText(lead.email, 254);
  const contactEmail = contactEmailRaw
    ? (normalizeEmail(contactEmailRaw) ?? contactEmailRaw)
    : null;

  return withOrderNumber(async (orderNo) =>
    prisma.$transaction(async (tx) => {
      const company = await tx.company.create({
        data: {
          name: companyName,
          city: cleanText(input.city, 100) ?? cleanText(lead.city, 100),
          state: cleanText(input.state, 100) ?? cleanText(lead.state, 100),
          gstin: cleanText(input.gstin, 20),
        },
        select: { id: true },
      });

      const contact = await tx.contact.create({
        data: {
          companyId: company.id,
          name: contactName,
          phone: contactPhone,
          email: contactEmail,
        },
        select: { id: true },
      });

      const order = await tx.order.create({
        data: {
          orderNo,
          leadId: lead.id,
          companyId: company.id,
          contactId: contact.id,
          salesmanId,
          amountPaise: toBigIntPaise(input.amountPaise),
          stage: "CONFIRMED",
          title: cleanText(input.title, 200) ?? cleanText(lead.product, 200),
          notes: cleanText(input.notes, 2000),
        },
        select: { id: true, orderNo: true },
      });

      await tx.lead.update({
        where: { id: lead.id },
        data: { status: "ORDER_CONFIRMED", nextFollowUpAt: null, lostReason: null },
      });

      await tx.leadActivity.create({
        data: {
          leadId: lead.id,
          kind: "ORDER_CONFIRMED",
          actorId: user.id,
          message: `${user.name} confirmed order ${order.orderNo} for ${formatPaise(
            input.amountPaise,
          )}`,
        },
      });

      return { orderId: order.id, orderNo: order.orderNo };
    }),
  );
}

/**
 * ORD-2026-0007. Derived from a count, so it races; the unique index on
 * orderNo catches the collision and we simply try the next number.
 *
 * Exported because placing an order from a quotation needs the same allocator,
 * and two allocators would eventually hand out the same number.
 */
export async function withOrderNumber<T>(
  run: (orderNo: string) => Promise<T>,
): Promise<T> {
  const year = new Date().getUTCFullYear();
  const prefix = `ORD-${year}-`;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const latest = await prisma.order.findFirst({
      where: { orderNo: { startsWith: prefix } },
      orderBy: { orderNo: "desc" },
      select: { orderNo: true },
    });
    const lastNumber = latest ? Number(latest.orderNo.slice(prefix.length)) : 0;
    const next = (Number.isFinite(lastNumber) ? lastNumber : 0) + 1 + attempt;
    const orderNo = `${prefix}${String(next).padStart(4, "0")}`;

    try {
      return await run(orderNo);
    } catch (error) {
      if (isUniqueViolation(error, "orderNo")) continue;
      throw error;
    }
  }
  throw new ConflictError(
    "Could not allocate an order number. Try again in a moment.",
  );
}

function isUniqueViolation(error: unknown, field?: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code !== "P2002") return false;
  if (!field) return true;
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  return Array.isArray(target) ? target.includes(field) : true;
}

// ---------------------------------------------------------------------------
// Handover
// ---------------------------------------------------------------------------

/** The CREs a given salesman may hand work to. */
export async function listCresFor(
  salesmanId: string,
): Promise<{ id: string; name: string; email: string }[]> {
  return prisma.user.findMany({
    where: {
      role: "CRE",
      isActive: true,
      salesmen: { some: { salesmanId } },
    },
    select: { id: true, name: true, email: true },
    orderBy: { name: "asc" },
  });
}

/**
 * Hand a confirmed order to a CRE.
 *
 * Only CREs assigned to that order's salesman qualify. The check is against
 * the order's salesman rather than the caller, so an admin acting on a
 * salesman's behalf still cannot cross team lines.
 */
export async function handOverOrder(
  user: SessionUser,
  orderId: string,
  creId: string,
): Promise<void> {
  requirePermission(user.role, "order.handover");

  const order = await prisma.order.findFirst({
    where: { AND: [{ id: orderId }, ordersWhere(user)] },
    select: {
      id: true,
      orderNo: true,
      stage: true,
      salesmanId: true,
      leadId: true,
      salesman: { select: { name: true } },
    },
  });
  if (!order) throw new NotFoundError("That order");

  if (order.stage === "CLOSED") {
    throw new ConflictError("That order is closed.");
  }

  const cre = await prisma.user.findFirst({
    where: {
      id: creId,
      role: "CRE",
      isActive: true,
      salesmen: { some: { salesmanId: order.salesmanId } },
    },
    select: { id: true, name: true },
  });
  if (!cre) {
    throw new ValidationError(
      `Pick a CRE assigned to ${order.salesman.name}. A CRE from another salesman cannot take this order.`,
      { creId: "Choose one of the CREs assigned to this salesman" },
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: order.id },
      data: { creId: cre.id, handedOverAt: new Date(), stage: "WITH_CRE" },
    });

    if (order.leadId) {
      await tx.leadActivity.create({
        data: {
          leadId: order.leadId,
          kind: "HANDOVER",
          actorId: user.id,
          message: `${user.name} handed order ${order.orderNo} to ${cre.name}`,
        },
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface OrderListItem extends OrderMoney {
  id: string;
  orderNo: string;
  title: string | null;
  companyName: string;
  contactName: string | null;
  stage: OrderStage;
  salesmanId: string;
  salesmanName: string;
  creId: string | null;
  creName: string | null;
  confirmedAt: Date;
  closedAt: Date | null;
  leadId: string | null;
}

export interface OrderPage {
  items: OrderListItem[];
  total: number;
  page: number;
  pageCount: number;
  totals: { amountPaise: number; receivedPaise: number; duePaise: number };
}

const ORDER_SELECT = {
  id: true,
  orderNo: true,
  title: true,
  stage: true,
  amountPaise: true,
  confirmedAt: true,
  closedAt: true,
  leadId: true,
  salesmanId: true,
  creId: true,
  company: { select: { name: true } },
  contact: { select: { name: true } },
  salesman: { select: { name: true } },
  cre: { select: { name: true } },
  payments: { select: { amountPaise: true } },
} satisfies Prisma.OrderSelect;

type OrderRow = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>;

function toOrderItem(row: OrderRow): OrderListItem {
  return {
    id: row.id,
    orderNo: row.orderNo,
    title: row.title,
    companyName: row.company.name,
    contactName: row.contact?.name ?? null,
    stage: row.stage,
    salesmanId: row.salesmanId,
    salesmanName: row.salesman.name,
    creId: row.creId,
    creName: row.cre?.name ?? null,
    confirmedAt: row.confirmedAt,
    closedAt: row.closedAt,
    leadId: row.leadId,
    ...orderMoney(row.amountPaise, row.payments),
  };
}

export interface OrderQuery {
  q?: string;
  stage?: OrderStage;
  /** "DUE" narrows to orders with money outstanding. */
  onlyDue?: boolean;
  page?: number;
}

export async function listOrders(
  user: SessionUser,
  query: OrderQuery = {},
): Promise<OrderPage> {
  const page = Math.max(1, query.page ?? 1);
  const term = query.q?.trim();

  const where: Prisma.OrderWhereInput = {
    AND: [
      ordersWhere(user),
      query.stage ? { stage: query.stage } : {},
      term
        ? {
            OR: [
              { orderNo: { contains: term, mode: "insensitive" } },
              { title: { contains: term, mode: "insensitive" } },
              { company: { name: { contains: term, mode: "insensitive" } } },
              { contact: { name: { contains: term, mode: "insensitive" } } },
            ],
          }
        : {},
    ],
  };

  const [rows, total] = await Promise.all([
    prisma.order.findMany({
      where,
      select: ORDER_SELECT,
      orderBy: { confirmedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.order.count({ where }),
  ]);

  let items = rows.map(toOrderItem);
  if (query.onlyDue) items = items.filter((item) => item.duePaise > 0);

  const totals = items.reduce(
    (acc, item) => ({
      amountPaise: acc.amountPaise + item.amountPaise,
      receivedPaise: acc.receivedPaise + item.receivedPaise,
      duePaise: acc.duePaise + item.duePaise,
    }),
    { amountPaise: 0, receivedPaise: 0, duePaise: 0 },
  );

  return {
    items,
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    totals,
  };
}

export interface OrderDetail extends OrderListItem {
  notes: string | null;
  gstin: string | null;
  city: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  handedOverAt: Date | null;
  canClose: boolean;
  payments: {
    id: string;
    amountPaise: number;
    mode: PaymentMode;
    reference: string | null;
    note: string | null;
    receivedAt: Date;
    recordedByName: string | null;
  }[];
  /** CREs that may take this order, i.e. those under its salesman. */
  eligibleCres: { id: string; name: string; email: string }[];
}

export async function getOrder(
  user: SessionUser,
  orderId: string,
): Promise<OrderDetail | null> {
  const row = await prisma.order.findFirst({
    where: { AND: [{ id: orderId }, ordersWhere(user)] },
    select: {
      ...ORDER_SELECT,
      notes: true,
      handedOverAt: true,
      company: { select: { name: true, city: true, gstin: true } },
      contact: { select: { name: true, phone: true, email: true } },
      payments: {
        orderBy: { receivedAt: "desc" },
        select: {
          id: true,
          amountPaise: true,
          mode: true,
          reference: true,
          note: true,
          receivedAt: true,
          recordedBy: { select: { name: true } },
        },
      },
    },
  });
  if (!row) return null;

  const base = toOrderItem({
    ...row,
    company: { name: row.company.name },
    contact: row.contact ? { name: row.contact.name } : null,
    payments: row.payments.map((p) => ({ amountPaise: p.amountPaise })),
  });

  const eligibleCres =
    row.stage === "CLOSED" ? [] : await listCresFor(row.salesmanId);

  return {
    ...base,
    notes: row.notes,
    gstin: row.company.gstin,
    city: row.company.city,
    contactPhone: row.contact?.phone ?? null,
    contactEmail: row.contact?.email ?? null,
    handedOverAt: row.handedOverAt,
    canClose: canClose(base),
    payments: row.payments.map((payment) => ({
      id: payment.id,
      amountPaise: toPaise(payment.amountPaise),
      mode: payment.mode,
      reference: payment.reference,
      note: payment.note,
      receivedAt: payment.receivedAt,
      recordedByName: payment.recordedBy?.name ?? null,
    })),
    eligibleCres,
  };
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export interface PaymentInput {
  /** Integer paise, always positive. */
  amountPaise: number;
  mode: PaymentMode;
  reference?: string | null;
  note?: string | null;
  receivedAt?: Date | null;
}

/**
 * Record a payment. Refuses anything that would take received past the order
 * value.
 *
 * The whole thing runs inside a transaction that takes a row lock on the
 * order first (SELECT ... FOR UPDATE). Without the lock, two CREs recording
 * the last two part-payments at the same instant would both read the old sum,
 * both pass the check, and together overshoot the order value. The lock makes
 * the read-check-write sequence atomic per order.
 */
export async function recordPayment(
  user: SessionUser,
  orderId: string,
  input: PaymentInput,
): Promise<{ receivedPaise: number; duePaise: number }> {
  requirePermission(user.role, "payment.record");

  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) {
    throw new ValidationError("Enter the amount received.", {
      amount: "Enter an amount greater than zero",
    });
  }

  const visible = await prisma.order.findFirst({
    where: { AND: [{ id: orderId }, ordersWhere(user)] },
    select: { id: true, stage: true, leadId: true, orderNo: true },
  });
  if (!visible) throw new NotFoundError("That order");
  if (visible.stage === "CLOSED") {
    throw new ConflictError(
      "That order is closed. Reopen it before recording another payment.",
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    // Serialise every payment against this one order.
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;

    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { amountPaise: true },
    });
    if (!order) throw new NotFoundError("That order");

    const aggregate = await tx.payment.aggregate({
      where: { orderId },
      _sum: { amountPaise: true },
    });

    const amountPaise = toPaise(order.amountPaise);
    const alreadyPaise = toPaise(aggregate._sum.amountPaise);
    const duePaise = amountPaise - alreadyPaise;

    if (input.amountPaise > duePaise) {
      throw new ConflictError(
        duePaise <= 0
          ? `Nothing is due on this order. It is already fully paid at ${formatPaise(amountPaise)}.`
          : `Only ${formatPaise(duePaise)} is due. A payment cannot take the total past the order value of ${formatPaise(amountPaise)}.`,
      );
    }

    await tx.payment.create({
      data: {
        orderId,
        amountPaise: toBigIntPaise(input.amountPaise),
        mode: input.mode,
        reference: cleanText(input.reference, 120),
        note: cleanText(input.note, 500),
        receivedAt: input.receivedAt ?? new Date(),
        recordedById: user.id,
      },
    });

    const receivedPaise = alreadyPaise + input.amountPaise;

    if (visible.leadId) {
      await tx.leadActivity.create({
        data: {
          leadId: visible.leadId,
          kind: "PAYMENT",
          actorId: user.id,
          message: `${user.name} recorded ${formatPaise(input.amountPaise)} against ${visible.orderNo}`,
        },
      });
    }

    return {
      receivedPaise,
      duePaise: Math.max(0, amountPaise - receivedPaise),
    };
  });

  return result;
}

/**
 * Delete an order raised by mistake, and put everything it touched back.
 *
 * An order is not a leaf: the lead behind it sits at ORDER_CONFIRMED, the
 * quotation it came from sits at ACCEPTED, and its payments cascade away with
 * it. Deleting the row alone would leave a lead that claims an order nobody
 * can open and a quotation frozen against nothing, so all three move together
 * in one transaction.
 *
 * Payments are the part that cannot be undone, so what is being destroyed -
 * the value, what had been received, how many payments - is written to the
 * audit trail BEFORE the delete. That is the same bargain deleteUser() makes:
 * the row goes, the record of it going does not.
 */
export async function deleteOrder(
  user: SessionUser,
  orderId: string,
): Promise<{ orderNo: string; receivedPaise: number; payments: number }> {
  requirePermission(user.role, "order.delete");

  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { AND: [{ id: orderId }, ordersWhere(user)] },
      select: {
        id: true,
        orderNo: true,
        amountPaise: true,
        leadId: true,
        quotationId: true,
        company: { select: { name: true } },
        payments: { select: { amountPaise: true } },
      },
    });
    if (!order) throw new NotFoundError("That order");

    const receivedPaise = order.payments.reduce(
      (sum, payment) => sum + toPaise(payment.amountPaise),
      0,
    );

    await audit(tx, {
      action: "order.delete",
      actorId: user.id,
      targetType: "Order",
      targetId: order.id,
      detail:
        `${user.name} deleted order ${order.orderNo} for ${order.company.name}, ` +
        `worth ${formatPaise(toPaise(order.amountPaise))}. ` +
        (order.payments.length === 0
          ? "No payments had been recorded against it."
          : `${order.payments.length} payment(s) totalling ${formatPaise(receivedPaise)} were deleted with it.`),
    });

    // The lead claimed an order that is about to stop existing.
    if (order.leadId) {
      await tx.lead.update({
        where: { id: order.leadId },
        data: { status: "FOLLOW_UP" },
      });
      await tx.leadActivity.create({
        data: {
          leadId: order.leadId,
          kind: "STATUS_CHANGE",
          actorId: user.id,
          message: `${user.name} deleted order ${order.orderNo}; the lead is back at follow-up`,
        },
      });
    }

    // The quotation was frozen at ACCEPTED by the order. Sent is where it was
    // before, and where it has to be for the order to be placed again.
    if (order.quotationId) {
      await tx.quotation.update({
        where: { id: order.quotationId },
        data: {
          status: "SENT",
          acceptedAt: null,
          // The mirrored row names the order, so it has to be rewritten.
          sheetStatus: "PENDING",
        },
      });
    }

    // Payments cascade from the Payment.orderId foreign key.
    await tx.order.delete({ where: { id: order.id } });

    return {
      orderNo: order.orderNo,
      receivedPaise,
      payments: order.payments.length,
    };
  });
}

/** Undo a mis-keyed payment. Reopens the order if it is no longer fully paid. */
export async function deletePayment(
  user: SessionUser,
  paymentId: string,
): Promise<void> {
  requirePermission(user.role, "payment.delete");

  await prisma.$transaction(async (tx) => {
    // Scoped through the parent order like every other money path in this
    // file. payment.delete happens to be management-only today, and
    // management sees every order - but that made this the one mutating
    // lookup whose safety came from the permission table alone, so widening
    // the permission by a single line would have widened this to every
    // payment in the company.
    const payment = await tx.payment.findFirst({
      where: { AND: [{ id: paymentId }, { order: ordersWhere(user) }] },
      select: {
        id: true,
        amountPaise: true,
        order: {
          select: { id: true, orderNo: true, amountPaise: true, stage: true, leadId: true },
        },
      },
    });
    if (!payment) throw new NotFoundError("That payment");

    await tx.payment.delete({ where: { id: paymentId } });

    const aggregate = await tx.payment.aggregate({
      where: { orderId: payment.order.id },
      _sum: { amountPaise: true },
    });
    const received = toPaise(aggregate._sum.amountPaise);
    const amount = toPaise(payment.order.amountPaise);

    // A closed order that is no longer fully paid must not stay closed.
    if (payment.order.stage === "CLOSED" && received < amount) {
      await tx.order.update({
        where: { id: payment.order.id },
        data: { stage: "WITH_CRE", closedAt: null },
      });
    }

    if (payment.order.leadId) {
      await tx.leadActivity.create({
        data: {
          leadId: payment.order.leadId,
          kind: "PAYMENT",
          actorId: user.id,
          message: `${user.name} removed a payment of ${formatPaise(
            toPaise(payment.amountPaise),
          )} from ${payment.order.orderNo}`,
        },
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Closing and editing
// ---------------------------------------------------------------------------

/** Close a fully paid order. Refused while anything is due. */
export async function closeOrder(
  user: SessionUser,
  orderId: string,
): Promise<void> {
  requirePermission(user.role, "order.close");

  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;

    const order = await tx.order.findFirst({
      where: { AND: [{ id: orderId }, ordersWhere(user)] },
      select: {
        id: true,
        orderNo: true,
        stage: true,
        amountPaise: true,
        leadId: true,
        payments: { select: { amountPaise: true } },
      },
    });
    if (!order) throw new NotFoundError("That order");
    if (order.stage === "CLOSED") return;

    const money = orderMoney(order.amountPaise, order.payments);
    if (!canClose(money)) {
      throw new ConflictError(
        `${formatPaise(money.duePaise)} is still due. An order can only be closed when nothing is outstanding.`,
      );
    }

    await tx.order.update({
      where: { id: order.id },
      data: { stage: "CLOSED", closedAt: new Date() },
    });

    if (order.leadId) {
      await tx.leadActivity.create({
        data: {
          leadId: order.leadId,
          kind: "CLOSED",
          actorId: user.id,
          message: `${user.name} closed order ${order.orderNo}`,
        },
      });
    }
  });
}

/** Reopen a closed order, e.g. because more work was added to it. */
export async function reopenOrder(
  user: SessionUser,
  orderId: string,
): Promise<void> {
  requirePermission(user.role, "order.update");

  const order = await prisma.order.findFirst({
    where: { AND: [{ id: orderId }, ordersWhere(user)] },
    select: { id: true, stage: true, creId: true },
  });
  if (!order) throw new NotFoundError("That order");
  if (order.stage !== "CLOSED") return;

  await prisma.order.update({
    where: { id: order.id },
    data: { stage: order.creId ? "WITH_CRE" : "CONFIRMED", closedAt: null },
  });
}

export interface OrderUpdateInput {
  amountPaise?: number;
  title?: string | null;
  notes?: string | null;
}

/** The value can never drop below what has already been received. */
export async function updateOrder(
  user: SessionUser,
  orderId: string,
  input: OrderUpdateInput,
): Promise<void> {
  requirePermission(user.role, "order.update");

  const order = await prisma.order.findFirst({
    where: { AND: [{ id: orderId }, ordersWhere(user)] },
    select: { id: true, payments: { select: { amountPaise: true } } },
  });
  if (!order) throw new NotFoundError("That order");

  const data: Prisma.OrderUpdateInput = {};

  if (input.amountPaise !== undefined) {
    if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) {
      throw new ValidationError("Enter the order value.", {
        amount: "Enter an amount greater than zero",
      });
    }
    const received = order.payments.reduce(
      (sum, payment) => sum + toPaise(payment.amountPaise),
      0,
    );
    if (input.amountPaise < received) {
      throw new ConflictError(
        `${formatPaise(received)} has already been received against this order. The value cannot be set below that.`,
      );
    }
    data.amountPaise = toBigIntPaise(input.amountPaise);
  }

  if (input.title !== undefined) data.title = cleanText(input.title, 200);
  if (input.notes !== undefined) data.notes = cleanText(input.notes, 2000);

  if (Object.keys(data).length === 0) return;
  await prisma.order.update({ where: { id: orderId }, data });
}

/** Contact phone normalisation is shared with lead ingest. */
export { normalizePhone };
