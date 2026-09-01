"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { actionGuard, fail, ok, type ActionResult } from "@/lib/errors";
import { hit, reset } from "@/lib/rate-limit";
import { env } from "@/lib/env";
import { requestIp } from "@/lib/session";
import { fromDateInputValue } from "@/lib/dates";
import {
  changePlatformPassword,
  impersonate,
  platformLogin,
  platformLogout,
  requirePlatformAdmin,
  setSubscriptionUntil,
  setWorkspaceActive,
} from "@/server/platform";

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

export async function platformLoginAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const email = text(formData, "email").toLowerCase();
    const password = text(formData, "password");
    if (!email || !password) {
      return fail("Enter your email address and password.", "VALIDATION");
    }

    // Tighter than the tenant login. This account reaches every customer's
    // data, so it gets a third of the attempts.
    const ip = (await requestIp()) ?? "unknown";
    const key = `platform-login:${email}:${ip}`;
    const limit = hit(key, Math.max(3, Math.floor(env.LOGIN_MAX_ATTEMPTS / 3)), env.LOGIN_WINDOW_MINUTES);
    if (!limit.allowed) {
      return fail(
        `Too many attempts. Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minute(s).`,
        "RATE_LIMITED",
      );
    }

    const admin = await platformLogin(email, password);
    reset(key);

    redirect(admin.mustChangePassword ? "/admin/password" : "/admin");
  });
}

export async function platformLogoutAction(): Promise<void> {
  await platformLogout();
  redirect("/admin/login");
}

export async function changePlatformPasswordAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const admin = await requirePlatformAdmin();
    await changePlatformPassword(
      admin,
      text(formData, "current"),
      text(formData, "password"),
    );
    // Every session went, including this one - sign in again with the new one.
    redirect("/admin/login?changed=1");
  });
}

export async function setWorkspaceActiveAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const admin = await requirePlatformAdmin();
    if (admin.mustChangePassword) {
      return fail("Change your password first.", "VALIDATION");
    }

    const orgId = text(formData, "orgId");
    const isActive = text(formData, "isActive") === "true";
    await setWorkspaceActive(admin, orgId, isActive);

    revalidatePath("/admin");
    return ok(
      undefined,
      isActive ? "Workspace reactivated." : "Workspace suspended and everybody signed out.",
    );
  });
}

export async function setSubscriptionUntilAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const admin = await requirePlatformAdmin();
    if (admin.mustChangePassword) {
      return fail("Change your password first.", "VALIDATION");
    }

    const orgId = text(formData, "orgId");
    const raw = text(formData, "until");

    let until: Date | null = null;
    if (raw) {
      until = fromDateInputValue(raw);
      if (!until) return fail("That is not a valid date.", "VALIDATION");
    }

    await setSubscriptionUntil(admin, orgId, until);

    revalidatePath("/admin");
    return ok(
      undefined,
      until
        ? `Subscription set to run until ${raw}.`
        : "Subscription expiry removed - this workspace never expires.",
    );
  });
}

export async function impersonateAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const admin = await requirePlatformAdmin();
    if (admin.mustChangePassword) {
      return fail("Change your password first.", "VALIDATION");
    }

    await impersonate(admin, text(formData, "orgId"));
    redirect("/overview");
  });
}
