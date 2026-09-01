-- Keep the working behind a quantity, not just the answer.
--
-- The calculator evaluated what was typed and stored only the result, so a
-- line reading "18 SQM" gave no hint of whether that was 2+2*8 or something
-- else, and changing it meant redoing the sum from scratch. The expression is
-- now kept alongside the answer and comes back into the calculator when the
-- line is reopened.
--
-- Nullable and additive: every existing line keeps its quantity and simply
-- has no recorded working, which is the truth about them.

ALTER TABLE "QuotationItem" ADD COLUMN "qtyFormula" TEXT;
