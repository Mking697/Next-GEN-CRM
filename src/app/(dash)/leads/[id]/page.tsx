import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { formatDate, formatDateTime, toDateInputValue } from "@/lib/dates";
import { formatPhone } from "@/lib/dedupe";
import { formatPaise } from "@/lib/money";
import { getLead } from "@/server/leads";
import { listCresFor } from "@/server/orders";
import {
  addLeadNoteAction,
  grabLeadAction,
  handLeadToCreAction,
  setLeadStatusAction,
  updateLeadAction,
} from "@/actions/leads";
import { confirmOrderAction } from "@/actions/orders";
import type { QuotationStatus } from "@/generated/prisma/enums";
import { ActionButton, ActionForm } from "@/components/form";
import {
  Field,
  FieldRow,
  Input,
  RupeeInput,
  Select,
  Textarea,
} from "@/components/fields";
import { QuotationBadge, SourceBadge, StatusBadge } from "@/components/badges";
import {
  Card,
  CardHeader,
  DefinitionRow,
  LinkButton,
  Notice,
  PageHeader,
} from "@/components/ui";

export const metadata: Metadata = { title: "Lead" };

export default async function LeadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser(`/leads/${id}`);

  const lead = await getLead(user, id);
  if (!lead) notFound();

  const inPool = lead.ownerId === null;
  // Only the CREs reporting to the lead owner may be handed this lead.
  const eligibleCres =
    lead.ownerId && can(user.role, "lead.handover.cre") && !lead.order
      ? await listCresFor(lead.ownerId)
      : [];

  const canConfirm =
    lead.canEdit && can(user.role, "order.confirm") && !lead.order && lead.status !== "LOST";

  return (
    <>
      <PageHeader
        title={lead.personName}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <SourceBadge source={lead.source} />
            <StatusBadge status={lead.status} />
            {inPool ? (
              <span className="text-[var(--warn)]">Sitting in the pool</span>
            ) : (
              <span>Owned by {lead.ownerName}</span>
            )}
          </span>
        }
        action={
          <div className="flex gap-2">
            <LinkButton href={inPool ? "/pool" : "/leads"}>Back</LinkButton>
            {lead.canGrab ? (
              <ActionButton
                action={grabLeadAction}
                variant="primary"
                pendingLabel="Grabbing..."
                hidden={{ leadId: lead.id }}
              >
                Grab this lead
              </ActionButton>
            ) : null}
          </div>
        }
      />

      {inPool && !lead.canGrab ? (
        <div className="mb-4">
          <Notice tone="warn" title="This lead has no owner yet">
            It is read-only until a salesman grabs it or an admin assigns it.
          </Notice>
        </div>
      ) : null}

      {lead.order ? (
        <div className="mb-4">
          <Notice tone="ok" title={`Confirmed as order ${lead.order.orderNo}`}>
            {formatPaise(lead.order.amountPaise)}
            {lead.order.creName ? ` - with ${lead.order.creName}` : " - not handed to a CRE yet"}.{" "}
            <Link
              href={`/orders/${lead.order.id}`}
              className="text-[var(--accent-text)] hover:underline"
            >
              Open the order
            </Link>
          </Notice>
        </div>
      ) : null}

      {lead.creId && !lead.order ? (
        <div className="mb-4">
          <Notice tone="accent" title={`With ${lead.creName}`}>
            {user.role === "CRE" && lead.creId === user.id
              ? "This lead was handed to you. Build the quotation, and place the order once the customer accepts."
              : `${lead.creName} is quoting this lead. You keep watching it right through to payment.`}
          </Notice>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {lead.canEdit ? (
            <Card>
              <CardHeader
                title="Details"
                hint="Fill in whatever the source did not send."
              />
              <ActionForm
                action={updateLeadAction}
                submitLabel="Save"
                pendingLabel="Saving..."
                hidden={{ leadId: lead.id }}
              >
                <Field label="Name" required>
                  <Input name="personName" defaultValue={lead.personName} required />
                </Field>
                <FieldRow>
                  <Field label="Phone">
                    <Input name="phone" defaultValue={lead.phone ?? ""} type="tel" />
                  </Field>
                  <Field label="Email">
                    <Input name="email" defaultValue={lead.email ?? ""} type="email" />
                  </Field>
                </FieldRow>
                <FieldRow>
                  <Field label="Company">
                    <Input name="companyName" defaultValue={lead.companyName ?? ""} />
                  </Field>
                  <Field label="Product">
                    <Input name="product" defaultValue={lead.product ?? ""} />
                  </Field>
                </FieldRow>
                <FieldRow cols={3}>
                  <Field label="City">
                    <Input name="city" defaultValue={lead.city ?? ""} />
                  </Field>
                  <Field label="State">
                    <Input name="state" defaultValue={lead.state ?? ""} />
                  </Field>
                  <Field label="Next follow-up">
                    <Input
                      name="nextFollowUpAt"
                      type="date"
                      defaultValue={
                        lead.nextFollowUpAt
                          ? toDateInputValue(lead.nextFollowUpAt)
                          : ""
                      }
                    />
                  </Field>
                </FieldRow>
              </ActionForm>
            </Card>
          ) : (
            <Card>
              <CardHeader title="Details" />
              <dl>
                <DefinitionRow label="Phone">{formatPhone(lead.phone)}</DefinitionRow>
                <DefinitionRow label="Email">{lead.email ?? "-"}</DefinitionRow>
                <DefinitionRow label="Company">
                  {lead.companyName ?? "-"}
                </DefinitionRow>
                <DefinitionRow label="Product">{lead.product ?? "-"}</DefinitionRow>
                <DefinitionRow label="City">
                  {[lead.city, lead.state].filter(Boolean).join(", ") || "-"}
                </DefinitionRow>
                <DefinitionRow label="Arrived">
                  {formatDateTime(lead.receivedAt)}
                </DefinitionRow>
              </dl>
            </Card>
          )}

          {/* -- quotations ------------------------------------------------ */}
          {lead.quotations.length > 0 || lead.canQuote ? (
            <Card>
              <CardHeader
                title="Quotations"
                hint="The order is placed from an accepted quotation, so its value and the quotation can never disagree."
                action={
                  lead.canQuote && !lead.order ? (
                    <LinkButton
                      href={`/quotations/new?leadId=${lead.id}`}
                      variant="primary"
                    >
                      New quotation
                    </LinkButton>
                  ) : null
                }
              />

              {lead.quotations.length === 0 ? (
                <p className="py-4 text-center text-base text-[var(--text-faint)]">
                  Nothing quoted yet.
                </p>
              ) : (
                <ul className="space-y-2">
                  {lead.quotations.map((quotation) => (
                    <li
                      key={quotation.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2"
                    >
                      <span className="flex items-center gap-2">
                        <Link
                          href={`/quotations/${quotation.id}`}
                          className="font-mono text-sm font-medium hover:text-[var(--accent-text)]"
                        >
                          {quotation.quoteNo}
                        </Link>
                        <QuotationBadge
                          status={quotation.status as QuotationStatus}
                        />
                      </span>
                      <span className="tnum text-base font-medium">
                        {formatPaise(quotation.payablePaise)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ) : null}

          {/* -- direct confirm, an admin fallback only -------------------- */}
          {canConfirm ? (
            <Card>
              <CardHeader
                title="Raise an order without quoting"
                hint="The normal route is a quotation, which a CRE builds and then places the order from. This is here for the cases that never went through one."
              />
              <ActionForm
                action={confirmOrderAction}
                submitLabel="Confirm order"
                submitVariant="secondary"
                pendingLabel="Confirming..."
                hidden={{ leadId: lead.id }}
              >
                <FieldRow>
                  <Field label="Order value" required hint="In rupees.">
                    <RupeeInput name="amount" required />
                  </Field>
                  <Field label="What was sold">
                    <Input
                      name="title"
                      defaultValue={lead.product ?? ""}
                      maxLength={200}
                    />
                  </Field>
                </FieldRow>
                <FieldRow>
                  <Field label="Company name">
                    <Input
                      name="companyName"
                      defaultValue={lead.companyName ?? lead.personName}
                    />
                  </Field>
                  <Field label="GSTIN">
                    <Input name="gstin" maxLength={20} />
                  </Field>
                </FieldRow>
                <Field label="Notes">
                  <Textarea name="notes" rows={2} />
                </Field>
              </ActionForm>
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Timeline" hint="Every change, with who made it." />
            {lead.canEdit ? (
              <div className="mb-4">
                <ActionForm
                  action={addLeadNoteAction}
                  submitLabel="Add note"
                  submitVariant="secondary"
                  pendingLabel="Adding..."
                  hidden={{ leadId: lead.id }}
                  resetOnSuccess
                >
                  <Textarea
                    name="message"
                    rows={2}
                    placeholder="Called, asked for a quote by Friday"
                    required
                  />
                </ActionForm>
              </div>
            ) : null}

            <ol className="space-y-3">
              {lead.activities.map((activity) => (
                <li key={activity.id} className="flex gap-3">
                  <div className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--border-strong)]" />
                  <div className="min-w-0">
                    <p className="text-base">{activity.message}</p>
                    <p className="text-xs text-[var(--text-faint)]">
                      {formatDateTime(activity.createdAt)}
                      {activity.actorName ? ` - ${activity.actorName}` : ""}
                    </p>
                  </div>
                </li>
              ))}
              {lead.activities.length === 0 ? (
                <li className="text-base text-[var(--text-faint)]">
                  Nothing logged yet.
                </li>
              ) : null}
            </ol>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="At a glance" />
            <dl>
              <DefinitionRow label="Phone">{formatPhone(lead.phone)}</DefinitionRow>
              <DefinitionRow label="Email">{lead.email ?? "-"}</DefinitionRow>
              <DefinitionRow label="Arrived">
                {formatDateTime(lead.receivedAt)}
              </DefinitionRow>
              <DefinitionRow label="Grabbed">
                {lead.grabbedAt ? formatDateTime(lead.grabbedAt) : "not yet"}
              </DefinitionRow>
              <DefinitionRow label="Follow-up">
                {lead.nextFollowUpAt ? formatDate(lead.nextFollowUpAt) : "not set"}
              </DefinitionRow>
              {lead.externalId ? (
                <DefinitionRow label="Source id">
                  <span className="font-mono text-xs break-all">
                    {lead.externalId}
                  </span>
                </DefinitionRow>
              ) : null}
            </dl>
          </Card>

          {lead.message ? (
            <Card>
              <CardHeader title="What they asked for" />
              <p className="text-base whitespace-pre-wrap text-[var(--text-muted)]">
                {lead.message}
              </p>
            </Card>
          ) : null}

          {eligibleCres.length > 0 ? (
            <Card>
              <CardHeader
                title={lead.creId ? "Move to another CRE" : "Hand to a CRE"}
                hint="They build the quotation and place the order. You stay the owner, so this still counts as your grab."
              />
              <ActionForm
                action={handLeadToCreAction}
                submitLabel={lead.creId ? "Move" : "Hand over"}
                pendingLabel="Handing over..."
                hidden={{ leadId: lead.id }}
              >
                <Field label="CRE" required>
                  <Select name="creId" defaultValue={lead.creId ?? ""}>
                    <option value="">Choose a CRE...</option>
                    {eligibleCres.map((cre) => (
                      <option key={cre.id} value={cre.id}>
                        {cre.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </ActionForm>
            </Card>
          ) : lead.ownerId && can(user.role, "lead.handover.cre") && !lead.order && !lead.creId ? (
            <Notice tone="warn" title="No CREs assigned to you">
              A lead has to go to a CRE before it can be quoted. Ask an admin to
              assign one to you on the People page.
            </Notice>
          ) : null}

          {lead.canEdit && can(user.role, "lead.status.set") && !lead.order ? (
            <Card>
              <CardHeader title="Status" />
              <ActionForm
                action={setLeadStatusAction}
                submitLabel="Update status"
                submitVariant="secondary"
                pendingLabel="Updating..."
                hidden={{ leadId: lead.id }}
              >
                <Field label="Status" required>
                  <Select name="status" defaultValue={lead.status}>
                    <option value="NEW">New</option>
                    <option value="FOLLOW_UP">Following up</option>
                    <option value="LOST">Lost</option>
                  </Select>
                </Field>
                <Field
                  label="Reason, if lost"
                  hint="Required when the status is Lost."
                >
                  <Input name="lostReason" defaultValue={lead.lostReason ?? ""} />
                </Field>
              </ActionForm>
            </Card>
          ) : null}

          {lead.status === "LOST" && lead.lostReason ? (
            <Notice tone="danger" title="Marked lost">
              {lead.lostReason}
            </Notice>
          ) : null}
        </div>
      </div>
    </>
  );
}
