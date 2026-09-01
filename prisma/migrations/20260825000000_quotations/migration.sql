-- CreateEnum
CREATE TYPE "QuotationStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "MirrorStatus" AS ENUM ('PENDING', 'SYNCED', 'FAILED', 'DISABLED');

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "creId" TEXT,
ADD COLUMN     "handedToCreAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "quotationId" TEXT;

-- CreateTable
CREATE TABLE "Quotation" (
    "id" TEXT NOT NULL,
    "quoteNo" TEXT NOT NULL,
    "status" "QuotationStatus" NOT NULL DEFAULT 'DRAFT',
    "leadId" TEXT,
    "companyId" TEXT,
    "contactId" TEXT,
    "creId" TEXT NOT NULL,
    "partyName" TEXT NOT NULL,
    "contactPerson" TEXT,
    "customerMobile" TEXT,
    "customerEmail" TEXT,
    "customerGst" TEXT,
    "billingStreet" TEXT,
    "billingCity" TEXT,
    "billingState" TEXT,
    "billingPincode" TEXT,
    "billingCountry" TEXT DEFAULT 'India',
    "shippingPartyName" TEXT,
    "shippingContactPerson" TEXT,
    "shippingStreet" TEXT,
    "shippingCity" TEXT,
    "shippingState" TEXT,
    "shippingPincode" TEXT,
    "shippingCountry" TEXT DEFAULT 'India',
    "subject" TEXT,
    "note" TEXT,
    "terms" TEXT,
    "subTotalPaise" BIGINT NOT NULL DEFAULT 0,
    "freightPaise" BIGINT NOT NULL DEFAULT 0,
    "gstPercent" INTEGER NOT NULL DEFAULT 18,
    "gstPaise" BIGINT NOT NULL DEFAULT 0,
    "payablePaise" BIGINT NOT NULL DEFAULT 0,
    "validUntil" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "pdfUrl" TEXT,
    "sheetStatus" "MirrorStatus" NOT NULL DEFAULT 'PENDING',
    "sheetRow" INTEGER,
    "sheetSyncedAt" TIMESTAMP(3),
    "sheetError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuotationItem" (
    "id" TEXT NOT NULL,
    "quotationId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "particular" TEXT,
    "panelThickness" TEXT,
    "density" TEXT,
    "specs" TEXT,
    "sheetThickness" TEXT,
    "description" TEXT,
    "uom" TEXT,
    "qtyMilli" INTEGER NOT NULL DEFAULT 0,
    "ratePaise" BIGINT NOT NULL DEFAULT 0,
    "amountPaise" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuotationItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Quotation_quoteNo_key" ON "Quotation"("quoteNo");

-- CreateIndex
CREATE INDEX "Quotation_creId_idx" ON "Quotation"("creId");

-- CreateIndex
CREATE INDEX "Quotation_leadId_idx" ON "Quotation"("leadId");

-- CreateIndex
CREATE INDEX "Quotation_status_idx" ON "Quotation"("status");

-- CreateIndex
CREATE INDEX "Quotation_createdAt_idx" ON "Quotation"("createdAt");

-- CreateIndex
CREATE INDEX "Quotation_sheetStatus_idx" ON "Quotation"("sheetStatus");

-- CreateIndex
CREATE INDEX "QuotationItem_quotationId_idx" ON "QuotationItem"("quotationId");

-- CreateIndex
CREATE UNIQUE INDEX "QuotationItem_quotationId_position_key" ON "QuotationItem"("quotationId", "position");

-- CreateIndex
CREATE INDEX "Lead_creId_idx" ON "Lead"("creId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_quotationId_key" ON "Order"("quotationId");

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_creId_fkey" FOREIGN KEY ("creId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "Quotation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_creId_fkey" FOREIGN KEY ("creId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuotationItem" ADD CONSTRAINT "QuotationItem_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "Quotation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

