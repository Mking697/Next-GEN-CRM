-- Each workspace's subscription end date. Null means it never expires - the
-- seed script and a hand-provisioned workspace both leave it that way. A
-- self-service signup writes a 14-day trial here; a platform administrator
-- extends it from the console once the customer pays.
ALTER TABLE "Organisation" ADD COLUMN     "subscriptionUntil" TIMESTAMP(3);
