import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { can, DATA_SCOPES, SCOPE_WORDS } from "@/lib/permissions";
import { formatDate, relativeTime } from "@/lib/dates";
import { formatPhone } from "@/lib/dedupe";
import { listLeads } from "@/server/leads";
import { LEAD_STATUS_LABEL } from "@/server/order-state";
import { Input, Select } from "@/components/fields";
import { Pagination } from "@/components/pagination";
import { SourceBadge, StatusBadge } from "@/components/badges";
import {
  buttonStyles,
  Card,
  EmptyState,
  LinkButton,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui";
import type { LeadStatus } from "@/generated/prisma/enums";

export const metadata: Metadata = { title: "Leads" };

const STATUSES: LeadStatus[] = ["NEW", "FOLLOW_UP", "ORDER_CONFIRMED", "LOST"];

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; page?: string }>;
}) {
  const user = await requireUser("/leads");
  const params = await searchParams;

  const status = STATUSES.includes(params.status as LeadStatus)
    ? (params.status as LeadStatus)
    : undefined;

  const leads = await listLeads(user, {
    q: params.q,
    status,
    page: Number(params.page) || 1,
  });

  const scope = SCOPE_WORDS[DATA_SCOPES[user.role].leads];

  return (
    <>
      <PageHeader
        title={can(user.role, "lead.view.all") ? "All leads" : "My leads"}
        subtitle={`Showing ${scope}. Leads with the nearest follow-up date come first.`}
        action={
          can(user.role, "lead.create") ? (
            <LinkButton href="/leads/new" variant="primary">
              Add a lead
            </LinkButton>
          ) : null
        }
      />

      <Card className="mb-4" padded={false}>
        <form className="flex flex-wrap items-center gap-2 p-3" action="/leads">
          <Input
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="Search name, company, city, product, phone"
            className="min-w-56 flex-1 py-1.5"
          />
          <Select name="status" defaultValue={status ?? ""} className="w-auto py-1.5">
            <option value="">Every status</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {LEAD_STATUS_LABEL[value]}
              </option>
            ))}
          </Select>
          <button type="submit" className={buttonStyles.secondary}>
            Filter
          </button>
        </form>
      </Card>

      {leads.items.length === 0 ? (
        <EmptyState
          title={params.q || status ? "Nothing matches" : "No leads yet"}
          body={
            params.q || status
              ? "Clear the filter to see everything."
              : user.role === "SALESMAN"
                ? "Grab something out of the lead pool, or type in a client you found yourself."
                : "Leads appear here once they have an owner."
          }
          action={
            params.q || status ? (
              <LinkButton href="/leads">Clear filter</LinkButton>
            ) : user.role === "SALESMAN" ? (
              <LinkButton href="/pool" variant="primary">
                Open the lead pool
              </LinkButton>
            ) : null
          }
        />
      ) : (
        <Card>
          <Table sticky>
            <thead>
              <tr>
                <Th>Lead</Th>
                <Th>Contact</Th>
                <Th>Status</Th>
                {can(user.role, "lead.view.all") ? <Th>Owner</Th> : null}
                <Th>Follow-up</Th>
              </tr>
            </thead>
            <tbody>
              {leads.items.map((lead) => (
                <tr key={lead.id}>
                  <Td>
                    <Link
                      href={`/leads/${lead.id}`}
                      className="font-medium hover:text-[var(--accent-text)]"
                    >
                      {lead.personName}
                    </Link>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <SourceBadge source={lead.source} />
                      {lead.companyName ? (
                        <span className="text-xs text-[var(--text-muted)]">
                          {lead.companyName}
                        </span>
                      ) : null}
                    </div>
                  </Td>
                  <Td>
                    <div className="tnum">{formatPhone(lead.phone)}</div>
                    <div className="text-xs text-[var(--text-faint)]">
                      {lead.city ?? lead.email ?? "-"}
                    </div>
                  </Td>
                  <Td>
                    <StatusBadge status={lead.status} />
                    {lead.orderId ? (
                      <Link
                        href={`/orders/${lead.orderId}`}
                        className="mt-1 block text-xs text-[var(--accent-text)] hover:underline"
                      >
                        Open order
                      </Link>
                    ) : null}
                  </Td>
                  {can(user.role, "lead.view.all") ? (
                    <Td className="text-[var(--text-muted)]">
                      {lead.ownerName ?? "In the pool"}
                    </Td>
                  ) : null}
                  <Td>
                    {lead.nextFollowUpAt ? (
                      <>
                        <div
                          className={
                            lead.nextFollowUpAt.getTime() < Date.now()
                              ? "text-[var(--warn)]"
                              : ""
                          }
                        >
                          {formatDate(lead.nextFollowUpAt)}
                        </div>
                        <div className="text-xs text-[var(--text-faint)]">
                          {relativeTime(lead.nextFollowUpAt)}
                        </div>
                      </>
                    ) : (
                      <span className="text-[var(--text-faint)]">not set</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>

          <Pagination
            page={leads.page}
            pageCount={leads.pageCount}
            total={leads.total}
            base="/leads"
            params={params}
          />
        </Card>
      )}
    </>
  );
}
