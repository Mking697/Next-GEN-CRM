-- What a new quotation starts out saying, per organisation.
--
-- These were three constants compiled into src/server/quotations.ts and
-- written for one company: a subject naming PUF/PIR panels, a note about
-- customer specifications, and nine terms fixing the payment split, the
-- delivery window and the jurisdiction to Delhi. Every company that signed up
-- would have inherited all of it and had to overwrite it on every quotation.
--
-- Same problem the letterhead had, and the same fix: it belongs to an
-- organisation, not to the process.
--
-- These seed a NEW quotation and nothing more. Changing them here never
-- touches a quotation that already exists - a quotation is a document that was
-- sent on a date, and what it said stays with it.

ALTER TABLE "Organisation" ADD COLUMN "quotationSubject" TEXT;
ALTER TABLE "Organisation" ADD COLUMN "quotationNote" TEXT;
ALTER TABLE "Organisation" ADD COLUMN "quotationTerms" TEXT;

-- Existing organisations keep exactly the text they have been quoting with.
-- Anything else would silently change what their next quotation says.
UPDATE "Organisation" SET
  "quotationSubject" = 'Supply and installation of PUF/PIR insulated panels as per specifications below:',
  "quotationNote" = 'All panels will be manufactured and supplied as per customer specifications and requirements.',
  "quotationTerms" = concat_ws(E'\n',
    '1. Delivery Period: Within 12-15 Days from Date of Confirmed Order along with advance',
    '2. Price: The above mentioned price is basic. GST 18% extra.',
    '3. Lifting of the material has to be as per the committed date any delay in lifting of material than payment due date will be considered from the date of readiness of the material.',
    '4. Transportation: Will be charged Extra at actuals and will be billed accordingly. Our Responsibility is to arrange the transportation on behalf of customer. Any damage during transportation will not be in our scope.',
    '5. Insurance: To your Account',
    '6. Payment Terms: 50% advance with Purchase Order and 50 % before dispatch against PI.',
    '7. The Offer is valid 15 days from the date of quotation.',
    '8. All Civil, Fabrication work is under your scope',
    '9. Jurisdiction: Any dispute is subject to jurisdiction of Delhi Court only.'
  )
WHERE "quotationTerms" IS NULL;
