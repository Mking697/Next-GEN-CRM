import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { ROLE_LABEL, ROLE_TAGLINE } from "@/lib/permissions";
import { changeOwnPasswordAction, logoutAction } from "@/actions/auth";
import { ActionForm, SubmitButton } from "@/components/form";
import { Field, Input } from "@/components/fields";
import {
  Badge,
  Card,
  CardHeader,
  DefinitionRow,
  LinkButton,
  PageHeader,
} from "@/components/ui";

export const metadata: Metadata = { title: "Your account" };

export default async function AccountPage() {
  const user = await requireUser("/account");

  return (
    <>
      <PageHeader
        title="Your account"
        subtitle="Change your password, or sign out."
        action={<LinkButton href="/guidebook">What can I do?</LinkButton>}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Who you are" />
          <dl>
            <DefinitionRow label="Name">{user.name}</DefinitionRow>
            <DefinitionRow label="Email">{user.email}</DefinitionRow>
            <DefinitionRow label="Role">
              <Badge tone="accent">{ROLE_LABEL[user.role]}</Badge>
            </DefinitionRow>
            {user.salesmen.length > 0 ? (
              <DefinitionRow
                label={user.salesmen.length === 1 ? "Works for" : "Works for"}
              >
                {user.salesmen.map((salesman) => salesman.name).join(", ")}
              </DefinitionRow>
            ) : null}
            {user.salesmen.length > 1 && user.activeSalesmanName ? (
              <DefinitionRow label="Working as">
                {user.activeSalesmanName}
              </DefinitionRow>
            ) : null}
          </dl>
          <p className="mt-3 text-sm leading-relaxed text-[var(--text-muted)]">
            {ROLE_TAGLINE[user.role]}
          </p>

          <form action={logoutAction} className="mt-4 border-t pt-4">
            <SubmitButton variant="secondary" pendingLabel="Signing out...">
              Sign out
            </SubmitButton>
          </form>
        </Card>

        <Card>
          <CardHeader
            title="Change your password"
            hint="Every other device is signed out when you do this. This one stays signed in."
          />
          <ActionForm
            action={changeOwnPasswordAction}
            submitLabel="Change password"
            pendingLabel="Changing..."
            resetOnSuccess
          >
            <Field label="Current password" required>
              <Input
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                required
              />
            </Field>
            <Field label="New password" required hint="At least 8 characters.">
              <Input
                name="newPassword"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
              />
            </Field>
            <Field label="New password again" required>
              <Input
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
              />
            </Field>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
