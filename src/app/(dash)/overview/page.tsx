import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { recentMonths } from "@/lib/dates";
import { formatCompactPaise, formatPaise, formatRupees } from "@/lib/money";
import { ROLE_LABEL } from "@/lib/permissions";
import { getOverview } from "@/server/overview";
import { MonthPicker } from "@/components/month-picker";
import {
  Card,
  CardHeader,
  EmptyState,
  PageHeader,
  StatTile,
  Table,
  Td,
  Th,
} from "@/components/ui";

export const metadata: Metadata = { title: "Overview" };

/**
 * Every figure on this page obeys the month picker at the top.
 *
 * Each metric is anchored to its own natural timestamp and the anchor is
 * printed under the number, so "received" is never mistaken for "received
 * against this month's orders" or the other way round.
 */
export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const user = await requireUser("/overview");
  const { month: monthParam } = await searchParams;

  const months = recentMonths(18);
  const data = await getOverview(user, monthParam, months);

  const { counts, money, month } = data;

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={
          <>
            {ROLE_LABEL[user.role]} view, showing {data.scopeLabel}. Every number
            below is for {month.label}.
          </>
        }
        action={<MonthPicker months={months} value={month.key} />}
      />

      {data.showLeadCounts ? (
        <section className="mb-6" aria-labelledby="lead-counts">
          <h2
            id="lead-counts"
            className="mb-2.5 text-xs font-medium tracking-wide text-[var(--text-faint)] uppercase"
          >
            Leads that arrived in {month.shortLabel}
          </h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatTile
              label="Waiting"
              value={counts.waiting}
              hint="In the pool, nobody has grabbed them"
              tone={counts.waiting > 0 ? "warn" : "neutral"}
            />
            <StatTile
              label="Being worked"
              value={counts.working}
              hint="Grabbed, still open"
            />
            <StatTile
              label="Order confirmed"
              value={counts.confirmed}
              hint="Turned into an order"
              tone="ok"
            />
            <StatTile label="Lost" value={counts.lost} hint="Marked lost with a reason" />
            <StatTile label="Total leads" value={counts.total} hint="All four, added up" />
          </div>
        </section>
      ) : null}

      <section className="mb-6" aria-labelledby="money">
        <h2
          id="money"
          className="mb-2.5 text-xs font-medium tracking-wide text-[var(--text-faint)] uppercase"
        >
          Money in {month.shortLabel}
        </h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <StatTile
            label="Order value"
            value={formatCompactPaise(money.orderValuePaise)}
            sub={`${money.ordersWon} order${money.ordersWon === 1 ? "" : "s"}`}
            hint={`${formatPaise(money.orderValuePaise)} across orders confirmed this month`}
          />
          <StatTile
            label="Received"
            value={formatCompactPaise(money.receivedPaise)}
            hint={`${formatPaise(money.receivedPaise)} banked this month, on any order`}
            tone="ok"
          />
          <StatTile
            label="Due"
            value={formatCompactPaise(money.duePaise)}
            hint={`${formatPaise(money.duePaise)} still outstanding on this month's orders`}
            tone={money.duePaise > 0 ? "warn" : "neutral"}
          />
        </div>
      </section>

      {/*
        The plant schedules against square metres, so the month has to be
        answerable in panel as well as in rupees. Only area-quoted lines count:
        a door quoted in NOS is not an area, and folding the two together would
        be a number nobody could act on.
      */}
      <section className="mb-6" aria-labelledby="area">
        <h2
          id="area"
          className="mb-2.5 text-xs font-medium tracking-wide text-[var(--text-faint)] uppercase"
        >
          Panel in {month.shortLabel}
        </h2>
        <div className="grid grid-cols-2 gap-3">
          <StatTile
            label="Quoted"
            value={formatArea(data.area.quotedMilli)}
            sub="SQM"
            hint={`Across quotations raised in ${month.shortLabel}`}
          />
          <StatTile
            label="Confirmed"
            value={formatArea(data.area.confirmedMilli)}
            sub="SQM"
            tone={data.area.confirmedMilli > 0 ? "ok" : "neutral"}
            hint={`Turned into an order in ${month.shortLabel}`}
          />
        </div>
      </section>

      {user.role === "CRE" && data.self ? (
        <Card>
          <CardHeader
            title="Your orders"
            hint={`What you are holding from ${month.label}, what you closed, and what you collected.`}
          />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Orders held" value={data.self.ordersHeld} />
            <StatTile label="Closed" value={data.self.ordersClosed} tone="ok" />
            <StatTile
              label="Collected"
              value={formatCompactPaise(data.self.collectedPaise)}
              tone="ok"
            />
            <StatTile
              label="Due"
              value={formatCompactPaise(data.self.duePaise)}
              tone={data.self.duePaise > 0 ? "warn" : "neutral"}
            />
          </div>
        </Card>
      ) : null}

      {data.salesmen.length > 0 ? (
        <Card>
          <CardHeader
            title="By salesman"
            hint="Open a row to see the CREs under that salesman, the orders they are holding, how many they closed and how much they collected."
          />
          <Table>
            <thead>
              <tr>
                <Th>Salesman</Th>
                <Th align="right">Grabbed</Th>
                <Th align="right">Working</Th>
                <Th align="right">Confirmed</Th>
                <Th align="right">Lost</Th>
                <Th align="right">Order value</Th>
                <Th align="right">Received</Th>
              </tr>
            </thead>
            <tbody>
              {data.salesmen.map((salesman) => (
                <SalesmanRows key={salesman.id} salesman={salesman} />
              ))}
            </tbody>
          </Table>

          <p className="mt-3 text-xs leading-relaxed text-[var(--text-faint)]">
            Grabbed, working and lost count leads grabbed inside {month.label}.
            Confirmed and order value count orders confirmed inside{" "}
            {month.label}. Received counts money that arrived inside{" "}
            {month.label}, whenever the order was confirmed.
          </p>
        </Card>
      ) : user.role === "CRE" ? null : (
        <EmptyState
          title="No salesmen yet"
          body="Once an admin creates salesman accounts and they start grabbing leads, their rows appear here."
        />
      )}
    </>
  );
}

