"use client";

import { useState, useTransition } from "react";
import { createRenewalCheckoutAction } from "@/actions/billing";
import { buttonStyles, cx, Notice } from "@/components/ui";

/**
 * Redirects to a Dodo Payments hosted checkout session this app already
 * created server-side. There is no client-side SDK to load - unlike
 * Razorpay's embeddable modal, Dodo Payments is a hosted checkout page - so
 * this component only has to ask for the URL and send the browser there.
 *
 * The subscription is never extended by anything that happens in this
 * browser tab: only Dodo Payments' webhook, once it confirms the payment
 * actually succeeded, does that (see
 * src/app/api/webhooks/dodo-payments/route.ts and src/server/billing.ts). A
 * customer can close the tab or come back before that webhook lands, so the
 * redirect back to this page is never treated as proof anything was charged.
 */
export function RenewButton() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    setError(null);
    startTransition(async () => {
      const result = await createRenewalCheckoutAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      window.location.href = result.data.checkoutUrl;
    });
  }

  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className={cx(buttonStyles.primary)}
        aria-busy={pending || undefined}
      >
        {pending ? "Preparing..." : "Renew for 30 days"}
      </button>

      {error ? (
        <div className="mt-3">
          <Notice tone="danger" title={error}>
            Nothing was charged.
          </Notice>
        </div>
      ) : null}
    </div>
  );
}
