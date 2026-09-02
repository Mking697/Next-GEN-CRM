import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { formatDate, formatDateTime } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { getLetterhead } from "@/server/letterhead";
import { getOrganisation } from "@/server/organisation";
import { formatQtyMilli, type GridRow } from "@/lib/quotation-math";
import { getQuotation, listItemSuggestions } from "@/server/quotations";
import { listCresFor } from "@/server/orders";
import { listRevisions } from "@/server/quotation-revisions";
import {
  deleteQuotationAction,
  handOverQuotationAction,
  placeOrderAction,
  saveQuotationAction,
  setQuotationStatusAction,
} from "@/actions/quotations";
import { ActionButton, ActionForm } from "@/components/form";
import { Field, FieldRow, Input, Select, Textarea } from "@/components/fields";
import { QuoteGrid } from "@/components/quote-grid";
import { QuotationBadge } from "@/components/badges";
import {
  Badge,
  Card,
  CardHeader,
  LinkButton,
  Notice,
  PageHeader,
} from "@/components/ui";

export const metadata: Metadata = { title: "Quotation" };

export default async function QuotationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser(`/quotations/${id}`);

  const quotation = await getQuotation(user, id);
  const { company, bank, logo, isBlank } = await getLetterhead(user.orgId);
  const { defaultUom } = await getOrganisation(user);
  if (!quotation) notFound();

  const [revisions, suggestions] = await Promise.all([
    listRevisions(quotation.id),
    listItemSuggestions(),
  ]);
  const editable = quotation.canEdit;

  // Only CREs who work for the salesman this quotation is credited to can
  // take it on, which is the same rule the data layer enforces.
  const eligibleCres =
    can(user.role, "quotation.handover") && quotation.salesmanId
      ? await listCresFor(quotation.salesmanId)
      : [];

  const rows: GridRow[] = quotation.items.map((item, index) => ({
    key: item.id || `r${index}`,
    particular: item.particular,
    panelThickness: item.panelThickness,
    specs: item.specs,
    sheetThickness: item.sheetThickness,
    description: item.description,
    uom: item.uom,
    qty: item.qtyMilli ? formatQtyMilli(item.qtyMilli) : "",
    qtyFormula: item.qtyFormula,
    rate: item.ratePaise ? (item.ratePaise / 100).toFixed(2) : "",
  }));

  return (
    <>
      <PageHeader
        title={quotation.quoteNo}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span>{quotation.partyName}</span>
            <QuotationBadge status={quotation.status} />
            <span className="text-[var(--text-faint)]">
              built by {quotation.creName}
            </span>
            {revisions[0]?.actorEmail ? (
              <span className="text-[var(--text-faint)]">
                &middot; last edited by {revisions[0].actorEmail}
              </span>
            ) : null}
          </span>
        }
        action={
          <div className="flex flex-wrap gap-2">
            <LinkButton href="/quotations">Back</LinkButton>
            {quotation.leadId ? (
              <LinkButton href={`/leads/${quotation.leadId}`}>Lead</LinkButton>
            ) : null}
            {can(user.role, "quotation.pdf") ? (
              <a
                href={`/api/quotations/${quotation.id}/pdf`}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-base font-medium text-white hover:bg-[var(--accent-hover)]"
              >
                Download PDF
              </a>
            ) : null}
          </div>
        }
      />

      {!editable ? (
        <div className="mb-4">
          <Notice tone="warn" title="Read only">
            You can read this quotation but not change it.
          </Notice>
        </div>
      ) : quotation.hasOrder ? (
        <div className="mb-4">
          <Notice tone="warn" title="This quotation already has an order">
            Order{" "}
            <Link
              href={`/orders/${quotation.orderId}`}
              className="text-[var(--accent-text)] hover:underline"
            >
              {quotation.orderNo}
            </Link>{" "}
            was placed from it. You can still edit it - the reference number
            stays {quotation.quoteNo} and the order value follows whatever you
            save. The version you are replacing is kept in the rework history
            below and can be opened at any time. A value below what has already
            been received will be refused.
          </Notice>
        </div>
      ) : null}

      <ActionForm
        action={saveQuotationAction}
        submitLabel={editable ? "Save quotation" : "Read only"}
        pendingLabel="Saving..."
        hidden={{ quotationId: quotation.id }}
        className="space-y-4"
        footer={
          <span className="text-sm text-[var(--text-faint)]">
            Totals are recomputed on the server from the same rows, so what you
            see here is what gets stored.
          </span>
        }
      >
        {/* -- letterhead ------------------------------------------------- */}
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
            <div className="flex items-start gap-3">
              {logo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={logo}
                  alt=""
                  className="h-10 w-auto max-w-[7rem] object-contain"
                />
              ) : null}
              <div>
                <h2 className="text-md font-semibold tracking-tight">
                  {company.name}
                </h2>
                <p className="mt-0.5 max-w-xl text-xs text-[var(--text-muted)]">
                  {company.address ?? "No address set - add one in Settings"}
                </p>
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  Sales person: {quotation.salesmanName ?? "-"} &middot; CRE:{" "}
                  {quotation.creName}
                  {quotation.creMobile ? ` · ${quotation.creMobile}` : ""}
                  {quotation.creEmail ? ` · ${quotation.creEmail}` : ""}
                </p>
              </div>
            </div>
            <div className="text-right">
              <div className="text-xl font-semibold tracking-tight">
                Quotation
              </div>
              <div className="text-sm text-[var(--text-muted)]">
                {quotation.quoteNo}
              </div>
              <div className="text-sm text-[var(--text-muted)]">
                {formatDate(quotation.createdAt)}
              </div>
              {quotation.validUntil ? (
                <div className="text-xs text-[var(--text-faint)]">
                  valid to {formatDate(quotation.validUntil)}
                </div>
              ) : null}
            </div>
          </div>

          {/* -- party ---------------------------------------------------- */}
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-xs font-medium tracking-wide text-[var(--text-faint)] uppercase">
                To
              </h3>
              <div className="space-y-3">
                <Field label="Party name" required>
                  <Input
                    name="partyName"
                    defaultValue={quotation.partyName}
                    readOnly={!editable}
                    required
                  />
                </Field>
                <FieldRow>
                  <Field label="Kind attention">
                    <Input
                      name="contactPerson"
                      defaultValue={quotation.contactPerson ?? ""}
                      readOnly={!editable}
                    />
                  </Field>
                  <Field label="GST">
                    <Input
                      name="customerGst"
                      defaultValue={quotation.customerGst ?? ""}
                      readOnly={!editable}
                    />
                  </Field>
                </FieldRow>
                <FieldRow>
                  <Field label="Mobile">
                    <Input
                      name="customerMobile"
                      defaultValue={quotation.customerMobile ?? ""}
                      readOnly={!editable}
                    />
                  </Field>
                  <Field label="Email">
                    <Input
                      name="customerEmail"
                      type="email"
                      defaultValue={quotation.customerEmail ?? ""}
                      readOnly={!editable}
                    />
                  </Field>
                </FieldRow>
                <Field label="Billing address">
                  <Input
                    name="billingStreet"
                    defaultValue={quotation.billing.street ?? ""}
                    readOnly={!editable}
                    placeholder="Street"
                  />
                </Field>
                <FieldRow cols={3}>
                  <Field label="City">
                    <Input
                      name="billingCity"
                      defaultValue={quotation.billing.city ?? ""}
                      readOnly={!editable}
                    />
                  </Field>
                  <Field label="State">
                    <Input
                      name="billingState"
                      defaultValue={quotation.billing.state ?? ""}
                      readOnly={!editable}
                    />
                  </Field>
                  <Field label="PIN">
                    <Input
                      name="billingPincode"
                      defaultValue={quotation.billing.pincode ?? ""}
                      readOnly={!editable}
                    />
                  </Field>
                </FieldRow>
                <input
                  type="hidden"
                  name="billingCountry"
                  value={quotation.billing.country ?? "India"}
                />
              </div>
            </div>

            <div>
              <h3 className="mb-2 text-xs font-medium tracking-wide text-[var(--text-faint)] uppercase">
                Delivery address
              </h3>
              <div className="space-y-3">
                <FieldRow>
                  <Field label="Party at delivery">
                    <Input
                      name="shippingPartyName"
                      defaultValue={quotation.shipping.partyName ?? ""}
                      readOnly={!editable}
                    />
                  </Field>
                  <Field label="Contact there">
                    <Input
                      name="shippingContactPerson"
                      defaultValue={quotation.shipping.contactPerson ?? ""}
                      readOnly={!editable}
                    />
                  </Field>
                </FieldRow>
                <Field label="Street address">
                  <Input
                    name="shippingStreet"
                    defaultValue={quotation.shipping.street ?? ""}
                    readOnly={!editable}
                  />
                </Field>
                <FieldRow cols={3}>
                  <Field label="City">
                    <Input
                      name="shippingCity"
                      defaultValue={quotation.shipping.city ?? ""}
                      readOnly={!editable}
                    />
                  </Field>
                  <Field label="State">
                    <Input
                      name="shippingState"
                      defaultValue={quotation.shipping.state ?? ""}
                      readOnly={!editable}
                    />
                  </Field>
                  <Field label="PIN">
                    <Input
                      name="shippingPincode"
                      defaultValue={quotation.shipping.pincode ?? ""}
                      readOnly={!editable}
                    />
                  </Field>
                </FieldRow>
                <input
                  type="hidden"
                  name="shippingCountry"
                  value={quotation.shipping.country ?? "India"}
                />
              </div>
            </div>
          </div>
        </Card>

        {/* -- subject ---------------------------------------------------- */}
        <Card>
          <Field label="Subject">
            <Textarea
              name="subject"
              defaultValue={quotation.subject}
              readOnly={!editable}
              rows={2}
            />
          </Field>
        </Card>

        {/* -- the grid --------------------------------------------------- */}
        <Card>
          <CardHeader
            title="Line items"
            hint="Type every cell yourself. Amount is quantity times rate and is never typed."
          />
          <QuoteGrid
            initialRows={rows}
            initialFreight={
              quotation.totals.freightPaise
                ? (quotation.totals.freightPaise / 100).toFixed(2)
                : ""
            }
            initialGstPercent={quotation.totals.gstPercent}
            suggestions={suggestions}
            readOnly={!editable}
            defaultUom={defaultUom ?? ""}
          />
        </Card>

        {/* -- note and terms --------------------------------------------- */}
        <Card>
          <Field label="Note">
            <Textarea
              name="note"
              defaultValue={quotation.note}
              readOnly={!editable}
              rows={2}
            />
          </Field>
          <div className="mt-3">
            <Field label="Terms and conditions">
              <Textarea
                name="terms"
                defaultValue={quotation.terms}
                readOnly={!editable}
                rows={10}
                className="font-mono text-sm leading-relaxed"
              />
            </Field>
          </div>
        </Card>
      </ActionForm>

      {/* -- bank ---------------------------------------------------------- */}
      <Card className="mt-4">
        <CardHeader
          title={
            bank.beneficiary
              ? `Beneficiary: ${bank.beneficiary}`
              : "Bank details not set"
          }
        />
        <dl className="grid gap-x-6 gap-y-1 text-base sm:grid-cols-2">
          <Bank label="Bank" value={bank.name ?? "-"} />
          <Bank label="Account no." value={bank.account ?? "-"} />
          <Bank label="IFSC" value={bank.ifsc ?? "-"} />
          <Bank label="Account type" value={bank.accountType ?? "-"} />
          <Bank label="Branch" value={bank.branch ?? "-"} />
        </dl>
      </Card>

      {/* -- actions ------------------------------------------------------- */}
      <Card className="mt-4">
        <CardHeader
          title="What next"
          hint={
            quotation.orderId
              ? "This quotation has become an order."
              : "Send it to the customer, then place the order once they accept."
          }
        />

        <div className="flex flex-wrap items-start gap-3">
          {editable && quotation.status === "DRAFT" ? (
            <ActionButton
              action={setQuotationStatusAction}
              variant="secondary"
              pendingLabel="Marking..."
              hidden={{ quotationId: quotation.id, status: "SENT" }}
            >
              Mark as sent
            </ActionButton>
          ) : null}

          {editable && quotation.status === "SENT" ? (
            <ActionButton
              action={setQuotationStatusAction}
              variant="ghost"
              pendingLabel="Reverting..."
              hidden={{ quotationId: quotation.id, status: "DRAFT" }}
            >
              Back to draft
            </ActionButton>
          ) : null}

          {quotation.canPlaceOrder && can(user.role, "order.confirm") ? (
            <ActionButton
              action={placeOrderAction}
              variant="primary"
              pendingLabel="Placing..."
              hidden={{ quotationId: quotation.id }}
              confirm={`Place an order for ${formatPaise(quotation.totals.payablePaise)}? The quotation stays editable afterwards, and the order value will follow whatever you save.`}
            >
              Place order &middot; {formatPaise(quotation.totals.payablePaise)}
            </ActionButton>
          ) : null}

          {editable && quotation.status !== "REJECTED" ? (
            <ActionButton
              action={setQuotationStatusAction}
              variant="ghost"
              pendingLabel="Marking..."
              hidden={{ quotationId: quotation.id, status: "REJECTED" }}
            >
              Customer rejected it
            </ActionButton>
          ) : null}

          {can(user.role, "quotation.delete") && !quotation.orderId ? (
            <ActionButton
              action={deleteQuotationAction}
              variant="danger"
              pendingLabel="Deleting..."
              hidden={{ quotationId: quotation.id }}
              confirm="Delete this quotation? This cannot be undone."
            >
              Delete
            </ActionButton>
          ) : null}
        </div>

        {eligibleCres.length > 0 ? (
          <div className="mt-4 border-t pt-3">
            <ActionForm
              action={handOverQuotationAction}
              submitLabel="Hand over"
              submitVariant="secondary"
              pendingLabel="Handing over..."
              hidden={{
                quotationId: quotation.id,
                leadId: quotation.leadId ?? "",
              }}
              className="flex flex-wrap items-end gap-2 space-y-0"
            >
              <Field
                label="Hand this job to a CRE"
                hint={
                  quotation.orderId
                    ? `${quotation.orderNo} and the lead move across with it. You keep seeing all of it.`
                    : "The quotation and the lead behind it move across. You keep seeing both."
                }
              >
                <Select name="creId" defaultValue="" className="w-48">
                  <option value="">Choose a CRE...</option>
                  {eligibleCres.map((cre) => (
                    <option key={cre.id} value={cre.id}>
                      {cre.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </ActionForm>
          </div>
        ) : null}
      </Card>

      <History revisions={revisions} quotationId={quotation.id} />
    </>
  );
}

function History({
  revisions,
  quotationId,
}: {
  revisions: Awaited<ReturnType<typeof listRevisions>>;
  quotationId: string;
}) {
  const reworks = Math.max(0, revisions.length - 1);

  return (
    <Card className="mt-4">
      <CardHeader
        title="Rework history"
        hint={
          reworks === 0
            ? "Every save is recorded here, with exactly what moved since the one before."
            : `Reworked ${reworks} time${reworks === 1 ? "" : "s"}. Each entry lists what changed against the save before it.`
        }
      />

      {revisions.length === 0 ? (
        <p className="py-4 text-center text-base text-[var(--text-faint)]">
          Nothing saved yet. The first save becomes revision 1.
        </p>
      ) : (
        <ol className="space-y-3">
          {revisions.map((revision) => (
            <li key={revision.id} className="rounded-lg border">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-[var(--bg-sunken)] px-3 py-2">
                <span className="flex items-center gap-2">
                  <Badge tone={revision.revision === 1 ? "neutral" : "accent"}>
                    {revision.revision === 1
                      ? "Original"
                      : `Rework ${revision.revision - 1}`}
                  </Badge>
                  <span className="text-sm text-[var(--text-muted)]">
                    {revision.actorEmail ?? revision.actorName ?? "Somebody"}{" "}
                    &middot; {formatDateTime(revision.createdAt)}
                  </span>
                </span>
                <span className="flex items-center gap-2.5">
                  <span className="tnum text-sm">
                    {revision.itemCount} line
                    {revision.itemCount === 1 ? "" : "s"} &middot;{" "}
                    <span className="font-medium">
                      {formatPaise(revision.payablePaise)}
                    </span>
                  </span>
                  <LinkButton
                    href={`/quotations/${quotationId}/revisions/${revision.revision}`}
                    variant="ghost"
                  >
                    Open
                  </LinkButton>
                </span>
              </div>

              {revision.changes.length === 0 ? (
                <p className="px-3 py-2 text-sm text-[var(--text-faint)]">
                  The quotation as it was first saved.
                </p>
              ) : (
                <ul className="space-y-1 px-3 py-2">
                  {revision.changes.map((change, index) => (
                    <li
                      key={index}
                      className="flex gap-2 text-sm text-[var(--text-muted)]"
                    >
                      <span
                        aria-hidden
                        className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[var(--border-strong)]"
                      />
                      <span>{change}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}

      <p className="mt-3 border-t pt-3 text-xs leading-relaxed text-[var(--text-faint)]">
        Saving without changing anything does not create a revision, so this
        list only ever shows reworks that really happened.
      </p>
    </Card>
  );
}

function Bank({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 text-[var(--text-faint)]">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
