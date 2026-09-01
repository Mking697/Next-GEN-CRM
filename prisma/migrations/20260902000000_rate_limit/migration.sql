-- A database-backed fixed-window counter for login brute-force protection.
-- Replaces an in-process Map, which cannot work once the app runs as
-- independently cold-started serverless functions with no shared memory.
CREATE TABLE "RateLimit" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "resetAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "RateLimit_resetAt_idx" ON "RateLimit"("resetAt");
