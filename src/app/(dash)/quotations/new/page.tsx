import type { Metadata } from "next";
import { requirePageAccess } from "@/lib/auth";
import { listClients } from "@/server/quotations";
import { createQuotationAction } from "@/actions/quotations";
import { ActionForm } from "@/components/form";
import { Field, Input, Select } from "@/components/fields";
import { Card, CardHeader, LinkButton, Notice, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "New quotation" };

/**
 * Two ways in: pick a client out of the book, or type a walk-in party name.
 * Either way the quotation opens as a draft and everything stays editable
 * from there, because the quotation carries its own snapshot of the party.
 */
export default async function NewQuotationPage({
  searchParams,
}: {
  searchParams: Promise<{ leadId?: string }>;
}) {
  const user = await requirePageAccess("quotation.create", "/quotations/new");
  const { leadId } = await searchParams;

  const clients = await listClients(user);

  return (
    <>
      <PageHeader
        title="New quotation"
        subtitle="Pick the client, then fill the grid on the next screen."
        action={<LinkButton href="/quotations">Back to quotations</LinkButton>}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Who is it for?"
            hint="Choose an existing client, or type a name for somebody new."
          />

          <ActionForm
            action={createQuotationAction}
            submitLabel="Start quotation"
            pendingLabel="Starting..."
            hidden={{ leadId: leadId ?? undefined }}
          >
            {clients.length > 0 ? (
              <Field
                label="Existing client"
                hint={`${clients.length} client${clients.length === 1 ? "" : "s"} in your book.`}
              >
                <Select name="companyId" defaultValue="">
                  <option value="">-- none, I will type the name --</option>
                  {clients.map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.name}
                      {client.city ? ` - ${client.city}` : ""}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : (
              <Notice tone="warn" title="Your client book is empty">
                {user.role === "CRE"
                  ? "Clients belong to the salesman you report to. Once an admin runs the client import, or once you place your first order, they will show up here. You can still type a party name below."
                  : "Run the client import from the Lead sources page, or just type a party name below."}
              </Notice>
            )}

            <Field
              label="Or a new party name"
              hint="Used when no client is selected above."
            >
              <Input name="partyName" maxLength={200} placeholder="Company or person" />
            </Field>
          </ActionForm>
        </Card>

        <div className="space-y-3">
          <Notice title="What happens next">
            The quotation opens as a draft with your company header, the standard
            subject, note and terms already filled in. You type the line items on
            a spreadsheet-style grid.
          </Notice>
          <Notice title="Nothing is locked in">
            Party details, addresses and all the document text stay editable
            until an order is placed against the quotation.
          </Notice>
          <Notice title="Numbering">
            Reference numbers continue the REF- series your old system was
            using, so there is no gap and no restart.
          </Notice>
        </div>
      </div>
    </>
  );
}
