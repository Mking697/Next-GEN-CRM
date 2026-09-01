-- Supporting indexes for the per-org order/quote-number allocators (see
-- withOrderNumber/withQuoteNumber, now filtered by orgId), and for the
-- date-ranged Overview aggregates that were previously scanning a salesman's
-- or CRE's entire history instead of just the reporting month.
CREATE INDEX "Lead_creId_ownerId_idx" ON "Lead"("creId", "ownerId");
CREATE INDEX "Lead_ownerId_grabbedAt_idx" ON "Lead"("ownerId", "grabbedAt");

CREATE INDEX "Order_creId_closedAt_idx" ON "Order"("creId", "closedAt");
CREATE INDEX "Order_orgId_salesmanId_idx" ON "Order"("orgId", "salesmanId");

CREATE INDEX "Quotation_orgId_salesmanId_idx" ON "Quotation"("orgId", "salesmanId");
