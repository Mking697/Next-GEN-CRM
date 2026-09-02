"use client";

import { useState } from "react";
import { loginAction } from "@/actions/auth";
import { signUpAction } from "@/actions/workspace";
import { ActionForm } from "./form";
import { Field, Input } from "./fields";
import { PasswordInput } from "./password-input";
import { cx } from "./ui";

/**
 * Signing in and signing up, in one place.
 *
 * A toggle rather than two pages, because the two audiences arrive at the
 * same URL and neither should have to go looking. The tab is the only piece
 * of client state on this page; both forms are the same server actions the
 * standalone /login and /signup routes use, so there is one implementation of
 * each and no chance of them drifting apart.
 */
type Mode = "login" | "signup";

export function AuthPanel({ initial = "login" }: { initial?: Mode }) {
  const [mode, setMode] = useState<Mode>(initial);

  return (
    <div className="w-full max-w-sm">
      {/* Segmented control. Both options are always visible and always
          reachable - a link that swaps the whole page would lose whatever
          had already been typed. */}
      <div
        role="tablist"
        aria-label="Sign in or create a workspace"
        className="mb-5 grid grid-cols-2 gap-1 rounded-xl border bg-[var(--bg-sunken)] p-1"
      >
        {(
          [
            ["login", "Sign in"],
            ["signup", "Create a workspace"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => setMode(value)}
            className={cx(
              "cursor-pointer rounded-lg px-3 py-2 text-base font-medium transition-colors",
              mode === value
                ? "bg-[var(--bg-raised)] text-[var(--text)] shadow-[var(--shadow-sm)]"
                : "text-[var(--text-muted)] hover:text-[var(--text)]",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="rounded-xl border bg-[var(--bg-raised)] p-5 shadow-[var(--shadow)]">
        {mode === "login" ? (
          <ActionForm
            key="login"
            action={loginAction}
            submitLabel="Sign in"
            pendingLabel="Signing in..."
          >
            <input type="hidden" name="next" value="/overview" />
            <Field label="Email" required>
              <Input
                name="email"
                type="email"
                autoComplete="username"
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
            {/* Almost nobody needs this, so it does not get equal billing.
                One email belongs to one workspace for most people; it earns
                its place only when the same address signs into two. */}
            <details className="text-sm text-[var(--text-faint)]">
              <summary className="py-1 hover:text-[var(--text-muted)]">
                I use this email at more than one company
              </summary>
              <div className="pt-2">
                <Field label="Workspace">
                  <Input name="workspace" placeholder="which one" />
                </Field>
              </div>
            </details>
          </ActionForm>
        ) : (
          <ActionForm
            key="signup"
            action={signUpAction}
            submitLabel="Create workspace"
            pendingLabel="Creating..."
          >
            <Field label="Company name" required>
              <Input
                name="companyName"
                required
                maxLength={120}
                placeholder="Acme Manufacturing Pvt Ltd"
              />
            </Field>
            <Field label="Your name" required>
              <Input name="ownerName" required maxLength={120} placeholder="Ravi Kumar" />
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
            {/* Derived from the company name unless somebody wants their own.
                Asking for it outright makes a five-field form feel like six. */}
            <details className="text-sm text-[var(--text-faint)]">
              <summary className="py-1 hover:text-[var(--text-muted)]">
                Choose your own workspace address
              </summary>
              <div className="pt-2">
                <Field
                  label="Workspace address"
                  hint="Lowercase letters, digits and hyphens."
                >
                  <Input name="slug" maxLength={40} placeholder="acme-manufacturing" />
                </Field>
              </div>
            </details>
          </ActionForm>
        )}
      </div>

      <p className="mt-4 text-sm leading-relaxed text-[var(--text-faint)]">
        {mode === "login"
          ? "Your admin creates your account. If you are setting up a company for the first time, create a workspace instead."
          : "You will be the owner of this workspace. Your company details and logo come next, and they are what print on your quotations."}
      </p>
    </div>
  );
}
