-- Dodo Payments subscription billing: one checkout session per renewal
-- attempt, and what became of it. See src/server/billing.ts for the flow
-- this supports, and AuditEvent (already existing) for the plain-sentence
-- trail this sits alongside.
-- CreateEnum
CREATE TYPE "SubscriptionPaymentStatus" AS ENUM ('CREATED', 'CAPTURED', 'FAILED');

-- CreateTable
CREATE TABLE "SubscriptionPayment" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "checkoutSessionId" TEXT,
    "dodoPaymentId" TEXT,
    "amountPaise" BIGINT,
    "status" "SubscriptionPaymentStatus" NOT NULL DEFAULT 'CREATED',
    "subscriptionUntilAfter" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "capturedAt" TIMESTAMP(3),

    CONSTRAINT "SubscriptionPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPayment_dodoPaymentId_key" ON "SubscriptionPayment"("dodoPaymentId");

-- CreateIndex
CREATE INDEX "SubscriptionPayment_orgId_idx" ON "SubscriptionPayment"("orgId");

-- CreateIndex
CREATE INDEX "SubscriptionPayment_checkoutSessionId_idx" ON "SubscriptionPayment"("checkoutSessionId");

-- AddForeignKey
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same tenant-isolation policy as every other table that belongs to an
-- organisation (see 20260901030000_row_level_security for what this is for
-- and, just as importantly, what it is NOT for - it does not gate the
-- application's own queries, only anything that connects as the restricted
-- role: a psql session, a BI tool, a leaked read-only credential).
ALTER TABLE "SubscriptionPayment" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SubscriptionPayment_tenant_isolation" ON "SubscriptionPayment";
CREATE POLICY "SubscriptionPayment_tenant_isolation" ON "SubscriptionPayment"
    USING ("orgId" = current_org_id());
