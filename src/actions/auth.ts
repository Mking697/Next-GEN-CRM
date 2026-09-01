"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { actionGuard, fail, ok, type ActionResult } from "@/lib/errors";
import { hashPassword, needsRehash, verifyPassword } from "@/lib/password";
import {
  createSession,
  destroySession,
  isSubscriptionExpired,
  requestIp,
} from "@/lib/session";
import { normalizeEmail } from "@/lib/dedupe";
import { hit, reset } from "@/lib/rate-limit";

/**
 * Email and password only. There is no sign-up action anywhere in this app:
 * the owner comes from the seed script and every other account is created by
 * an admin.
 */

export async function loginAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const email = normalizeEmail(String(formData.get("email") ?? ""));
    const password = String(formData.get("password") ?? "");
    const next = String(formData.get("next") ?? "") || "/overview";
    // Optional. Only needed when one email signs into two workspaces.
    const workspace = String(formData.get("workspace") ?? "").trim().toLowerCase();

    if (!email || password.length === 0) {
      return fail("Enter your email address and password.", "VALIDATION");
    }

    // Keyed on email and IP together, so one attacker cannot lock out a real
    // user by hammering their address from elsewhere.
    const ip = (await requestIp()) ?? "unknown";
    const key = `login:${email}:${ip}`;
    const limit = hit(key, env.LOGIN_MAX_ATTEMPTS, env.LOGIN_WINDOW_MINUTES);
    if (!limit.allowed) {
      return fail(
        `Too many attempts. Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minute(s).`,
        "RATE_LIMITED",
      );
    }

    // An email address is unique WITHIN an organisation, not across the
    // platform: one person can hold an account in two of them. So this looks
    // up every candidate and lets the password decide, rather than assuming
    // there is only ever one row.
    const candidates = await prisma.user.findMany({
      where: {
        email,
        ...(workspace ? { org: { slug: workspace } } : {}),
      },
      select: {
        id: true,
        passwordHash: true,
        isActive: true,
        org: {
          select: {
            slug: true,
            name: true,
            isActive: true,
            subscriptionUntil: true,
          },
        },
      },
    });

    // Same message and roughly the same cost whether the account exists or
    // not, so this cannot be used to enumerate who works here.
    if (candidates.length === 0) {
      await verifyPassword(password, "scrypt$16384$8$1$AAAA$AAAA");
      return fail("That email address and password do not match.", "AUTH");
    }

    const matched: typeof candidates = [];
    for (const candidate of candidates) {
      if (await verifyPassword(password, candidate.passwordHash)) {
        matched.push(candidate);
      }
    }

    if (matched.length === 0) {
      return fail("That email address and password do not match.", "AUTH");
    }

    // The same email and the same password in two workspaces. Rare, but it
    // has one right answer and it is not for us to guess it.
    if (matched.length > 1) {
      return fail(
        `That sign-in works for more than one workspace: ${matched
          .map((m) => m.org.name)
          .join(", ")}. Pick the one you meant.`,
        "WORKSPACE_CHOICE",
        { workspace: "Choose a workspace" },
      );
    }

    const user = matched[0]!;

    if (!user.isActive) {
      return fail(
        "That account has been deactivated. Ask an admin to reactivate it.",
        "AUTH",
      );
    }
    if (!user.org.isActive) {
      return fail(
        `The ${user.org.name} workspace is not active. Contact whoever owns it.`,
        "AUTH",
      );
    }
    if (isSubscriptionExpired(user.org)) {
      return fail(
        `The ${user.org.name} workspace's subscription has expired. Contact whoever owns it to renew.`,
        "AUTH",
      );
    }

    reset(key);

    // Opportunistically upgrade a hash written under weaker parameters.
    if (needsRehash(user.passwordHash)) {
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(password) },
      });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    await createSession(user.id);

    // Only ever bounce to a path inside this app.
    redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/overview");
  });
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect("/login");
}

/** Change your own password. Signs every other device out. */
export async function changeOwnPasswordAction(
  _previous: unknown,
  formData: FormData,
): Promise<ActionResult<undefined>> {
  return actionGuard(async () => {
    const { requireUserOrThrow } = await import("@/lib/auth");
    const { validatePassword } = await import("@/lib/password");
    const { destroyAllSessions } = await import("@/lib/session");

    const user = await requireUserOrThrow();
    const current = String(formData.get("currentPassword") ?? "");
    const next = String(formData.get("newPassword") ?? "");
    const confirm = String(formData.get("confirmPassword") ?? "");

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true },
    });

    if (!(await verifyPassword(current, row.passwordHash))) {
      return fail("Your current password is not right.", "VALIDATION", {
        currentPassword: "Wrong password",
      });
    }
    if (next !== confirm) {
      return fail("The two new passwords do not match.", "VALIDATION", {
        confirmPassword: "These must match",
      });
    }
    const problem = validatePassword(next);
    if (problem) {
      return fail(problem, "VALIDATION", { newPassword: problem });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(next) },
    });

    await destroyAllSessions(user.id);
    await createSession(user.id);

    return ok(undefined, "Password changed. Every other device has been signed out.");
  });
}
