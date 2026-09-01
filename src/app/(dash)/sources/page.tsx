import type { Metadata } from "next";
import { requirePageAccess } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { formatDateTime, relativeTime } from "@/lib/dates";
import { getIndiamartStatus } from "@/server/ingest/indiamart";
import { getMetaStatus } from "@/server/ingest/meta";
import { listAudit } from "@/server/audit";
import {
  importClientsAction,
  retryMirrorsAction,
  runIndiamartSyncAction,
} from "@/actions/users";
import { googleHealth } from "@/lib/google";
import { isDriveEnabled, isGoogleEnabled } from "@/lib/env";
import { prisma } from "@/lib/db";
import { unmatchedExecutives } from "@/server/client-import";
import { ActionButton } from "@/components/form";
import {
  Badge,
  Card,
  CardHeader,
  DefinitionRow,
  Notice,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui";

export const metadata: Metadata = { title: "Lead sources" };

export default async function SourcesPage() {
  const user = await requirePageAccess("integration.view", "/sources");

  const [indiamart, audit, google, clientCount, unassignedClients, unmatched, pendingMirrors] =
    await Promise.all([
      getIndiamartStatus(),
      can(user.role, "audit.view") ? listAudit(40) : Promise.resolve([]),
      isGoogleEnabled()
        ? googleHealth()
        : Promise.resolve<Awaited<ReturnType<typeof googleHealth>>>({
            ok: false,
            error: "not configured",
          }),
      prisma.company.count(),
      prisma.company.count({ where: { salesmanId: null } }),
      unmatchedExecutives(),
      prisma.quotation.count({
        where: {
          sheetStatus: { in: ["PENDING", "FAILED"] },
          status: { in: ["SENT", "ACCEPTED"] },
        },
      }),
    ]);
  const meta = getMetaStatus();

  const nextAllowed = indiamart.nextAllowedAt;
  const readyNow = !nextAllowed || nextAllowed.getTime() <= Date.now();

  return (
    <>
      <PageHeader
        title="Lead sources"
        subtitle="Where leads come from, and whether each channel is actually wired up. Every value here is read from an environment variable; nothing is configured in the database."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="IndiaMART"
            hint="Lead Manager CRM API v2, pulled on a schedule."
            action={
              <Badge tone={indiamart.enabled ? "ok" : "neutral"}>
                {indiamart.enabled ? "Configured" : "Off"}
              </Badge>
            }
          />

          {!indiamart.enabled ? (
            <Notice tone="warn" title="Not configured">
              Set <span className="font-mono">INDIAMART_CRM_KEY</span> in the
              environment to switch this on. The key is in the IndiaMART seller
              panel under Lead Manager, Import/Export Leads, CRM API.
            </Notice>
          ) : (
            <>
              <dl className="mb-4">
                <DefinitionRow label="Last run">
                  {indiamart.lastRunAt ? (
                    <>
                      {relativeTime(indiamart.lastRunAt)}
                      <span className="ml-2 text-xs text-[var(--text-faint)]">
                        {formatDateTime(indiamart.lastRunAt)}
                      </span>
                    </>
                  ) : (
                    "never"
                  )}
                </DefinitionRow>
                <DefinitionRow label="Last success">
                  {indiamart.lastSuccessAt
                    ? formatDateTime(indiamart.lastSuccessAt)
                    : "never"}
                </DefinitionRow>
                <DefinitionRow label="Last result">
                  {indiamart.lastError ? (
                    <span className="text-[var(--danger)]">
                      {indiamart.lastError}
                    </span>
                  ) : (
                    <>
                      {indiamart.lastStatus ?? "-"}
                      {indiamart.fetched > 0 ? (
                        <span className="ml-2 text-xs text-[var(--text-faint)]">
                          {indiamart.fetched} pulled, {indiamart.created} new,{" "}
                          {indiamart.duplicates} already known
                        </span>
                      ) : null}
                    </>
                  )}
                </DefinitionRow>
                <DefinitionRow label="Rate limit">
                  One call every {indiamart.minIntervalMinutes} minutes, enforced
                  here before a request goes out
                </DefinitionRow>
                <DefinitionRow label="Next call allowed">
                  {readyNow ? (
                    <span className="text-[var(--ok)]">now</span>
                  ) : (
                    <span className="text-[var(--warn)]">
                      {relativeTime(nextAllowed)}
                    </span>
                  )}
                </DefinitionRow>
              </dl>

              {can(user.role, "integration.sync.run") ? (
                <ActionButton
                  action={runIndiamartSyncAction}
                  variant="primary"
                  pendingLabel="Pulling..."
                >
                  Pull now
                </ActionButton>
              ) : null}
            </>
          )}

          <div className="mt-4 border-t pt-3">
            <p className="text-sm leading-relaxed text-[var(--text-faint)]">
              This app runs as one process with no worker, so the schedule comes
              from outside. Point a cron at{" "}
              <span className="font-mono">POST /api/cron/indiamart</span> every 5
              minutes with the header{" "}
              <span className="font-mono">Authorization: Bearer $CRON_SECRET</span>.
              The route re-checks the interval itself, so a cron that fires early
              is refused rather than passed through to IndiaMART.
            </p>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Meta Lead Ads"
            hint="Webhook from Business Suite, then a Graph API fetch."
            action={
              <Badge tone={meta.enabled ? "ok" : "neutral"}>
                {meta.enabled ? "Configured" : "Off"}
              </Badge>
            }
          />

          {!meta.enabled ? (
            <Notice tone="warn" title="Not configured">
              Set <span className="font-mono">META_APP_SECRET</span> to switch
              this on. Without it every incoming webhook is rejected, because
              the signature cannot be verified.
            </Notice>
          ) : null}

          <dl>
            <DefinitionRow label="Callback URL">
              <code className="font-mono text-xs break-all">
                {meta.callbackUrl}
              </code>
            </DefinitionRow>
            <DefinitionRow label="Verify token">
              <Badge tone={meta.verifyTokenSet ? "ok" : "danger"}>
                {meta.verifyTokenSet ? "set" : "missing"}
              </Badge>
            </DefinitionRow>
            <DefinitionRow label="Page access token">
              <Badge tone={meta.pageTokenSet ? "ok" : "danger"}>
                {meta.pageTokenSet ? "set" : "missing"}
              </Badge>
            </DefinitionRow>
            <DefinitionRow label="Graph version">{meta.graphVersion}</DefinitionRow>
          </dl>

          <div className="mt-4 border-t pt-3">
            <p className="text-sm leading-relaxed text-[var(--text-faint)]">
              In the Meta app dashboard, add a Webhooks product, paste the
              callback URL above, use{" "}
              <span className="font-mono">META_VERIFY_TOKEN</span> as the verify
              token, and subscribe the page to the{" "}
              <span className="font-mono">leadgen</span> field. Every POST is
              checked against{" "}
              <span className="font-mono">X-Hub-Signature-256</span> before
              anything is read out of it.
            </p>
          </div>
        </Card>
      </div>

      {/* -- Google mirror --------------------------------------------------- */}
      <Card className="mt-4">
        <CardHeader
          title="Google Sheet and Drive"
          hint="Quotations are mirrored out to the sheet, and their PDFs to the Drive folder."
          action={
            <Badge tone={google.ok ? "ok" : isGoogleEnabled() ? "danger" : "neutral"}>
              {google.ok ? "Connected" : isGoogleEnabled() ? "Failing" : "Off"}
            </Badge>
          }
        />

        {!isGoogleEnabled() ? (
          <Notice tone="warn" title="Not configured">
            Set <span className="font-mono">GOOGLE_SERVICE_ACCOUNT_EMAIL</span>,{" "}
            <span className="font-mono">GOOGLE_PRIVATE_KEY</span> and{" "}
            <span className="font-mono">GOOGLE_SHEET_ID</span>. Quotations still
            save normally without this; only the mirror is off.
          </Notice>
        ) : !google.ok ? (
          <Notice tone="danger" title="Google is not answering">
            {google.error} &mdash; check that the service account has Editor on
            the sheet and Content Manager on the Shared Drive.
          </Notice>
        ) : (
          <>
            <dl className="mb-4">
              <DefinitionRow label="Spreadsheet">
                {google.spreadsheetTitle}
              </DefinitionRow>
              <DefinitionRow label="Tabs">
                <span className="text-sm">{google.tabs?.join(", ")}</span>
              </DefinitionRow>
              <DefinitionRow label="Drive upload">
                <Badge tone={isDriveEnabled() ? "ok" : "warn"}>
                  {isDriveEnabled()
                    ? "folder configured"
                    : "GOOGLE_DRIVE_FOLDER_ID not set"}
                </Badge>
              </DefinitionRow>
              <DefinitionRow label="Waiting to mirror">
                {pendingMirrors === 0 ? (
                  <span className="text-[var(--ok)]">nothing pending</span>
                ) : (
                  <span className="text-[var(--warn)]">
                    {pendingMirrors} quotation{pendingMirrors === 1 ? "" : "s"}
                  </span>
                )}
              </DefinitionRow>
              <DefinitionRow label="Clients in the CRM">
                {clientCount}
                {unassignedClients > 0 ? (
                  <span className="ml-2 text-xs text-[var(--warn)]">
                    {unassignedClients} with no salesman
                  </span>
                ) : null}
              </DefinitionRow>
            </dl>

            {can(user.role, "integration.sync.run") ? (
              <div className="flex flex-wrap gap-2">
                <ActionButton
                  action={importClientsAction}
                  variant="primary"
                  pendingLabel="Importing..."
                >
                  Import clients from the sheet
                </ActionButton>
                <ActionButton
                  action={retryMirrorsAction}
                  variant="secondary"
                  pendingLabel="Retrying..."
                >
                  Retry pending mirrors
                </ActionButton>
              </div>
            ) : null}

            {unmatched.length > 0 ? (
              <div className="mt-4">
                <Notice tone="warn" title="Sales executives the import could not match">
                  <ul className="mt-1 list-inside list-disc">
                    {unmatched.map((row) => (
                      <li key={row.name}>
                        <span className="font-medium">{row.name}</span> &mdash;{" "}
                        {row.clients} client{row.clients === 1 ? "" : "s"} left
                        unassigned
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2">
                    These are spelled differently in the sheet from the CRM, or
                    the account does not exist yet. Create the salesman, or set
                    their sheet alias on the People page, then import again.
                    Matching is never guessed.
                  </p>
                </Notice>
              </div>
            ) : null}
          </>
        )}

        <div className="mt-4 border-t pt-3">
          <p className="text-sm leading-relaxed text-[var(--text-faint)]">
            The database is the source of truth and Google is a mirror. A
            quotation is saved before any of this runs, so an outage can never
            lose one; a failed push is recorded on the quotation with the
            reason and retried. Point a cron at{" "}
            <span className="font-mono">POST /api/cron/mirror</span> to sweep up
            anything the background runs missed.
          </p>
        </div>
      </Card>

      <Card className="mt-4">
        <CardHeader
          title="Manual entry"
          hint="The third source. A salesman types a client in and keeps it; an admin types one into the pool."
        />
        <p className="text-base text-[var(--text-muted)]">
          All three sources go through the same door, so a person who arrives
          once through IndiaMART and once through a Meta form is stored once.
          Phone numbers are matched as digits only and emails lowercased, and
          both columns carry a unique index, so even two simultaneous webhook
          deliveries cannot create a second row.
        </p>
      </Card>

      {can(user.role, "audit.view") ? (
        <Card className="mt-4">
          <CardHeader
            title="Audit trail"
            hint="Account deletions and bulk transfers of work, newest first."
          />
          {audit.length === 0 ? (
            <p className="py-6 text-center text-base text-[var(--text-faint)]">
              Nothing recorded yet.
            </p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Action</Th>
                  <Th>What happened</Th>
                </tr>
              </thead>
              <tbody>
                {audit.map((row) => (
                  <tr key={row.id}>
                    <Td className="whitespace-nowrap text-sm">
                      {formatDateTime(row.createdAt)}
                    </Td>
                    <Td>
                      <Badge>{row.action}</Badge>
                    </Td>
                    <Td className="text-[var(--text-muted)]">{row.detail}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      ) : null}
    </>
  );
}
