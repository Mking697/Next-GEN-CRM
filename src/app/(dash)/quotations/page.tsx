import type { Metadata } from "next";
import Link from "next/link";
import { requirePageAccess } from "@/lib/auth";
import { can, DATA_SCOPES, SCOPE_WORDS } from "@/lib/permissions";
import { formatDate, relativeTime } from "@/lib/dates";
import { formatRupees } from "@/lib/money";
import { listQuotations } from "@/server/quotations";
import { QuotationBadge } from "@/components/badges";
import { Input, Select } from "@/components/fields";
import { Pagination } from "@/components/pagination";
import {
  buttonStyles,
  Card,
  EmptyState,
  LinkButton,
  Notice,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui";
import type { QuotationStatus } from "@/generated/prisma/enums";

export const metadata: Metadata = { title: "Quotations" };

const STATUSES: QuotationStatus[] = [
  "DRAFT",
  "SENT",
  "ACCEPTED",
  "REJECTED",
  "EXPIRED",
];

export default async function QuotationsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string; deleted?: string }>;
}) {
  const user = await requirePageAccess("quotation.view.own", "/quotations");
  const params = await searchParams;

  const status = STATUSES.includes(params.status as QuotationStatus)
    ? (params.status as QuotationStatus)
    : undefined;

  const quotations = await listQuotations(user, {
    q: params.q,
    status,
    page: Number(params.page) || 1,
  });

  const scope = SCOPE_WORDS[DATA_SCOPES[user.role].quotations];

  return (
    <>
      <PageHeader
        title="Quotations"
        subtitle={`Showing ${scope}.`}
        action={
          can(user.role, "quotation.create") ? (
            <LinkButton href="/quotations/new" variant="primary">
              New quotation
            </LinkButton>
          ) : null
        }
      />

      {params.deleted ? (
        <div className="mb-4">
          <Notice tone="ok">Quotation deleted.</Notice>
        </div>
      ) : null}

      <Card className="mb-4" padded={false}>
        <form className="flex flex-wrap items-center gap-2 p-3" action="/quotations">
          <Input
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="Search reference number, party or contact"
            className="min-w-56 flex-1 py-1.5"
          />
          <Select name="status" defaultValue={status ?? ""} className="w-auto py-1.5">
            <option value="">Every status</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {value.charAt(0) + value.slice(1).toLowerCase()}
              </option>
            ))}
          </Select>
          <button type="submit" className={buttonStyles.secondary}>
            Filter
          </button>
        </form>
      </Card>

      {quotations.items.length === 0 ? (
        <EmptyState
          title={params.q || status ? "Nothing matches" : "No quotations yet"}
          body={
            params.q || status
              ? "Clear the filter to see everything."
              : user.role === "CRE"
                ? "Start one from a lead your salesman handed you, or build a standalone quotation for a walk-in."
                : "Quotations appear here once your CREs start building them."
          }
          action={
            params.q || status ? (
              <LinkButton href="/quotations">Clear filter</LinkButton>
            ) : can(user.role, "quotation.create") ? (
              <LinkButton href="/quotations/new" variant="primary">
                New quotation
              </LinkButton>
            ) : null
          }
        />
      ) : (
        <Card>
          <Table sticky>
            <thead>
              <tr>
                <Th>Reference</Th>
                <Th>Party</Th>
                <Th>Status</Th>
                <Th>Built by</Th>
                <Th align="right">Payable</Th>
                <Th>Outcome</Th>
                <Th align="right">Action</Th>
              </tr>
            </thead>
            <tbody>
              {quotations.items.map((quotation) => (
                <tr key={quotation.id}>
                  <Td>
                    <Link
                      href={`/quotations/${quotation.id}`}
                      className="font-mono text-sm font-medium hover:text-[var(--accent-text)]"
                    >
                      {quotation.quoteNo}
                    </Link>
                    <div className="text-xs text-[var(--text-faint)]">
                      {formatDate(quotation.createdAt)}
                    </div>
                  </Td>
                  <Td>
                    <div className="max-w-64 truncate">{quotation.partyName}</div>
                    <div className="tnum text-xs text-[var(--text-faint)]">
                      {quotation.itemCount} line
                      {quotation.itemCount === 1 ? "" : "s"}
                      {quotation.quantityText ? ` · ${quotation.quantityText}` : ""}
                    </div>
                  </Td>
                  <Td>
                    <QuotationBadge status={quotation.status} />
                  </Td>
                  <Td className="text-sm text-[var(--text-muted)]">
                    {quotation.creName}
                  </Td>
                  <Td align="right" numeric className="font-medium">
                    {formatRupees(quotation.payablePaise)}
                  </Td>
                  <Td className="text-sm">
                    {quotation.orderId ? (
                      <Link
                        href={`/orders/${quotation.orderId}`}
                        className="text-[var(--accent-text)] hover:underline"
                      >
                        {quotation.orderNo}
                      </Link>
                    ) : quotation.validUntil ? (
                      <span
                        className={
                          quotation.validUntil.getTime() < Date.now()
                            ? "text-[var(--warn)]"
                            : "text-[var(--text-faint)]"
                        }
                      >
                        valid {relativeTime(quotation.validUntil)}
                      </span>
                    ) : (
                      <span className="text-[var(--text-faint)]">-</span>
                    )}
                  </Td>
                  <Td align="right">
                    {/* An order freezes the quotation, so past that point the
                        only honest action is to read it. */}
                    {!quotation.orderId && can(user.role, "quotation.update") ? (
                      <LinkButton
                        href={`/quotations/${quotation.id}`}
                        variant="secondary"
                      >
                        {quotation.status === "DRAFT" ? "Edit" : "Rework"}
                      </LinkButton>
                    ) : (
                      <LinkButton href={`/quotations/${quotation.id}`} variant="ghost">
                        View
                      </LinkButton>
                    )}
                    {quotation.revisionCount > 1 ? (
                      <div className="mt-1 text-2xs text-[var(--text-faint)]">
                        {quotation.revisionCount - 1} rework
                        {quotation.revisionCount - 1 === 1 ? "" : "s"}
                      </div>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>

          <Pagination
            page={quotations.page}
            pageCount={quotations.pageCount}
            total={quotations.total}
            base="/quotations"
            params={params}
          />
        </Card>
      )}
    </>
  );
}
