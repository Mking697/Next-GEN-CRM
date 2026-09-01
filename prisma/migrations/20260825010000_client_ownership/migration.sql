-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "salesmanId" TEXT,
ADD COLUMN     "sheetSalesExecutive" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "sheetAlias" TEXT;

-- CreateIndex
CREATE INDEX "Company_salesmanId_idx" ON "Company"("salesmanId");

-- CreateIndex
CREATE INDEX "User_sheetAlias_idx" ON "User"("sheetAlias");

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_salesmanId_fkey" FOREIGN KEY ("salesmanId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

