import "server-only";
import { prisma } from "@/lib/db";
import { ConflictError, ValidationError } from "@/lib/errors";
import { hashPassword, validatePassword } from "@/lib/password";
import { cleanText, normalizeEmail } from "@/lib/dedupe";
import { audit } from "./audit";

/**
 * A company signing itself up.
 *
 * Until now the first account came from the seed script, which is right for
 * one company and impossible for many. This is the other end of that: a
 * workspace and its owner, created together in one transaction, because a
 * workspace nobody can sign into is unreachable and an owner with no workspace
 * cannot exist at all.
 *
 * Everything else the company needs - address, GSTIN, logo, bank account - is
 * deliberately NOT asked for here. Making somebody fill in eleven fields
 * before they have seen the product is how a signup form gets abandoned. They
 * are asked for on the Settings page, and the quotation screen says plainly
 * what is still missing until they are.
 */

export interface SignupInput {
  companyName: string;
  slug: string;
  ownerName: string;
  email: string;
  password: string;
}

/**
 * The workspace identifier, which appears in sign-in and cannot be changed
 * casually afterwards - so it is validated tightly now rather than cleaned up
 * later.
 */
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/**
 * Words that would collide with a route or read as official.
 *
 * `admin` matters most: the platform console lives there, and a workspace by
 * that name would be a convincing thing to point a phishing link at.
 */
const RESERVED = new Set([
  "admin", "api", "app", "www", "mail", "support", "help", "billing",
  "login", "logout", "signup", "settings", "account", "static", "assets",
  "public", "internal", "system", "root", "owner", "platform", "console",
  "status", "health", "docs", "blog", "about", "pricing", "security",
]);

export function normaliseSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Suggest one from a company name, for the form to prefill. */
export function slugFrom(companyName: string): string {
  return normaliseSlug(companyName).slice(0, 40).replace(/-+$/, "");
}

export interface SignupResult {
  orgId: string;
  slug: string;
  userId: string;
}

export async function signUp(input: SignupInput): Promise<SignupResult> {
  const fieldErrors: Record<string, string> = {};

  const companyName = cleanText(input.companyName, 120);
  if (!companyName) fieldErrors.companyName = "Enter your company name";

  const ownerName = cleanText(input.ownerName, 120);
  if (!ownerName) fieldErrors.ownerName = "Enter your name";

  const slug = normaliseSlug(input.slug || "");
  if (!slug) {
    fieldErrors.slug = "Choose a workspace address";
  } else if (!SLUG.test(slug)) {
    fieldErrors.slug =
      "3 to 40 characters: lowercase letters, digits and hyphens, starting and ending with a letter or digit";
  } else if (RESERVED.has(slug)) {
    fieldErrors.slug = "That one is reserved. Pick another.";
  }

  const email = normalizeEmail(input.email);
  if (!email) fieldErrors.email = "Enter a valid email address";

  const passwordProblem = validatePassword(input.password);
  if (passwordProblem) fieldErrors.password = passwordProblem;

  if (Object.keys(fieldErrors).length > 0) {
    throw new ValidationError("Check the details below.", fieldErrors);
  }

  // Checked before the transaction for a readable message, and again by the
  // unique index inside it - two people can submit the same slug at once.
  const taken = await prisma.organisation.findUnique({
    where: { slug },
    select: { id: true },
  });
  if (taken) {
    throw new ValidationError("That workspace address is already taken.", {
      slug: "Already taken",
    });
  }

  const passwordHash = await hashPassword(input.password);

  try {
    return await prisma.$transaction(async (tx) => {
      const org = await tx.organisation.create({
        data: {
          slug,
          name: companyName!,
          // Sensible starting points a company can change in Settings.
          legalName: companyName,
          bankBeneficiary: companyName,
        },
        select: { id: true, slug: true },
      });

      const owner = await tx.user.create({
        data: {
          orgId: org.id,
          email: email!,
          name: ownerName!,
          role: "OWNER",
          passwordHash,
        },
        select: { id: true },
      });

      // So the five-minute rate-limit check has a row to read if this
      // workspace ever turns IndiaMART on.
      await tx.syncState.create({ data: { orgId: org.id, key: "indiamart" } });

      await audit(tx, {
        orgId: org.id,
        action: "workspace.signup",
        actorId: owner.id,
        targetType: "Organisation",
        targetId: org.id,
        detail: `${ownerName} signed up the ${companyName} workspace (${slug})`,
      });

      return { orgId: org.id, slug: org.slug, userId: owner.id };
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "P2002"
    ) {
      throw new ConflictError(
        "Somebody just took that workspace address. Try another.",
      );
    }
    throw error;
  }
}
