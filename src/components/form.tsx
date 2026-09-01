"use client";

import { useActionState, useEffect, useRef, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { buttonStyles, cx, Notice } from "./ui";
import type { ActionResult } from "@/lib/errors";

/**
 * The client half of every form.
 *
 * Server actions return an ActionResult rather than throwing at the user, so
 * a refused grab or an over-limit payment comes back as a sentence in the
 * form instead of an error page. Field-level messages are listed under the
 * summary; the fields themselves stay uncontrolled, which keeps every form on
 * this app working before hydration finishes.
 */

export type FormState = ActionResult<unknown> | null;

export type FormAction = (
  state: FormState,
  formData: FormData,
) => Promise<ActionResult<unknown>>;

export function SubmitButton({
  children,
  variant = "primary",
  className,
  pendingLabel,
  disabled,
}: {
  children: ReactNode;
  variant?: keyof typeof buttonStyles;
  className?: string;
  pendingLabel?: string;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className={cx(buttonStyles[variant], className)}
      aria-busy={pending || undefined}
    >
      {pending ? (pendingLabel ?? "Working...") : children}
    </button>
  );
}

export function ActionForm({
  action,
  children,
  submitLabel,
  submitVariant = "primary",
  pendingLabel,
  className,
  footer,
  successMessage,
  resetOnSuccess = false,
  hidden,
}: {
  action: FormAction;
  children?: ReactNode;
  submitLabel: string;
  submitVariant?: keyof typeof buttonStyles;
  pendingLabel?: string;
  className?: string;
  footer?: ReactNode;
  successMessage?: string;
  resetOnSuccess?: boolean;
  /** Fixed values that are part of the request, not part of the UI. */
  hidden?: Record<string, string | undefined>;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (resetOnSuccess && state?.ok) formRef.current?.reset();
  }, [state, resetOnSuccess]);

  const fieldErrors =
    state && !state.ok && state.fieldErrors
      ? Object.entries(state.fieldErrors)
      : [];

  return (
    <form ref={formRef} action={formAction} className={cx("space-y-3", className)}>
      {hidden
        ? Object.entries(hidden)
            .filter(([, value]) => value !== undefined)
            .map(([name, value]) => (
              <input key={name} type="hidden" name={name} value={value} />
            ))
        : null}

      {children}

      {state && !state.ok ? (
        <Notice tone="danger" title={state.error}>
          {fieldErrors.length > 0 ? (
            <ul className="list-inside list-disc">
              {fieldErrors.map(([field, message]) => (
                <li key={field}>{message}</li>
              ))}
            </ul>
          ) : (
            "Nothing was saved."
          )}
        </Notice>
      ) : null}

      {state?.ok && (state.message || successMessage) ? (
        <Notice tone="ok">{state.message ?? successMessage}</Notice>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton variant={submitVariant} pendingLabel={pendingLabel}>
          {submitLabel}
        </SubmitButton>
        {footer}
      </div>
    </form>
  );
}

/**
 * A single-button form, for actions with no fields: grab, close, hand over.
 * Same error surface as the full form, no layout around it.
 */
export function ActionButton({
  action,
  children,
  variant = "secondary",
  pendingLabel,
  hidden,
  confirm,
  className,
}: {
  action: FormAction;
  children: ReactNode;
  variant?: keyof typeof buttonStyles;
  pendingLabel?: string;
  hidden?: Record<string, string | undefined>;
  confirm?: string;
  className?: string;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(action, null);

  return (
    <div className={cx("inline-block", className)}>
      <form
        action={formAction}
        onSubmit={(event) => {
          if (confirm && !window.confirm(confirm)) event.preventDefault();
        }}
      >
        {hidden
          ? Object.entries(hidden)
              .filter(([, value]) => value !== undefined)
              .map(([name, value]) => (
                <input key={name} type="hidden" name={name} value={value} />
              ))
          : null}
        <SubmitButton variant={variant} pendingLabel={pendingLabel}>
          {children}
        </SubmitButton>
      </form>
      {state && !state.ok ? (
        <p className="mt-1.5 max-w-xs text-xs leading-snug text-[var(--danger)]">
          {state.error}
        </p>
      ) : null}
      {state?.ok && state.message ? (
        <p className="mt-1.5 max-w-xs text-xs leading-snug text-[var(--ok)]">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
