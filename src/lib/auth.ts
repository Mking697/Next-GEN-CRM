import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { readSession, type SessionUser } from "./session";
import {
  AuthorizationError,
  can,
  requirePermission,
  type PermissionId,
} from "./permissions";
import { UnauthenticatedError } from "./errors";

/**
 * The gate every page, action and route handler goes through.
 *
 * React's `cache` dedupes the session lookup within a single request, so a
 * layout, a page and three server components asking "who is this?" cost one
 * query, not five.
 */

export const currentUser = cache(async (): Promise<SessionUser | null> => {
  return readSession();
});

/** For pages and layouts: bounce to the login screen when signed out. */
export async function requireUser(returnTo?: string): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) {
    const target = returnTo ? `/login?next=${encodeURIComponent(returnTo)}` : "/login";
    redirect(target);
  }
  return user;
}

/** For server actions and route handlers: throw instead of redirecting. */
export async function requireUserOrThrow(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) throw new UnauthenticatedError();
  return user;
}

/**
 * Require a signed-in user who holds a permission. This and the Guidebook read
 * the same table, so nothing can be enforced that the guidebook does not
 * describe, and nothing can be described that is not enforced.
 */
export async function requireAuth(
  permission: PermissionId,
): Promise<SessionUser> {
  const user = await requireUserOrThrow();
  requirePermission(user.role, permission);
  return user;
}

/** Non-throwing check, for hiding UI a user cannot use. */
export async function userCan(permission: PermissionId): Promise<boolean> {
  const user = await currentUser();
  return user ? can(user.role, permission) : false;
}

/** Page-level guard: signed in AND permitted, or redirected away. */
export async function requirePageAccess(
  permission: PermissionId,
  returnTo?: string,
): Promise<SessionUser> {
  const user = await requireUser(returnTo);
  if (!can(user.role, permission)) {
    redirect(`/denied?permission=${encodeURIComponent(permission)}`);
  }
  return user;
}

export { AuthorizationError };
export type { SessionUser };
