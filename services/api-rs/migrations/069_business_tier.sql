-- Tier-model rework: `starter` and `pro` are folded into a single `business`
-- tier (unlimited tokens). Tiers are now: free (1M/month local grant,
-- migration 067), business (unlimited), enterprise (unlimited).
--
-- The central license server may still mint `starter`/`pro` until it is
-- redeployed, so code treats those names as transitional aliases of business
-- (see routes::billing::is_unlimited_tier); this migration renames the rows we
-- already hold so local data matches the target model.

UPDATE licenses SET tier = 'business', updated_at = NOW() WHERE tier IN ('starter','pro');
UPDATE users    SET tier = 'business', updated_at = NOW() WHERE tier IN ('starter','pro');
