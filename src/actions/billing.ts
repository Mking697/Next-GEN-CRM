"use server";

import { requireUserOrThrow } from "@/lib/auth";
import { actionGuard, ok, type ActionResult } from "@/lib/errors";
import { createRenewalCheckout, type RenewalCheckout } from "@/server/billing";

/**
 * Creates the Dodo Payments checkout session the browser is redirected to.
 * Does NOT touch Organisation.subscriptionUntil - only the webhook does that,
 * once Dodo Payments confirms the payment actually succeeded. See
 * server/billing.ts.
 */
export async function createRenewalCheckoutAction(): Promise<
  ActionResult<RenewalCheckout>
> {
  return actionGuard(async () => {
    const user = await requireUserOrThrow();
    const checkout = await createRenewalCheckout(user);
    return ok(checkout);
  });
}
