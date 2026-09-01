import type { Metadata } from "next";
import { requirePageAccess } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { formatDateTime, relativeTime } from "@/lib/dates";
import { getIndiamartStatus } from "@/server/ingest/indiamart";
import { getMetaStatus } from "@/server/ingest/meta";
import { listAudit } from "@/server/audit";
import { runIndiamartSyncAction } from "@/actions/users";
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

  const [indiamart, audit] = await Promise.all([
    getIndiamartStatus(),
    can(user.role, "audit.view") ? listAudit(40) : Promise.resolve([]),
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
