import "server-only";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { monthRange, type MonthRange } from "@/lib/dates";
import { toPaise } from "@/lib/money";
import { scopeWords } from "@/lib/permissions";
import type { SessionUser } from "@/lib/session";
import {
  leadsWhere,
  ordersWhere,
  overviewSalesmanWhere,
  poolWhere,
  quotationsWhere,
} from "./scope";

/**
 * Everything on the Overview page, for one month and one viewer.
 *
 * Two rules drive the shape of this module.
 *
 * 1. Every figure obeys the month picker. Each metric is anchored to its own
 *    natural timestamp, and the page prints that anchor next to the number so
 *    nobody has to guess: leads by when they arrived, grabs by when they were
 *    grabbed, orders by when they were confirmed, money by when it was
 *    received, closures by when they were closed.
 *
 * 2. Scope comes from lib/permissions, not from this file. An admin sees
 *    everybody, a salesman sees their own row and the CREs underneath them,
 *    a CRE sees only their own orders.
 */

export interface OverviewCounts {
  /** Unowned leads that arrived this month and are still up for grabs. */
  waiting: number;
  /** Owned leads that arrived this month and are still open. */
  working: number;
  /** Leads that arrived this month and turned into an order. */
  confirmed: number;
  /** Leads that arrived this month and were marked lost. */
  lost: number;
  total: number;
}

export interface OverviewArea {
  /** Thousandths of a square metre quoted in the month. */
  quotedMilli: number;
  /** Thousandths confirmed into an order in the month. */
  confirmedMilli: number;
}

export interface OverviewMoney {
  /** Value of every order confirmed this month. */
  orderValuePaise: number;
  /** Money that actually arrived this month, whenever the order was confirmed. */
  receivedPaise: number;
  /** Still outstanding on the orders confirmed this month. */
  duePaise: number;
  /** Orders won, i.e. confirmed, this month. */
  ordersWon: number;
}

export interface CreRow {
  id: string;
  name: string;
  /** Orders confirmed this month that this CRE is holding. */
  ordersHeld: number;
  /** Orders this CRE closed this month. */
  ordersClosed: number;
  /** Money received this month against orders held by this CRE. */
  collectedPaise: number;
  /** Value of the orders they are holding from this month. */
  orderValuePaise: number;
  /** Outstanding on those orders. */
  duePaise: number;
}

export interface SalesmanRow {
  id: string;
  name: string;
  email: string;
  grabbed: number;
  working: number;
  confirmed: number;
  lost: number;
  orderValuePaise: number;
  receivedPaise: number;
  cres: CreRow[];
}

export interface OverviewData {
  month: MonthRange;
  months: { key: string; label: string }[];
  viewer: { name: string; role: SessionUser["role"] };
  scopeLabel: string;
  counts: OverviewCounts;
  money: OverviewMoney;
  area: OverviewArea;
  /** Empty for a CRE, one row for a salesman, everybody for admin and owner. */
  salesmen: SalesmanRow[];
  /** Populated only when the viewer is a CRE looking at their own numbers. */
  self: CreRow | null;
  showLeadCounts: boolean;
}

export async function getOverview(
  user: SessionUser,
  monthKey: string | null | undefined,
  months: { key: string; label: string }[],
): Promise<OverviewData> {
  const month = monthRange(monthKey);
  const window = { gte: month.start, lt: month.endExclusive };

  const scopedOrders = ordersWhere(user);
  const showLeadCounts = user.role !== "CRE";

  const scopedQuotations = quotationsWhere(user);

  const [counts, money, area, salesmen, self] = await Promise.all([
    showLeadCounts
      ? leadCounts(user, window)
      : Promise.resolve({ waiting: 0, working: 0, confirmed: 0, lost: 0, total: 0 }),
    moneyTotals(scopedOrders, window),
    areaTotals(scopedQuotations, window),
    salesmanRows(user, window),
    user.role === "CRE" ? creSelf(user, window) : Promise.resolve(null),
  ]);

  return {
    month,
    months,
    viewer: { name: user.name, role: user.role },
    scopeLabel: scopeWords(user.role, "overview"),
    counts,
    money,
    area,
    salesmen,
    self,
    showLeadCounts,
  };
}

