import "server-only";
import { env } from "./env";
import {
  hashPasswordWith,
  verifyPasswordWith,
  needsRehash,
  validatePassword,
  suggestPassword,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
} from "./password-core";

/**
 * The server-side password API: the same scrypt implementation the seed
 * script uses, with AUTH_SECRET supplied as the pepper.
 *
 * Rotating AUTH_SECRET invalidates every stored password, which is why
 * .env.example says not to rotate it casually.
 */

export async function hashPassword(plain: string): Promise<string> {
  return hashPasswordWith(env.AUTH_SECRET, plain);
}

export async function verifyPassword(
  plain: string,
  stored: string,
): Promise<boolean> {
  return verifyPasswordWith(env.AUTH_SECRET, plain, stored);
}

export {
  needsRehash,
  validatePassword,
  suggestPassword,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
};
