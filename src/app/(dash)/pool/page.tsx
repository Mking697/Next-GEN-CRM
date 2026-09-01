import type { Metadata } from "next";
import Link from "next/link";
import { requirePageAccess } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { formatDateTime, relativeTime } from "@/lib/dates";
import { formatPhone } from "@/lib/dedupe";
import { listPool, listSalesmenForAssign } from "@/server/leads";
import { LEAD_SOURCE_LABEL } from "@/server/order-state";
import { grabLeadAction, assignLeadAction } from "@/actions/leads";
import { ActionButton, ActionForm } from "@/components/form";
import { Select } from "@/components/fields";
import { Pagination } from "@/components/pagination";
import {
  Badge,
  Card,
  EmptyState,
  LinkButton,
  Notice,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui";
import type { LeadSource } from "@/generated/prisma/enums";

export const metadata: Metadata = { title: "Lead pool" };

/**
 * The shared pool. Every salesman and every admin sees exactly the same list;
 * a CRE cannot reach this page at all, which is enforced by `pool.view` in
 * requirePageAccess rather than by a role check written here.
 */
export default async function PoolPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; source?: string; page?: string }>;
}) {
  const user = await requirePageAccess("pool.view", "/pool");
  const params = await searchParams;

  const source = isSource(params.source) ? params.source : undefined;
  const pool = await listPool(user, {
    q: params.q,
    source,
    page: Number(params.page) || 1,
  });

  const canGrab = can(user.role, "lead.grab");
  const canAssign = can(user.role, "lead.assign");
  const salesmen = canAssign ? await listSalesmenForAssign() : [];

  return (
    <>
      <PageHeader
        title="Lead pool"
        subtitle={
          canGrab
            ? "Nobody owns these yet. Press Grab to take one. If two of you press at the same moment, exactly one wins and the other is told who got there first."
            : "Leads nobody owns yet. Assign one to a salesman, or wait for somebody to grab it."
        }
        action={
          can(user.role, "lead.create") ? (
            <LinkButton href="/leads/new" variant="primary">
              Add a lead
            </LinkButton>
          ) : null
        }
      />

      <Card className="mb-4" padded={false}>
        <form className="flex flex-wrap items-center gap-2 p-3" action="/pool">
          <input
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="Search name, company, city, product, phone"
            className="min-w-56 flex-1 rounded-lg border bg-[var(--bg-raised)] px-3 py-1.5 text-base"
          />
          <select
            name="source"
            defaultValue={source ?? ""}
            className="rounded-lg border bg-[var(--bg-raised)] px-3 py-1.5 text-base"
          >
            <option value="">Every source</option>
            <option value="INDIAMART">IndiaMART</option>
            <option value="META">Meta</option>
            <option value="MANUAL">Manual</option>
          </select>
          <button
            type="submit"
            className="rounded-lg border bg-[var(--bg-raised)] px-3 py-1.5 text-base hover:bg-[var(--bg-hover)]"
          >
            Filter
          </button>
        </form>
      </Card>

      {pool.items.length === 0 ? (
        <EmptyState
          title="The pool is empty"
          body={
            params.q || source
              ? "Nothing matches that filter. Clear it to see the whole pool."
              : "New enquiries from IndiaMART, Meta and manual entry land here. Everything that has arrived so far has been grabbed."
          }
          action={
            params.q || source ? (
              <LinkButton href="/pool">Clear filter</LinkButton>
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
                <Th>Product</Th>
                <Th>Arrived</Th>
                <Th align="right">Action</Th>
              </tr>
            </thead>
            <tbody>
              {pool.items.map((lead) => (
                <tr key={lead.id}>
                  <Td>
                    <Link
                      href={`/leads/${lead.id}`}
                      className="font-medium hover:text-[var(--accent-text)]"
                    >
                      {lead.personName}
                    </Link>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <Badge tone="accent">{LEAD_SOURCE_LABEL[lead.source]}</Badge>
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
                      {lead.email ?? "no email"}
                      {lead.city ? ` - ${lead.city}` : ""}
                    </div>
                  </Td>
                  <Td className="max-w-48 truncate text-[var(--text-muted)]">
                    {lead.product ?? "-"}
                  </Td>
                  <Td>
                    <div>{relativeTime(lead.receivedAt)}</div>
                    <div className="text-xs text-[var(--text-faint)]">
                      {formatDateTime(lead.receivedAt)}
                    </div>
                  </Td>
                  <Td align="right">
                    {canGrab ? (
                      <ActionButton
                        action={grabLeadAction}
                        variant="primary"
                        pendingLabel="Grabbing..."
                        hidden={{ leadId: lead.id }}
                      >
                        Grab
                      </ActionButton>
                    ) : canAssign ? (
                      <AssignForm leadId={lead.id} salesmen={salesmen} />
                    ) : (
                      <span className="text-xs text-[var(--text-faint)]">
                        Salesmen grab these
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>

          {pool.pageCount > 1 ? (
            <Pagination
              page={pool.page}
              pageCount={pool.pageCount}
              total={pool.total}
              base="/pool"
              params={params}
            />
          ) : null}
        </Card>
      )}

      {canAssign && salesmen.length === 0 ? (
        <div className="mt-4">
          <Notice tone="warn" title="No active salesmen">
            There is nobody to assign these leads to yet. Create a salesman
            account on the People page.
          </Notice>
        </div>
      ) : null}
    </>
  );
}

function AssignForm({
  leadId,
  salesmen,
}: {
  leadId: string;
  salesmen: { id: string; name: string }[];
}) {
  if (salesmen.length === 0) {
    return <span className="text-xs text-[var(--text-faint)]">No salesmen</span>;
  }
  return (
    <ActionForm
      action={assignLeadAction}
      submitLabel="Assign"
      submitVariant="secondary"
      pendingLabel="Assigning..."
      hidden={{ leadId }}
      className="flex items-center justify-end gap-2 space-y-0"
    >
      <Select name="salesmanId" defaultValue="" aria-label="Salesman" className="w-40">
        <option value="">Choose...</option>
        {salesmen.map((salesman) => (
          <option key={salesman.id} value={salesman.id}>
            {salesman.name}
          </option>
        ))}
      </Select>
    </ActionForm>
  );
}

function isSource(value: string | undefined): value is LeadSource {
  return value === "INDIAMART" || value === "META" || value === "MANUAL";
}
