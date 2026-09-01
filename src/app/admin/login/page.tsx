import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { readPlatformSession } from "@/server/platform";
import { platformLoginAction } from "@/actions/platform";
import { ActionForm } from "@/components/form";
import { Field, Input } from "@/components/fields";
import { PasswordInput } from "@/components/password-input";
import { Notice } from "@/components/ui";

export const metadata: Metadata = { title: "Sign in" };

export default async function PlatformLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ changed?: string }>;
}) {
  const admin = await readPlatformSession();
  if (admin) redirect(admin.mustChangePassword ? "/admin/password" : "/admin");

  const { changed } = await searchParams;

  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-12">
      <div className="w-full max-w-sm rise">
        <div className="mb-7">
          <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--text)] text-md font-semibold text-[var(--bg)]">
            P
          </div>
          <h1 className="text-lg font-semibold tracking-tight">Platform console</h1>
          <p className="mt-1 text-base text-[var(--text-muted)]">
            For whoever runs this software. Customers sign in at /login.
          </p>
        </div>

        {changed ? (
          <div className="mb-4">
            <Notice tone="ok" title="Password changed">
              Sign in again with the new one.
            </Notice>
          </div>
        ) : null}

        <div className="rounded-xl border bg-[var(--bg-raised)] p-5 shadow-[var(--shadow)]">
          <ActionForm action={platformLoginAction} submitLabel="Sign in" pendingLabel="Signing in...">
            <Field label="Email" required>
              <Input name="email" type="email" autoComplete="username" autoFocus required />
            </Field>
            <Field label="Password" required>
              <PasswordInput name="password" autoComplete="current-password" required />
            </Field>
          </ActionForm>
        </div>
      </div>
    </main>
  );
}
