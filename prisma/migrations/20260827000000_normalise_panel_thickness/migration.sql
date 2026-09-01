-- Strip the stray unit suffix off panel thickness.
--
-- The column is free text and the data drifted: "60" three times, "60MM"
-- once, "80mm" once. Those are the same measurement typed two ways, and with
-- the spec datalist now offering past values, leaving them in means offering
-- "60" and "60MM" as if they were different panels.
--
-- Deliberately narrow. This only removes a unit suffix from a number, which
-- cannot change what the value means. The other drift in the same table is
-- NOT touched, because collapsing it would be a guess about the product
-- rather than a fix to a format:
--
--   sheetThickness has "0.4/0.4" and a bare "0.4". A bare 0.4 probably means
--   both faces, but "probably" is not good enough to rewrite a spec on a
--   customer's quotation.
--
--   particular has "Wall Panel", "WALL AND CEILING", "Door", "FLUSH DOOR",
--   "OVERLAP DOOR". Those are different products, not different spellings.
--
--   specs has "PP/PP", "PUFF", "SS/SS" - three real facings.
--
-- Both of those need somebody who knows the products to decide, so they stay
-- as they are and the datalist surfaces them honestly.

UPDATE "QuotationItem"
SET "panelThickness" = regexp_replace(btrim("panelThickness"), '\s*mm$', '', 'i')
WHERE "panelThickness" ~* '\s*mm$';