// ---------------------------------------------------------------------------
// Lead counts, anchored on when the lead arrived
// ---------------------------------------------------------------------------

type Window = { gte: Date; lt: Date };

async function leadCounts(
  user: SessionUser,
  window: Window,
): Promise<OverviewCounts> {
  // Both clauses come from scope.ts rather than being rebuilt here. The old
  // version derived its own filter from DATA_SCOPES.leads === "ALL", which
  // meant a CRE would have been counted on `ownerId` - a column a CRE never
  // appears in - and only the role check in getOverview() kept that hidden.
  const mine = leadsWhere(user);
  const pool = poolWhere(user);

  /*
   * One round-trip, not five.
   *
   * These were five separate count() calls over the same table and the same
   * month, differing only in status and ownership. Against Neon each one is
   * its own network round-trip - about 57ms from the app server - so the page
   * was paying a quarter of a second to count a table that is usually empty.
   * One groupBy returns the same five numbers and the bucketing happens here.
   *
   * The where clause is exactly the union the old `total` used, so the scope
   * is unchanged: this viewer's own leads, plus whatever of the pool they are
   * allowed to see.
   */
  const groups = await prisma.lead.groupBy({
    by: ["ownerId", "status"],
    where: {
      AND: [
        { receivedAt: window },
        {
          OR: [mine, { AND: [pool, { status: { in: ["NEW", "FOLLOW_UP"] } }] }],
        },
      ],
    },
    _count: { _all: true },
  });

  const counts: OverviewCounts = {
    waiting: 0,
    working: 0,
    confirmed: 0,
    lost: 0,
    total: 0,
  };

  for (const group of groups) {
    const n = group._count._all;
    counts.total += n;

    // Only the pool half of the union can carry a null owner, and only the
    // `mine` half can carry a non-null one, so this is the same split the
    // five separate queries made.
    const pooled = group.ownerId === null;
    const open = group.status === "NEW" || group.status === "FOLLOW_UP";

    if (pooled) {
      if (open) counts.waiting += n;
      continue;
    }
    if (open) counts.working += n;
    else if (group.status === "ORDER_CONFIRMED") counts.confirmed += n;
    else if (group.status === "LOST") counts.lost += n;
  }

  return counts;
}

// ---------------------------------------------------------------------------
// Area
// ---------------------------------------------------------------------------

/**
 * How much panel, not just how much money.
 *
 * Every other figure on this page is rupees or a count, which is what made it
 * read like any other dashboard: the plant schedules against square metres,
 * and the app could not answer that question at all. Only area units are
 * summed - a line quoted in NOS is a door, not an area, and adding the two
 * would be a number that means nothing.
 */
