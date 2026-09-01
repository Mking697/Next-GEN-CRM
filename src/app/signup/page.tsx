import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { signUpAction } from "@/actions/workspace";
import { ActionForm } from "@/components/form";
import { Field, Input } from "@/components/fields";
import { PasswordInput } from "@/components/password-input";

export const metadata: Metadata = { title: "Start a workspace" };

/**
 * Five fields, and none of them is an address or a bank account.
 *
 * Everything the letterhead needs is asked for on the Settings page instead,
 * once they are inside and can see what it is for. Making somebody fill in
 * eleven fields before they have seen the product is how a signup form gets
 * abandoned halfway.
 */
export default async function SignupPage() {
  if (await currentUser()) redirect("/overview");

  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-12">
      <div className="w-full max-w-md rise">
        <div className="mb-7">
          <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--accent)] text-md font-semibold text-white">
            C
          </div>
          <h1 className="text-lg font-semibold tracking-tight">
            Start your workspace
          </h1>
          <p className="mt-1 text-base text-[var(--text-muted)]">
            Your company gets its own space. Nobody else can see anything in it.
          </p>
        </div>

        <div className="rounded-xl border bg-[var(--bg-raised)] p-5 shadow-[var(--shadow)]">
          <ActionForm
            action={signUpAction}
            submitLabel="Create workspace"
            pendingLabel="Creating..."
          >
            <Field label="Company name" required>
              <Input
                name="companyName"
                required
                autoFocus
                maxLength={120}
                placeholder="Hicon Panels Pvt Ltd"
              />
            </Field>

            <Field
              label="Workspace address"
              hint="Lowercase letters, digits and hyphens. Leave blank to use your company name."
            >
              <Input name="slug" maxLength={40} placeholder="hicon-panels" />
            </Field>

            <Field label="Your name" required>
              <Input name="ownerName" required maxLength={120} placeholder="Manish Tiwari" />
            </Field>

            <Field label="Email" required>
              <Input
                name="email"
                type="email"
                autoComplete="username"
                required
                placeholder="you@company.com"
              />
            </Field>

            <Field label="Password" required hint="At least 8 characters.">
              <PasswordInput
                name="password"
                autoComplete="new-password"
                required
              />
            </Field>
          </ActionForm>
        </div>

        <p className="mt-5 text-sm text-[var(--text-faint)]">
          Already have one?{" "}
          <Link href="/login" className="text-[var(--accent-text)] hover:underline">
            Sign in
          </Link>
          . You will be the owner of this workspace, and you add your team
          once you are in.
        </p>
      </div>
    </main>
  );
}
