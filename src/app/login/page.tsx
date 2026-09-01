import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { loginAction } from "@/actions/auth";
import { ActionForm } from "@/components/form";
import { Field, Input } from "@/components/fields";
import { PasswordInput } from "@/components/password-input";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; workspace?: string }>;
}) {
  const user = await currentUser();
  if (user) redirect("/overview");

  const { next, workspace } = await searchParams;
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : undefined;

  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-12">
      <div className="w-full max-w-sm rise">
        <div className="mb-7">
          <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--accent)] text-md font-semibold text-white">
            C
          </div>
          <h1 className="text-lg font-semibold tracking-tight">Sales CRM</h1>
          <p className="mt-1 text-base text-[var(--text-muted)]">
            Sign in with the email address and password your admin gave you.
          </p>
        </div>

        <div className="rounded-xl border bg-[var(--bg-raised)] p-5 shadow-[var(--shadow)]">
          <ActionForm action={loginAction} submitLabel="Sign in" pendingLabel="Signing in...">
            <input type="hidden" name="next" value={safeNext ?? ""} />
            <Field label="Email" required>
              <Input
                name="email"
                type="email"
                autoComplete="username"
                autoFocus
                required
                placeholder="you@company.com"
              />
            </Field>
            <Field label="Password" required>
              <PasswordInput
                name="password"
                autoComplete="current-password"
                required
              />
            </Field>
            {/* Almost nobody needs this. One email address belongs to one
                workspace for most people, and leaving it blank finds it. It
                only earns its place when the same address signs into two. */}
            <Field
              label="Workspace"
              hint="Only if you use this email in more than one company."
            >
              <Input
                name="workspace"
                autoComplete="organization"
                defaultValue={workspace ?? ""}
                placeholder="optional"
              />
            </Field>
          </ActionForm>
        </div>

        <p className="mt-5 text-sm leading-relaxed text-[var(--text-faint)]">
          Your admin creates your account. If you are setting up a company for
          the first time,{" "}
          <Link href="/signup" className="text-[var(--accent-text)] hover:underline">
            start a workspace
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
