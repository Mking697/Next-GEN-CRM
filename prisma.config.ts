import "dotenv/config";
import path from "node:path";
import { defineConfig } from "prisma/config";

// Prisma stops auto-loading .env once a config file exists, hence the
// explicit `dotenv/config` import above. Migrations use DIRECT_DATABASE_URL
// (see `directUrl` in schema.prisma); the app itself uses the pooled URL.
export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
    seed: "node --import tsx prisma/seed.ts",
  },
});
