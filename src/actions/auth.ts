"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { actionGuard, fail, ok, type ActionResult } from "@/lib/errors";
import { hashPassword, needsRehash, verifyPassword } from "@/lib/password";
import { createSession, destroySession, requestIp } from "@/lib/session";
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

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, passwordHash: true, isActive: true },
    });

    // Same message and roughly the same cost whether the account exists or
    // not, so this cannot be used to enumerate who works here.
    const valid = user
      ? await verifyPassword(password, user.passwordHash)
      : await verifyPassword(password, "scrypt$16384$8$1$AAAA$AAAA");

    if (!user || !valid) {
      return fail("That email address and password do not match.", "AUTH");
    }
    if (!user.isActive) {
      return fail(
        "That account has been deactivated. Ask an admin to reactivate it.",
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
