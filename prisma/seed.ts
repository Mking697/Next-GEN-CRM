import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { hashPasswordWith, validatePassword } from "../src/lib/password-core";

/**
 * Creates the very first account: the owner.
 *
 * Nobody can sign themselves up in this application, so without this script
 * there is no way in. It runs once, against DIRECT_DATABASE_URL, and is
 * idempotent: if an owner already exists it reports that and changes nothing,
 * so re-running a deploy pipeline cannot reset somebody's password.
 *
 *   npm run seed
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill it in before seeding.`,
    );
  }
  return value.trim();
}

async function main(): Promise<void> {
  // Migrations and seeding both go through the unpooled connection.
  const connectionString =
    process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DIRECT_DATABASE_URL (or DATABASE_URL) is not set.");
  }

  const authSecret = required("AUTH_SECRET");
  if (authSecret.length < 32) {
    throw new Error("AUTH_SECRET must be at least 32 characters.");
  }

  const email = required("SEED_OWNER_EMAIL").toLowerCase();
  const password = required("SEED_OWNER_PASSWORD");
  const name = process.env.SEED_OWNER_NAME?.trim() || "Owner";

  // The first workspace. Everything the seed creates belongs to it, because
  // there is no longer any such thing as a row that belongs to nobody.
  const orgName = process.env.SEED_ORG_NAME?.trim() || "My Company";
  const orgSlug = (process.env.SEED_ORG_SLUG?.trim() || "main").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(orgSlug)) {
    throw new Error(
      "SEED_ORG_SLUG must be 3-40 characters of lowercase letters, digits and hyphens, " +
        "starting and ending with a letter or digit. It appears in sign-in URLs.",
    );
  }

  // The placeholders shipped in .env.example pass the length check, so they
  // need refusing by name. Seeding the owner with a password that is public
  // knowledge would be worse than not seeding at all.
  const PLACEHOLDERS = new Set([
    "change-this-before-you-run-the-seed",
    "change-me-to-a-long-random-string-at-least-32-chars",
  ]);
  if (PLACEHOLDERS.has(password)) {
    throw new Error(
      "SEED_OWNER_PASSWORD is still the placeholder from .env.example. Set a real password first.",
    );
  }
  if (email === "owner@example.com") {
    throw new Error(
      "SEED_OWNER_EMAIL is still the placeholder from .env.example. Set the real owner email first.",
    );
  }

  const problem = validatePassword(password);
  if (problem) {
    throw new Error(`SEED_OWNER_PASSWORD: ${problem}`);
  }

  const adapter = new PrismaPg({ connectionString, max: 2 });
  const prisma = new PrismaClient({ adapter });

  try {
    const existing = await prisma.user.findFirst({
      where: { role: "OWNER", org: { slug: orgSlug } },
      select: { email: true },
    });

    if (existing) {
      console.log(
        `The ${orgSlug} workspace already has an owner (${existing.email}). Nothing was changed.`,
      );
      console.log(
        "To reset that password, sign in as the owner and use the account page, or have an admin reset it.",
      );
      return;
    }

    const slugTaken = await prisma.organisation.findUnique({
      where: { slug: orgSlug },
      select: { id: true, name: true },
    });
    if (slugTaken) {
      throw new Error(
        `The ${orgSlug} workspace already exists (${slugTaken.name}) but has no owner. ` +
          "Pick a different SEED_ORG_SLUG, or give that workspace an owner by hand.",
      );
    }

    // One transaction: a workspace with no owner is unreachable, and an owner
    // with no workspace cannot exist at all.
    const owner = await prisma.$transaction(async (tx) => {
      const org = await tx.organisation.create({
        data: { slug: orgSlug, name: orgName },
        select: { id: true },
      });

      const created = await tx.user.create({
        data: {
          orgId: org.id,
          email,
          name,
          role: "OWNER",
          passwordHash: await hashPasswordWith(authSecret, password),
        },
        select: { id: true, email: true, name: true, orgId: true },
      });

      // The IndiaMART sync row, so the rate-limit check has something to read
      // on the very first cron tick.
      await tx.syncState.create({ data: { orgId: org.id, key: "indiamart" } });

      return created;
    });

    await prisma.auditEvent.create({
      data: {
        orgId: owner.orgId,
        action: "user.create",
        actorId: owner.id,
        targetType: "User",
        targetId: owner.id,
        detail: `Workspace ${orgName} (${orgSlug}) and its owner ${owner.name} (${owner.email}) created by the seed script`,
      },
    });

    console.log("");
    console.log(`  Workspace "${orgName}" created, slug ${orgSlug}.`);
    console.log("  Owner account created.");
    console.log(`    email    ${owner.email}`);
    console.log("    password the value of SEED_OWNER_PASSWORD");
    console.log("");
    console.log("  Sign in, change the password from the account page, then");
    console.log("  clear SEED_OWNER_PASSWORD from the environment.");
    console.log("");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error("");
  console.error(`  Seed failed: ${error instanceof Error ? error.message : error}`);
  console.error("");
  process.exit(1);
});
