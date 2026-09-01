import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePageAccess } from "@/lib/auth";
import { ROLE_LABEL } from "@/lib/permissions";
import { getPerson } from "@/server/users";
import { updateUserAction } from "@/actions/users";
import { ActionForm } from "@/components/form";
import { Field, FieldRow, Input } from "@/components/fields";
import { Badge, Card, CardHeader, LinkButton, Notice, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Edit account" };

/**
 * Editing somebody's details.
 *
 * A page of its own rather than an inline row editor, matching the delete
 * screen: changing an email changes what that person signs in with, and that
 * is not a thing to do by accident inside a dense table.
 */
export default async function EditUserPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requirePageAccess("user.update", `/people/${id}/edit`);

  const person = await getPerson(user, id).catch(() => null);
  if (!person) notFound();

  const isSelf = person.id === user.id;
  // The same rule delete and deactivate answer to: an admin cannot rewrite
  // another admin, because changing an email is taking the account over.
  const blocked =
    !isSelf &&
    (person.role === "OWNER" || (person.role === "ADMIN" && user.role !== "OWNER"));

  return (
    <>
      <PageHeader
        title={`Edit ${person.name}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone="accent">{ROLE_LABEL[person.role]}</Badge>
            <span className="text-[var(--text-faint)]">{person.email}</span>
          </span>
        }
        action={<LinkButton href="/people">Back</LinkButton>}
      />

      {blocked ? (
        <Notice tone="danger">
          {person.role === "OWNER"
            ? "The owner account cannot be edited by anybody else."
            : "Only the owner can edit an admin."}
        </Notice>
      ) : (
        <Card className="max-w-xl">
          <CardHeader
            title="Details"
            hint="The role and the salesmen a CRE works for are changed from the People list, not here."
          />
          <ActionForm
            action={updateUserAction}
            submitLabel="Save changes"
            pendingLabel="Saving..."
            hidden={{ targetId: person.id }}
          >
            <Field label="Name" required>
              <Input name="name" defaultValue={person.name} required maxLength={120} />
            </Field>

            <FieldRow>
              <Field
                label="Email"
                required
                hint="This is what they sign in with."
              >
                <Input
                  name="email"
                  type="email"
                  defaultValue={person.email}
                  required
                  maxLength={254}
                />
              </Field>
              <Field label="Phone">
                <Input
                  name="phone"
                  type="tel"
                  defaultValue={person.phone ?? ""}
                  maxLength={40}
                />
              </Field>
            </FieldRow>
          </ActionForm>

          <p className="mt-4 border-t pt-3 text-sm leading-relaxed text-[var(--text-muted)]">
            Changing the email does not sign this person out. Use{" "}
            <span className="font-medium">Reset a password</span> on the People
            page for that.
          </p>
        </Card>
      )}
    </>
  );
}
