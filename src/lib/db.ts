import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { env } from "./env";
import { guardMode, inspect, report } from "./tenant-guard";

/**
 * One PrismaClient for the whole process, talking to Neon over the internet
 * through the pg driver adapter. No native query engine is involved, so the
 * exact same artefact runs on Windows locally and on Hostinger's Linux slot.
 *
 * Construction is lazy for the same reason env parsing is: `next build` must
 * not need production database credentials.
 */

type GlobalWithPrisma = typeof globalThis & { __crmPrisma?: PrismaClient };
const globalRef = globalThis as GlobalWithPrisma;

function createClient(): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    connectionTimeoutMillis: env.DATABASE_CONNECT_TIMEOUT_MS,

    /*
     * Still shorter than Neon's own idle timeout, but no longer shorter than
     * a person thinking.
     *
     * At 30 seconds this closed the connection between one page and the next
     * whenever somebody paused to read, and the reconnect showed up as the
     * difference between a 409ms first request and a 57ms warm one. On an
     * eight-person CRM that is used in bursts, most requests were paying it.
     * Two minutes covers normal navigation and stays well inside the window
     * Neon keeps a pooled client for.
     */
    idleTimeoutMillis: 120_000,

    // TCP keepalives, so a NAT or firewall between here and Neon does not
    // silently drop a socket the pool still believes in.
    keepAlive: true,

    // This is a long-running server: the process should not be trying to exit
    // when the pool happens to be idle.
    allowExitOnIdle: false,
  });

  const base = new PrismaClient({
    adapter,
    log:
      env.NODE_ENV === "development"
        ? [{ emit: "stdout", level: "warn" }, { emit: "stdout", level: "error" }]
        : [{ emit: "stdout", level: "error" }],
  });

  /*
   * The tenant guard.
   *
   * Checked here rather than in each caller, because the callers are exactly
   * what cannot be trusted to remember. Costs one object inspection per query
   * and no extra round trip - see lib/tenant-guard.ts for why that matters,
   * and for what row-level security covers that this does not.
   */
  const mode = guardMode();
  if (mode === "off") return base;

  return base.$extends({
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          report(inspect(model, operation, args), mode);
          return query(args);
        },
      },
    },
  }) as unknown as PrismaClient;
}

function getClient(): PrismaClient {
  // In dev, Next hot-reloads modules; reuse the client across reloads so we do
  // not leak a connection pool on every save.
  globalRef.__crmPrisma ??= createClient();
  return globalRef.__crmPrisma;
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property) {
    const client = getClient();
    const value = Reflect.get(client, property, client) as unknown;
    return typeof value === "function" ? value.bind(client) : value;
  },
});

/** Prisma's interactive-transaction client, for functions that take a `tx`. */
export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/** A `tx` when we are inside a transaction, the plain client when we are not. */
export type Db = Tx | PrismaClient;