async function areaTotals(
  scopedQuotations: Prisma.QuotationWhereInput,
  window: Window,
): Promise<OverviewArea> {
  const area: Prisma.QuotationItemWhereInput = {
    uom: { equals: "SQM", mode: "insensitive" },
  };

  const [quoted, confirmed] = await Promise.all([
    prisma.quotationItem.aggregate({
      where: {
        AND: [area, { quotation: { AND: [scopedQuotations, { createdAt: window }] } }],
      },
      _sum: { qtyMilli: true },
    }),
    prisma.quotationItem.aggregate({
      where: {
        AND: [
          area,
          { quotation: { AND: [scopedQuotations, { order: { confirmedAt: window } }] } },
        ],
      },
      _sum: { qtyMilli: true },
    }),
  ]);

  return {
    quotedMilli: quoted._sum.qtyMilli ?? 0,
    confirmedMilli: confirmed._sum.qtyMilli ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

async function moneyTotals(
  scopedOrders: Prisma.OrderWhereInput,
  window: Window,
): Promise<OverviewMoney> {
  // Orders confirmed this month, with every payment ever made against them,
  // so `due` is the true outstanding rather than "value minus this month".
  const [orders, receivedThisMonth] = await Promise.all([
    prisma.order.findMany({
      where: { AND: [scopedOrders, { confirmedAt: window }] },
      select: { amountPaise: true, payments: { select: { amountPaise: true } } },
    }),
    prisma.payment.aggregate({
      where: { receivedAt: window, order: scopedOrders },
      _sum: { amountPaise: true },
    }),
  ]);

  let orderValuePaise = 0;
  let paidOnThoseOrders = 0;
  for (const order of orders) {
    const amount = toPaise(order.amountPaise);
    orderValuePaise += amount;
    const paid = order.payments.reduce(
      (sum, payment) => sum + toPaise(payment.amountPaise),
      0,
    );
    paidOnThoseOrders += Math.min(paid, amount);
  }

  return {
    orderValuePaise,
    receivedPaise: toPaise(receivedThisMonth._sum.amountPaise),
    duePaise: Math.max(0, orderValuePaise - paidOnThoseOrders),
    ordersWon: orders.length,
  };
}

// ---------------------------------------------------------------------------
// The by-salesman table
// ---------------------------------------------------------------------------

async function salesmanRows(
  user: SessionUser,
  window: Window,
): Promise<SalesmanRow[]> {
  const salesmen = await prisma.user.findMany({
    where: overviewSalesmanWhere(user),
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      email: true,
      // `cres` is the join table now, so the CRE is one hop further in. A CRE
      // shared between two salesmen appears under both, which is the point.
      cres: {
        orderBy: { cre: { name: "asc" } },
        select: { cre: { select: { id: true, name: true } } },
      },
    },
  });

  if (salesmen.length === 0) return [];

  const salesmanIds = salesmen.map((s) => s.id);
  const creIds = salesmen.flatMap((s) => s.cres.map((link) => link.cre.id));

  const [leadGroups, orders, payments, closures] = await Promise.all([
    // Leads by owner and status, anchored on when they were grabbed.
    prisma.lead.groupBy({
      by: ["ownerId", "status"],
      where: { ownerId: { in: salesmanIds }, grabbedAt: window },
      _count: { _all: true },
    }),
    // Orders confirmed this month, with payments, so we can split value/due
    // by salesman and by the CRE currently holding them.
    prisma.order.findMany({
      where: { salesmanId: { in: salesmanIds }, confirmedAt: window },
      select: {
        salesmanId: true,
        creId: true,
        stage: true,
        amountPaise: true,
        payments: { select: { amountPaise: true } },
      },
    }),
    // Money that arrived this month, attributed to both the salesman on the
    // order and the CRE holding it.
    prisma.payment.findMany({
      where: {
        receivedAt: window,
        order: { salesmanId: { in: salesmanIds } },
      },
      select: {
        amountPaise: true,
        order: { select: { salesmanId: true, creId: true } },
      },
    }),
    // Orders closed this month, for the CRE "closed" column. salesmanId comes
    // back too: a CRE working for two salesmen closes orders for both, and
    // each has to land in the right section.
    creIds.length > 0
      ? prisma.order.findMany({
          where: { creId: { in: creIds }, closedAt: window },
          select: { creId: true, salesmanId: true },
        })
      : Promise.resolve([] as { creId: string | null; salesmanId: string }[]),
  ]);

  const grabbed = new Map<string, number>();
  const working = new Map<string, number>();
  const lost = new Map<string, number>();

  for (const group of leadGroups) {
    if (!group.ownerId) continue;
    const n = group._count._all;
    bump(grabbed, group.ownerId, n);
    if (group.status === "NEW" || group.status === "FOLLOW_UP") {
      bump(working, group.ownerId, n);
    } else if (group.status === "LOST") {
      bump(lost, group.ownerId, n);
    }
  }

  const orderCount = new Map<string, number>();
  const orderValue = new Map<string, number>();

  /*
   * The CRE figures are keyed by the (salesman, CRE) pair, not by the CRE.
   *
   * They used to be keyed by creId alone, which was correct while a CRE
   * reported to exactly one salesman. Once one CRE could work for several,
   * the same total was printed under every salesman they served: Kaushal's
   * section showed Vivek's order because the CRE holding it also worked for
   * Kaushal. Pairing the key puts each order under the salesman it actually
   * belongs to, and the sub-rows add up to the salesman row above them again.
   */
  const creHeld = new Map<string, number>();
  const creValue = new Map<string, number>();
  const creDue = new Map<string, number>();

  for (const order of orders) {
    const amount = toPaise(order.amountPaise);
    const paid = order.payments.reduce(
      (sum, payment) => sum + toPaise(payment.amountPaise),
      0,
    );
    bump(orderCount, order.salesmanId, 1);
    bump(orderValue, order.salesmanId, amount);

    if (order.creId) {
      const key = pairKey(order.salesmanId, order.creId);
      bump(creHeld, key, 1);
      bump(creValue, key, amount);
      bump(creDue, key, Math.max(0, amount - paid));
    }
  }

  const received = new Map<string, number>();
  const creCollected = new Map<string, number>();
  for (const payment of payments) {
    const amount = toPaise(payment.amountPaise);
    bump(received, payment.order.salesmanId, amount);
    if (payment.order.creId) {
      bump(
        creCollected,
        pairKey(payment.order.salesmanId, payment.order.creId),
        amount,
      );
    }
  }

  const creClosed = new Map<string, number>();
  for (const closed of closures) {
    if (closed.creId) bump(creClosed, pairKey(closed.salesmanId, closed.creId), 1);
  }

  return salesmen.map((salesman) => ({
    id: salesman.id,
    name: salesman.name,
    email: salesman.email,
    grabbed: grabbed.get(salesman.id) ?? 0,
    working: working.get(salesman.id) ?? 0,
    // Orders confirmed inside the month, not leads that happen to sit at
    // ORDER_CONFIRMED: an order confirmed this month from a lead grabbed last
    // month belongs to this month.
    confirmed: orderCount.get(salesman.id) ?? 0,
    lost: lost.get(salesman.id) ?? 0,
    orderValuePaise: orderValue.get(salesman.id) ?? 0,
    receivedPaise: received.get(salesman.id) ?? 0,
    cres: salesman.cres.map(({ cre }) => {
      // Read back with the same pair the figures were counted under, so a CRE
      // shared between salesmen shows each one only their own work.
      const key = pairKey(salesman.id, cre.id);
      return {
        id: cre.id,
        name: cre.name,
        ordersHeld: creHeld.get(key) ?? 0,
        ordersClosed: creClosed.get(key) ?? 0,
        collectedPaise: creCollected.get(key) ?? 0,
        orderValuePaise: creValue.get(key) ?? 0,
        duePaise: creDue.get(key) ?? 0,
      };
    }),
  }));
}

function bump(map: Map<string, number>, key: string, by: number): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

/** One salesman's slice of one CRE's work. */
function pairKey(salesmanId: string, creId: string): string {
  return `${salesmanId}:${creId}`;
}

// ---------------------------------------------------------------------------
// A CRE looking at themselves
// ---------------------------------------------------------------------------

async function creSelf(user: SessionUser, window: Window): Promise<CreRow> {
  const [orders, collected, closed] = await Promise.all([
    prisma.order.findMany({
      where: { creId: user.id, confirmedAt: window },
      select: { amountPaise: true, payments: { select: { amountPaise: true } } },
    }),
    prisma.payment.aggregate({
      where: { receivedAt: window, order: { creId: user.id } },
      _sum: { amountPaise: true },
    }),
    prisma.order.count({ where: { creId: user.id, closedAt: window } }),
  ]);

  let orderValuePaise = 0;
  let duePaise = 0;
  for (const order of orders) {
    const amount = toPaise(order.amountPaise);
    const paid = order.payments.reduce(
      (sum, payment) => sum + toPaise(payment.amountPaise),
      0,
    );
    orderValuePaise += amount;
    duePaise += Math.max(0, amount - paid);
  }

  return {
    id: user.id,
    name: user.name,
    ordersHeld: orders.length,
    ordersClosed: closed,
    collectedPaise: toPaise(collected._sum.amountPaise),
    orderValuePaise,
    duePaise,
  };
}
