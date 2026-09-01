import type { Metadata } from "next";
import { requirePageAccess } from "@/lib/auth";
import { createLeadAction } from "@/actions/leads";
import { ActionForm } from "@/components/form";
import { Field, FieldRow, Input, Textarea } from "@/components/fields";
import { Card, LinkButton, Notice, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Add a lead" };

/**
 * Manual lead entry. A name is the only required field, because a real
 * enquiry often arrives as nothing more than a name and a phone number.
 */
export default async function NewLeadPage() {
  const user = await requirePageAccess("lead.create", "/leads/new");
  const keepsIt = user.role === "SALESMAN";

  return (
    <>
      <PageHeader
        title="Add a lead"
        subtitle={
          keepsIt
            ? "For a client you found yourself. This lead is yours straight away, it does not go to the pool."
            : "This lead goes into the shared pool for a salesman to grab."
        }
        action={<LinkButton href="/leads">Back to leads</LinkButton>}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <ActionForm
            action={createLeadAction}
            submitLabel="Add lead"
            pendingLabel="Adding..."
          >
            <Field label="Name" required hint="The only thing this form insists on.">
              <Input name="personName" required autoFocus maxLength={160} />
            </Field>

            <FieldRow>
              <Field label="Phone">
                <Input name="phone" type="tel" inputMode="tel" maxLength={40} />
              </Field>
              <Field label="Email">
                <Input name="email" type="email" maxLength={254} />
              </Field>
            </FieldRow>

            <FieldRow>
              <Field label="Company">
                <Input name="companyName" maxLength={200} />
              </Field>
              <Field label="Product or requirement">
                <Input name="product" maxLength={200} />
              </Field>
            </FieldRow>

            <FieldRow>
              <Field label="City">
                <Input name="city" maxLength={100} />
              </Field>
              <Field label="State">
                <Input name="state" maxLength={100} />
              </Field>
            </FieldRow>

            <Field label="Notes">
              <Textarea name="message" maxLength={2000} rows={3} />
            </Field>
          </ActionForm>
        </Card>

        <div className="space-y-3">
          <Notice title="Duplicates are caught here">
            Leads are deduplicated on phone and email. If either one already
            exists on another lead, this form refuses and tells you who owns
            it, rather than storing the same enquiry twice.
          </Notice>
          <Notice title="What counts as a match">
            Phone numbers are compared as digits only, so +91 98765 43210 and
            09876543210 are the same person. Email is compared lowercased.
          </Notice>
        </div>
      </div>
    </>
  );
}
