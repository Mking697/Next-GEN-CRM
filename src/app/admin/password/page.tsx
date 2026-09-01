import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { readPlatformSession } from "@/server/platform";
import { changePlatformPasswordAction } from "@/actions/platform";
import { ActionForm } from "@/components/form";
import { Field, Input } from "@/components/fields";
import { PasswordInput } from "@/components/password-input";
import { Notice } from "@/components/ui";

export const metadata: Metadata = { title: "Change your password" };

export default async function PlatformPasswordPage() {
  const admin = await readPlatformSession();
  if (!admin) redirect("/admin/login");

  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-12">
      <div className="w-full max-w-sm rise">
        <h1 className="mb-1 text-lg font-semibold tracking-tight">
          Change your password
        </h1>
        <p className="mb-5 text-base text-[var(--text-muted)]">
          {admin.name} &middot; {admin.email}
        </p>

        {admin.mustChangePassword ? (
          <div className="mb-4">
            <Notice tone="warn" title="Required before you can go further">
              This account was created from the command line, so its password
              has been in a shell history and probably a chat window. It can
              read every customer&rsquo;s data, so it does not get to keep that
              password.
            </Notice>
          </div>
        ) : null}

        <div className="rounded-xl border bg-[var(--bg-raised)] p-5 shadow-[var(--shadow)]">
          <ActionForm
            action={changePlatformPasswordAction}
            submitLabel="Change password"
            pendingLabel="Changing..."
          >
            <Field label="Current password" required>
              <PasswordInput name="current" autoComplete="current-password" required />
            </Field>
            <Field label="New password" required hint="At least 8 characters. Use something long.">
              <PasswordInput name="password" autoComplete="new-password" required />
            </Field>
          </ActionForm>
        </div>
        <p className="mt-4 text-sm text-[var(--text-faint)]">
          Every open session ends, including this one.
        </p>
      </div>
    </main>
  );
}
