import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import {
  hashPasswordWith,
  suggestPassword,
  validatePassword,
} from "../src/lib/password-core";

/**
 * Create or reset the account that runs this software.
 *
 *   npm run platform-admin -- you@example.com "Your Name"
 *   npm run platform-admin -- you@example.com "Your Name" "a-password-you-chose"
 *
 * A platform administrator can see every customer's data through the console
 * and can open any workspace. That makes it the highest-value credential in
 * the system, so the account is created with mustChangePassword set: whatever
 * password it starts with has by then been in a shell history and probably a
 * chat window, and has to be replaced before the console will do anything.
 *
 * Deliberately a script rather than a signup page. There is no route anywhere
 * that creates one of these, so no amount of guessing at URLs reaches it - it
 * takes the database credentials, which is the right bar for an account that
 * can read everybody's data.
 */

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [emailArg, nameArg, passwordArg] = process.argv.slice(2);

  if (!emailArg || !nameArg) {
    fail(
      "Usage: npm run platform-admin -- <email> <name> [password]\n" +
        "  Leave the password out and a strong one is generated and printed.",
    );
  }

  const connectionString =
    process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) fail("DIRECT_DATABASE_URL (or DATABASE_URL) is not set.");

  const authSecret = process.env.AUTH_SECRET?.trim();
  if (!authSecret || authSecret.length < 32) {
    fail("AUTH_SECRET is not set, or is shorter than 32 characters.");
  }

  const email = emailArg.trim().toLowerCase();
  const password = passwordArg ?? suggestPassword();
  const problem = validatePassword(password);
  if (problem) fail(`That password will not do: ${problem}`);

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  try {
    const passwordHash = await hashPasswordWith(authSecret, password);
    const existing = await prisma.platformAdmin.findUnique({
      where: { email },
      select: { id: true },
    });

    const admin = await prisma.platformAdmin.upsert({
      where: { email },
      create: { email, name: nameArg.trim(), passwordHash, mustChangePassword: true },
      update: { name: nameArg.trim(), passwordHash, mustChangePassword: true, isActive: true },
      select: { id: true, email: true, name: true },
    });

    // A reset has to end every session that was open under the old password.
    const ended = await prisma.platformSession.deleteMany({
      where: { adminId: admin.id },
    });

    console.log(`\n  ${existing ? "Reset" : "Created"} platform administrator`);
    console.log(`  Name            ${admin.name}`);
    console.log(`  Email           ${admin.email}`);
    if (existing) console.log(`  Sessions ended  ${ended.count}`);
    if (!passwordArg) console.log(`\n  Password        ${password}`);
    console.log("\n  Sign in at /admin/login. You will be made to change this");
    console.log("  password before the console will do anything.\n");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("\n  Failed.\n");
  console.error(error);
  process.exit(1);
});
