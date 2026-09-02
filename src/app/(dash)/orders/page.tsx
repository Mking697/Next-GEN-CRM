import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { DATA_SCOPES, SCOPE_WORDS } from "@/lib/permissions";
import { formatDate } from "@/lib/dates";
import { formatCompactPaise, formatRupees } from "@/lib/money";
import { listOrders } from "@/server/orders";
import { ORDER_STAGE_LABEL } from "@/server/order-state";
import { PaymentBadge, StageBadge } from "@/components/badges";
import { Input, Select } from "@/components/fields";
import { Pagination } from "@/components/pagination";
import {
  buttonStyles,
  Card,
  EmptyState,
  LinkButton,
  Meter,
  Notice,
  PageHeader,
  StatTile,
  Table,
  Td,
  Th,
} from "@/components/ui";
import type { OrderStage } from "@/generated/prisma/enums";

export const metadata: Metadata = { title: "Orders" };

const STAGES: OrderStage[] = ["CONFIRMED", "WITH_CRE", "CLOSED"];

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    stage?: string;
    due?: string;
    page?: string;
    deleted?: string;
  }>;
}) {
  const user = await requireUser("/orders");
  const params = await searchParams;

  const stage = STAGES.includes(params.stage as OrderStage)
    ? (params.stage as OrderStage)
    : undefined;

  const orders = await listOrders(user, {
    q: params.q,
    stage,
    onlyDue: params.due === "1",
    page: Number(params.page) || 1,
  });

  const scope = SCOPE_WORDS[DATA_SCOPES[user.role].orders];

  return (
    <>
      <PageHeader
        title="Orders"
        subtitle={
          user.role === "CRE"
            ? "The orders handed to you. Record what comes in, and close an order once nothing is due."
            : `Showing ${scope}.`
        }
      />

      {params.deleted ? (
        <div className="mb-4">
          <Notice tone="ok" title="Order deleted">
            {params.deleted}
          </Notice>
        </div>
      ) : null}

      <div className="mb-4 grid grid-cols-3 gap-3">
        <StatTile
          label="Value on this page"
          value={formatCompactPaise(orders.totals.amountPaise)}
        />
        <StatTile
          label="Received"
          value={formatCompactPaise(orders.totals.receivedPaise)}
          tone="ok"
        />
        <StatTile
          label="Due"
          value={formatCompactPaise(orders.totals.duePaise)}
          tone={orders.totals.duePaise > 0 ? "warn" : "neutral"}
        />
      </div>

      <Card className="mb-4" padded={false}>
        <form className="flex flex-wrap items-center gap-2 p-3" action="/orders">
          <Input
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="Search order number, company or contact"
            className="min-w-56 flex-1 py-1.5"
          />
          <Select name="stage" defaultValue={stage ?? ""} className="w-auto py-1.5">
            <option value="">Every stage</option>
            {STAGES.map((value) => (
              <option key={value} value={value}>
                {ORDER_STAGE_LABEL[value]}
              </option>
            ))}
          </Select>
          <label className="flex items-center gap-1.5 text-base text-[var(--text-muted)]">
            <input
              type="checkbox"
              name="due"
              value="1"
              defaultChecked={params.due === "1"}
              className="accent-[var(--accent)]"
            />
            Only with money due
          </label>
          <button type="submit" className={buttonStyles.secondary}>
            Filter
          </button>
        </form>
      </Card>

      {orders.items.length === 0 ? (
        <EmptyState
          title={params.q || stage || params.due ? "Nothing matches" : "No orders yet"}
          body={
            params.q || stage || params.due
              ? "Clear the filter to see everything."
              : user.role === "CRE"
                ? "Orders appear here once a salesman hands one to you."
                : "Confirm a lead into an order and it will show up here."
          }
          action={
            params.q || stage || params.due ? (
              <LinkButton href="/orders">Clear filter</LinkButton>
            ) : null
          }
        />
      ) : (
        <Card>
          <Table sticky>
            <thead>
              <tr>
                <Th>Order</Th>
                <Th>Stage</Th>
                <Th>People</Th>
                <Th align="right">Value</Th>
                <Th align="right">Received</Th>
                <Th align="right">Due</Th>
              </tr>
            </thead>
            <tbody>
              {orders.items.map((order) => (
                <tr key={order.id}>
                  <Td>
                    <Link
                      href={`/orders/${order.id}`}
                      className="font-mono text-sm font-medium hover:text-[var(--accent-text)]"
                    >
                      {order.orderNo}
                    </Link>
                    <div className="text-base">{order.companyName}</div>
                    <div className="text-xs text-[var(--text-faint)]">
                      {order.title ?? "-"} &middot; {formatDate(order.confirmedAt)}
                    </div>
                  </Td>
                  <Td>
                    <div className="flex flex-col items-start gap-1">
                      <StageBadge stage={order.stage} hasCre={Boolean(order.creId)} />
                      <PaymentBadge state={order.paymentState} />
                    </div>
                  </Td>
                  <Td className="text-sm">
                    <div>{order.salesmanName}</div>
                    <div className="text-xs text-[var(--text-faint)]">
                      {order.creName ?? "no CRE"}
                    </div>
                  </Td>
                  <Td align="right" numeric>
                    {formatRupees(order.amountPaise)}
                  </Td>
                  <Td align="right" numeric>
                    <div className="text-[var(--ok)]">
                      {formatRupees(order.receivedPaise)}
                    </div>
                    <div className="mt-1 w-20">
                      <Meter
                        percent={order.percentReceived}
                        tone={order.paymentState === "PAID" ? "ok" : "accent"}
                      />
                    </div>
                  </Td>
                  <Td align="right" numeric>
                    {order.duePaise > 0 ? (
                      <span className="text-[var(--warn)]">
                        {formatRupees(order.duePaise)}
                      </span>
                    ) : (
                      <span className="text-[var(--text-faint)]">-</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>

          <Pagination
            page={orders.page}
            pageCount={orders.pageCount}
            total={orders.total}
            base="/orders"
            params={params}
          />
        </Card>
      )}
    </>
  );
}
