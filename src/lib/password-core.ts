import {
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type BinaryLike,
  type ScryptOptions,
} from "node:crypto";
import { promisify } from "node:util";

/**
 * Password hashing, with the pepper passed in rather than read from the
 * environment.
 *
 * Split out from password.ts so the seed script - which runs as a plain Node
 * process, not inside Next - can use exactly the same algorithm instead of
 * reimplementing it. If these parameters ever change, the seeded owner and
 * every account an admin creates change together.
 *
 * Deliberately zero dependencies: scrypt is memory-hard and part of Node
 * itself, so there is no native build step on the deploy target.
 */

// promisify() only picks up the 3-argument overload, so the options-taking
// signature is restated here.
const scrypt = promisify(scryptCallback) as (
  password: BinaryLike,
  salt: BinaryLike,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

export const PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const MAXMEM = 64 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

function pepper(secret: string, plain: string): Buffer {
  return createHmac("sha256", secret).update(plain, "utf8").digest();
}

/** Returns `scrypt$N$r$p$salt$hash`, all base64url. */
export async function hashPasswordWith(
  secret: string,
  plain: string,
): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await scrypt(pepper(secret, plain), salt, KEY_LENGTH, {
    ...PARAMS,
    maxmem: MAXMEM,
  });
  return [
    "scrypt",
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

/**
 * Constant-time verification. Returns false rather than throwing on a
 * malformed stored value, so a corrupted row cannot 500 the login route.
 */
export async function verifyPasswordWith(
  secret: string,
  plain: string,
  stored: string,
): Promise<boolean> {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;

    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4] ?? "", "base64url");
    const expected = Buffer.from(parts[5] ?? "", "base64url");

    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
      return false;
    }
    if (salt.length === 0 || expected.length === 0) return false;

    const actual = await scrypt(pepper(secret, plain), salt, expected.length, {
      N,
      r,
      p,
      maxmem: MAXMEM,
    });

    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** True when the stored hash used weaker parameters than we use today. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return true;
  return (
    Number(parts[1]) < PARAMS.N ||
    Number(parts[2]) < PARAMS.r ||
    Number(parts[3]) < PARAMS.p
  );
}

/**
 * Returns an error message, or null when the password is acceptable.
 * Length-first rather than a character-class maze, which is what current
 * guidance actually recommends.
 */
export function validatePassword(plain: string): string | null {
  if (plain.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (plain.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  }
  if (plain.trim().length === 0) return "Password cannot be only spaces";

  const common = new Set([
    "password",
    "password1",
    "12345678",
    "123456789",
    "qwertyui",
    "iloveyou",
    "admin123",
    "welcome1",
    "changeme",
  ]);
  if (common.has(plain.toLowerCase())) return "That password is too common";

  return null;
}

/** A readable starting password an admin can hand over verbally. */
export function suggestPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(14);
  let out = "";
  for (const byte of bytes) {
    out += alphabet[byte % alphabet.length];
  }
  return out;
}
