import type { Metadata } from "next";
import { requirePageAccess } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { formatDate } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { getOrganisation } from "@/server/organisation";
import { getBillingStatus } from "@/server/billing";
import {
  removeLogoAction,
  updateWorkspaceAction,
  uploadLogoAction,
} from "@/actions/workspace";
import { ActionButton, ActionForm } from "@/components/form";
import { Field, FieldRow, Input, Textarea } from "@/components/fields";
import { RenewButton } from "@/components/billing/renew-button";
import {
  Badge,
  Card,
  CardHeader,
  Notice,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui";

export const metadata: Metadata = { title: "Your company" };

/**
 * What a customer reads at the top of every quotation, and the account they
 * pay into.
 *
 * This used to be seven environment variables, which could only describe one
 * company. Now each workspace fills in its own, and nothing here is compiled
 * in - a field left blank prints as blank rather than as somebody else's
 * details or as a placeholder that looks like a value.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ welcome?: string }>;
}) {
  const user = await requirePageAccess("workspace.view", "/settings");
  const org = await getOrganisation(user);
  const { welcome } = await searchParams;
  const editable = can(user.role, "workspace.edit");
  const showBilling = can(user.role, "workspace.billing");
  const billing = showBilling ? await getBillingStatus(user) : null;

  const missing = [
    !org.address && "address",
    !org.gstin && "GSTIN",
    !org.bankAccount && "bank account",
    !org.hasLogo && "logo",
    !org.quotationTerms && "terms and conditions",
  ].filter(Boolean) as string[];

  return (
    <>
      <PageHeader
        title="Your company"
        subtitle={`This is what prints on every quotation ${org.name} sends. Workspace address: ${org.slug}`}
      />

      {welcome ? (
        <div className="mb-4">
          <Notice tone="ok" title={`Welcome. ${org.name} is set up.`}>
            Fill this page in before you send your first quotation - the
            letterhead and the bank details come straight from here. You can
            add your team from the People page.
          </Notice>
        </div>
      ) : null}

      {missing.length > 0 && !welcome ? (
        <div className="mb-4">
          <Notice tone="warn" title="Your quotations are missing something">
            No {missing.join(", no ")} yet. A quotation still sends without
            them, but the customer sees the gap.
          </Notice>
        </div>
      ) : null}

      {!editable ? (
        <div className="mb-4">
          <Notice tone="neutral" title="Read only">
            Only an owner or an admin can change these.
          </Notice>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* -- the letterhead ------------------------------------------- */}
        <Card>
          <CardHeader
            title="Letterhead"
            hint="Printed at the top of the quotation and its PDF."
          />
          <ActionForm
            action={updateWorkspaceAction}
            submitLabel="Save"
            pendingLabel="Saving..."
          >
            <Field label="Company name" required>
              <Input name="name" defaultValue={org.name} required maxLength={120} />
            </Field>
            <Field
              label="Legal name"
              hint="If it differs from the name above, this is what prints."
            >
              <Input
                name="legalName"
                defaultValue={org.legalName ?? ""}
                maxLength={160}
                placeholder="Hicon Panels Private Limited"
              />
            </Field>
            <Field label="Address">
              <Textarea
                name="address"
                defaultValue={org.address ?? ""}
                rows={3}
                maxLength={400}
                placeholder="Plot 12, Industrial Area, Greater Noida 201306, Uttar Pradesh"
              />
            </Field>
            <FieldRow>
              <Field label="GSTIN">
                <Input
                  name="gstin"
                  defaultValue={org.gstin ?? ""}
                  maxLength={20}
                  placeholder="09AAACH7409R1ZZ"
                />
              </Field>
              <Field label="Phone">
                <Input name="phone" defaultValue={org.phone ?? ""} maxLength={40} />
              </Field>
            </FieldRow>
            <FieldRow>
              <Field label="Email">
                <Input
                  name="email"
                  type="email"
                  defaultValue={org.email ?? ""}
                  maxLength={254}
                />
              </Field>
              <Field label="Website">
                <Input name="website" defaultValue={org.website ?? ""} maxLength={200} />
              </Field>
            </FieldRow>
          </ActionForm>
        </Card>

        <div className="flex flex-col gap-4">
          {/* -- logo ---------------------------------------------------- */}
          <Card>
            <CardHeader
              title="Logo"
              hint="Stored here, not linked - so a quotation sent today still renders in a year."
            />
            <div className="mb-4 flex items-center gap-4">
              <div className="flex h-16 w-32 items-center justify-center rounded-lg border bg-[var(--bg-sunken)]">
                {org.hasLogo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src="/api/workspace/logo"
                    alt="Your logo"
                    className="max-h-14 max-w-28 object-contain"
                  />
                ) : (
                  <span className="text-xs text-[var(--text-faint)]">none yet</span>
                )}
              </div>
              {org.hasLogo && editable ? (
                <ActionButton
                  action={removeLogoAction}
                  variant="secondary"
                  pendingLabel="Removing..."
                >
                  Remove
                </ActionButton>
              ) : null}
            </div>
            {editable ? (
              <ActionForm
                action={uploadLogoAction}
                submitLabel={org.hasLogo ? "Replace logo" : "Upload logo"}
                pendingLabel="Uploading..."
              >
                <Field
                  label="Image"
                  hint="PNG, JPEG or GIF, under 512KB. It prints about 3cm wide."
                >
                  <input
                    type="file"
                    name="logo"
                    accept="image/png,image/jpeg,image/gif"
                    className="w-full rounded-lg border bg-[var(--bg-raised)] px-3 py-2 text-base file:mr-3 file:rounded-md file:border-0 file:bg-[var(--bg-sunken)] file:px-3 file:py-1 file:text-base"
                  />
                </Field>
              </ActionForm>
            ) : null}
          </Card>

          {/* -- bank ---------------------------------------------------- */}
          <Card>
            <CardHeader
              title="Bank details"
              hint="Where your customers pay. Checked before saving, because a wrong IFSC does not fail loudly."
            />
            <ActionForm
              action={updateWorkspaceAction}
              submitLabel="Save"
              pendingLabel="Saving..."
            >
              <Field label="Beneficiary">
                <Input
                  name="bankBeneficiary"
                  defaultValue={org.bankBeneficiary ?? ""}
                  maxLength={160}
                />
              </Field>
              <FieldRow>
                <Field label="Bank">
                  <Input
                    name="bankName"
                    defaultValue={org.bankName ?? ""}
                    maxLength={120}
                    placeholder="HDFC Bank"
                  />
                </Field>
                <Field label="Branch">
                  <Input
                    name="bankBranch"
                    defaultValue={org.bankBranch ?? ""}
                    maxLength={120}
                  />
                </Field>
              </FieldRow>
              <FieldRow>
                <Field label="Account number">
                  <Input
                    name="bankAccount"
                    defaultValue={org.bankAccount ?? ""}
                    maxLength={30}
                  />
                </Field>
                <Field label="IFSC">
                  <Input
                    name="bankIfsc"
                    defaultValue={org.bankIfsc ?? ""}
                    maxLength={11}
                    placeholder="HDFC0001234"
                  />
                </Field>
              </FieldRow>
              <Field label="Account type">
                <Input
                  name="bankAccountType"
                  defaultValue={org.bankAccountType ?? ""}
                  maxLength={40}
                  placeholder="Current Account"
                />
              </Field>
            </ActionForm>
          </Card>
        </div>
      </div>

      {/* -- what a new quotation starts out saying ------------------- */}
      <Card className="mt-4">
        <CardHeader
          title="Quotation defaults"
          hint="Copied onto every new quotation. The person building one can change any of it before sending - and changing it here never touches a quotation that already exists."
        />
        <ActionForm
          action={updateWorkspaceAction}
          submitLabel="Save defaults"
          pendingLabel="Saving..."
        >
          <Field
            label="Default unit of measure"
            hint={
              <>
                What your business quotes by - SQM for panels, LTR for
                liquids, KG, NOS, whatever fits. Every new quotation line
                opens with this (a CRE can still type any unit on any line),
                and it is the unit the Overview page's monthly quantity tile
                adds up. Leave blank to turn that tile off - not every
                business has one dominant unit worth totalling.
              </>
            }
          >
            <Input
              name="defaultUom"
              defaultValue={org.defaultUom ?? ""}
              maxLength={20}
              placeholder="SQM"
              className="max-w-40 uppercase"
            />
          </Field>
          <Field
            label="Subject"
            hint="The line under the customer's address, saying what the quotation is for."
          >
            <Input
              name="quotationSubject"
              defaultValue={org.quotationSubject ?? ""}
              maxLength={500}
              placeholder="Supply as per the specifications below:"
            />
          </Field>
          <Field label="Note" hint="A short paragraph above the terms.">
            <Textarea
              name="quotationNote"
              defaultValue={org.quotationNote ?? ""}
              rows={2}
              maxLength={2000}
            />
          </Field>
          <Field
            label="Terms and conditions"
            hint="One per line. Delivery, payment, transport, validity, jurisdiction - whatever your company quotes on."
          >
            <Textarea
              name="quotationTerms"
              defaultValue={org.quotationTerms ?? ""}
              rows={12}
              maxLength={8000}
              className="font-mono text-sm"
            />
          </Field>
        </ActionForm>
      </Card>

      {/* -- billing --------------------------------------------------- */}
      {billing ? (
        <Card className="mt-4">
          <CardHeader
            title="Billing"
            hint="One flat plan, no tiers. Renewing before the current date runs out stacks the extra 30 days on top instead of resetting the clock."
          />

          {billing.enabled ? (
            <>
              <div className="mb-4 flex flex-wrap items-center gap-x-8 gap-y-3 text-base">
                <div>
                  <div className="text-xs text-[var(--text-faint)]">Subscription</div>
                  <div
                    className={
                      billing.expired
                        ? "font-medium text-[var(--danger)]"
                        : "font-medium"
                    }
                  >
                    {billing.subscriptionUntil
                      ? formatDate(billing.subscriptionUntil)
                      : "No expiry set"}
                    {billing.expired ? (
                      <Badge tone="danger" className="ml-2">
                        expired
                      </Badge>
                    ) : null}
                  </div>
                </div>
              </div>

              <RenewButton />

              {billing.recentPayments.length > 0 ? (
                <div className="mt-6">
                  <div className="mb-2 text-xs font-medium text-[var(--text-faint)]">
                    Recent payments
                  </div>
                  <Table minWidth="32rem">
                    <thead>
                      <tr>
                        <Th>Date</Th>
                        <Th>Amount</Th>
                        <Th>Status</Th>
                        <Th>New expiry</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {billing.recentPayments.map((payment) => (
                        <tr key={payment.id}>
                          <Td className="text-sm text-[var(--text-muted)]">
                            {formatDate(payment.createdAt)}
                          </Td>
                          <Td numeric>
                            {payment.amountPaise !== null
                              ? formatPaise(payment.amountPaise)
                              : "-"}
                          </Td>
                          <Td>
                            <Badge
                              tone={
                                payment.status === "CAPTURED"
                                  ? "ok"
                                  : payment.status === "FAILED"
                                    ? "danger"
                                    : "neutral"
                              }
                            >
                              {payment.status.toLowerCase()}
                            </Badge>
                          </Td>
                          <Td className="text-sm text-[var(--text-muted)]">
                            {payment.subscriptionUntilAfter
                              ? formatDate(payment.subscriptionUntilAfter)
                              : "-"}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              ) : null}
            </>
          ) : (
            <Notice tone="neutral" title="Billing is not configured yet">
              Renewing here will be available once a platform administrator
              adds Dodo Payments keys. Until then, ask them to extend your
              subscription from the platform console.
              <br />
              <span className="mt-2 block text-xs text-[var(--text-faint)]">
                Webhook URL for the Dodo Payments dashboard:{" "}
                <code className="font-mono">{billing.webhookUrl}</code>
              </span>
            </Notice>
          )}
        </Card>
      ) : null}
    </>
  );
}
