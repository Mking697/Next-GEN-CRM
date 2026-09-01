import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import {
  hashPasswordWith,
  suggestPassword,
  validatePassword,
} from "../src/lib/password-core";

/**
 * Break glass: reset any account's password from the shell.
 *
 *   npm run reset-password -- owner@example.com
 *   npm run reset-password -- owner@example.com "a-password-you-chose"
 *
 * This exists because of a real dead end. Only the owner may reset an owner's
 * password, there is no email-based reset yet, and `npm run seed` is
 * idempotent - it does nothing once an owner exists. So an owner who forgets
 * their password cannot be helped by anybody: not an admin, not the seed
 * script. The only way back in was hand-written SQL, which is easy to get
 * wrong in a way that locks the account harder.
 *
 * It grants no new authority. Running it needs DIRECT_DATABASE_URL and
 * AUTH_SECRET, and whoever holds those could already write the row by hand.
 * What it adds is doing it *correctly*: the same scrypt parameters the app
 * verifies against, every session torn down, and an audit row written - so a
 * password change made from a shell is as visible afterwards as one made from
 * the People page.
 *
 * When email-based reset ships, this stays. Recovery that depends on the
 * network being up is not recovery.
 */

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [emailArg, passwordArg] = process.argv.slice(2);

  if (!emailArg) {
    fail(
      "Usage: npm run reset-password -- <email> [new-password]\n" +
        "  Leave the password out and a strong one is generated and printed.",
    );
  }

  // Migrations, seeding and this all go through the unpooled connection.
  const connectionString =
    process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) fail("DIRECT_DATABASE_URL (or DATABASE_URL) is not set.");

  const authSecret = process.env.AUTH_SECRET?.trim();
  if (!authSecret || authSecret.length < 32) {
    fail(
      "AUTH_SECRET is not set, or is shorter than 32 characters. The hash is\n" +
        "  peppered with it, so the wrong value here writes a password that can\n" +
        "  never be verified.",
    );
  }

  const email = emailArg.trim().toLowerCase();

  // Generated rather than demanded, so the person recovering an account does
  // not have to invent a password under pressure and reach for a weak one.
  const password = passwordArg ?? suggestPassword();
  const problem = validatePassword(password);
  if (problem) fail(`That password will not do: ${problem}`);

  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  try {
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, name: true, email: true, role: true, isActive: true },
    });
    if (!user) fail(`No account found for ${email}.`);

    const passwordHash = await hashPasswordWith(authSecret, password);

    // One transaction: the new password and the end of every old session land
    // together, so there is no window where the old password is dead but a
    // stolen session cookie still works.
    const [, sessions] = await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { passwordHash } }),
      prisma.session.deleteMany({ where: { userId: user.id } }),
      prisma.auditEvent.create({
        data: {
          action: "user.password.reset",
          // Null actor: this was run from a shell, not by a signed-in user.
          // The trail says so rather than crediting it to somebody.
          actorId: null,
          targetType: "User",
          targetId: user.id,
          detail:
            `The password for ${user.name} (${user.email}) was reset from the ` +
            `command line and every session was destroyed.`,
        },
      }),
    ]);

    console.log(`\n  Reset the password for ${user.name} <${user.email}>`);
    console.log(`  Role            ${user.role}`);
    console.log(`  Sessions ended  ${sessions.count}`);
    if (!user.isActive) {
      console.log(
        "  NOTE            this account is deactivated, so it still cannot sign in.",
      );
    }
    if (!passwordArg) {
      console.log(`\n  New password    ${password}`);
      console.log("  Sign in with it, then change it from the account page.");
    }
    console.log("");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("\n  Reset failed.\n");
  console.error(error);
  process.exit(1);
});