/**
 * Thousandths of a square metre as a plain figure. The unit is the tile's
 * `sub`, so the number stays the number and SQM sits beside it.
 */
function formatArea(milli: number): string {
  return (milli / 1000).toLocaleString("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function SalesmanRows({
  salesman,
}: {
  salesman: Awaited<ReturnType<typeof getOverview>>["salesmen"][number];
}) {
  const hasCres = salesman.cres.length > 0;

  return (
    <>
      <tr className="group">
        <Td>
          {hasCres ? (
            <details className="[&[open]_.chev]:rotate-90">
              <summary className="flex items-center gap-1.5">
                <span className="chev inline-block text-2xs text-[var(--text-faint)] transition-transform">
                  &#9654;
                </span>
                <span className="font-medium">{salesman.name}</span>
                <span className="text-xs text-[var(--text-faint)]">
                  {salesman.cres.length} CRE{salesman.cres.length === 1 ? "" : "s"}
                </span>
              </summary>
              <div className="mt-2.5 ml-4 overflow-hidden rounded-lg border">
                <table className="w-full border-collapse text-sm">
                  <thead className="bg-[var(--bg-sunken)]">
                    <tr>
                      <Th className="py-1.5">CRE</Th>
                      <Th align="right" className="py-1.5">
                        Orders held
                      </Th>
                      <Th align="right" className="py-1.5">
                        Closed
                      </Th>
                      <Th align="right" className="py-1.5">
                        Collected
                      </Th>
                      <Th align="right" className="py-1.5">
                        Due
                      </Th>
                    </tr>
                  </thead>
                  <tbody>
                    {salesman.cres.map((cre) => (
                      <tr key={cre.id}>
                        <Td className="py-1.5">{cre.name}</Td>
                        <Td align="right" numeric className="py-1.5">
                          {cre.ordersHeld}
                        </Td>
                        <Td align="right" numeric className="py-1.5">
                          {cre.ordersClosed}
                        </Td>
                        <Td align="right" numeric className="py-1.5">
                          {formatRupees(cre.collectedPaise)}
                        </Td>
                        <Td align="right" numeric className="py-1.5">
                          {cre.duePaise > 0 ? (
                            <span className="text-[var(--warn)]">
                              {formatRupees(cre.duePaise)}
                            </span>
                          ) : (
                            <span className="text-[var(--text-faint)]">-</span>
                          )}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ) : (
            <div>
              <span className="font-medium">{salesman.name}</span>
              <span className="ml-2 text-xs text-[var(--text-faint)]">
                no CREs assigned
              </span>
            </div>
          )}
        </Td>
        <Td align="right" numeric>
          {salesman.grabbed}
        </Td>
        <Td align="right" numeric>
          {salesman.working}
        </Td>
        <Td align="right" numeric>
          {salesman.confirmed}
        </Td>
        <Td align="right" numeric>
          {salesman.lost}
        </Td>
        <Td align="right" numeric>
          {formatRupees(salesman.orderValuePaise)}
        </Td>
        <Td align="right" numeric className="text-[var(--ok)]">
          {formatRupees(salesman.receivedPaise)}
        </Td>
      </tr>
    </>
  );
}
