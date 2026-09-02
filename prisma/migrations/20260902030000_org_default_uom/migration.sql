-- What this organisation quotes by (e.g. "SQM" for panels, "LTR" for
-- liquids). Drives the Overview quantity tile and what a new quotation line
-- opens with - see the field's doc comment in schema.prisma.
ALTER TABLE "Organisation" ADD COLUMN     "defaultUom" TEXT;
