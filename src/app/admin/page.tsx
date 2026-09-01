import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { listAllWorkspaces, readPlatformSession } from "@/server/platform";
import {
  impersonateAction,
  platformLogoutAction,
  setWorkspaceActiveAction,
} from "@/actions/platform";
import { ActionButton } from "@/components/form";
import { formatDate } from "@/lib/dates";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Notice,
  PageHeader,
  StatTile,
  Table,
  Td,
  Th,
} from "@/components/ui";

export const metadata: Metadata = { title: "Workspaces" };

/**
 * Every company using this software.
 *
 * One of only two places in the codebase that reads across organisations, and
 * it says so in the name of the function it calls. It sits behind a platform
 * session, which is a different cookie and a different table from the one the
 * CRM uses - so no tenant-scoped code path can ever be handed this authority
 * by accident.
 */
export default async function PlatformConsolePage() {
  const admin = await readPlatformSession();
  if (!admin) redirect("/admin/login");
  if (admin.mustChangePassword) redirect("/admin/password");

  const workspaces = await listAllWorkspaces();

  const totals = workspaces.reduce(
    (sum, w) => ({
      active: sum.active + (w.isActive ? 1 : 0),
      users: sum.users + w.users,
      orders: sum.orders + w.orders,
    }),
    { active: 0, users: 0, orders: 0 },
  );

  return (
    <main className="mx-auto max-w-6xl px-5 py-8 lg:px-8">
      <PageHeader
        title="Workspaces"
        subtitle={`Signed in as ${admin.name} (${admin.email})`}
        action={
          <form action={platformLogoutAction}>
            <button
              type="submit"
              className="rounded-lg border px-3 py-1.5 text-base hover:bg-[var(--bg-hover)]"
            >
              Sign out
            </button>
          </form>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatTile label="Workspaces" value={String(workspaces.length)} />
        <StatTile label="Active" value={String(totals.active)} />
        <StatTile label="People across all of them" value={String(totals.users)} />
      </div>

      <div className="mb-4">
        <Notice tone="neutral" title="Opening a workspace is recorded">
          &ldquo;Open&rdquo; signs you in to that company as their owner, with
          exactly their permissions and nothing more. A banner shows on every
          screen while you are there, and a line goes into that company&rsquo;s
          own audit trail - they can see that you came in.
        </Notice>
      </div>

      <Card>
        <CardHeader title="All workspaces" hint="Newest first." />
        {workspaces.length === 0 ? (
          <EmptyState
            title="Nobody has signed up yet"
            body="The first company to use /signup will appear here."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Company</Th>
                <Th>Owner</Th>
                <Th className="text-right">People</Th>
                <Th className="text-right">Leads</Th>
                <Th className="text-right">Quotes</Th>
                <Th className="text-right">Orders</Th>
                <Th>Signed up</Th>
                <Th>{""}</Th>
              </tr>
            </thead>
            <tbody>
              {workspaces.map((w) => (
                <tr key={w.id}>
                  <Td>
                    <div className="font-medium">{w.name}</div>
                    <div className="text-xs text-[var(--text-faint)]">
                      /{w.slug}
                      {w.isActive ? null : (
                        <Badge tone="danger" className="ml-2">
                          suspended
                        </Badge>
                      )}
                    </div>
                  </Td>
                  <Td className="text-sm text-[var(--text-muted)]">
                    {w.ownerEmail ?? "-"}
                  </Td>
                  <Td className="tnum text-right">{w.users}</Td>
                  <Td className="tnum text-right">{w.leads}</Td>
                  <Td className="tnum text-right">{w.quotations}</Td>
                  <Td className="tnum text-right">{w.orders}</Td>
                  <Td className="text-sm text-[var(--text-muted)]">
                    {formatDate(w.createdAt)}
                  </Td>
                  <Td>
                    <div className="flex justify-end gap-2">
                      {w.isActive ? (
                        <ActionButton
                          action={impersonateAction}
                          hidden={{ orgId: w.id }}
                          variant="secondary"
                          pendingLabel="Opening..."
                        >
                          Open
                        </ActionButton>
                      ) : null}
                      <ActionButton
                        action={setWorkspaceActiveAction}
                        hidden={{ orgId: w.id, isActive: String(!w.isActive) }}
                        variant={w.isActive ? "danger" : "primary"}
                        pendingLabel="Working..."
                        confirm={
                          w.isActive
                            ? `Suspend ${w.name}? Everybody there is signed out immediately and cannot sign back in.`
                            : undefined
                        }
                      >
                        {w.isActive ? "Suspend" : "Reactivate"}
                      </ActionButton>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </main>
  );
}
