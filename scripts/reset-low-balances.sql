-- One-shot fix: bring any free-tier user up to 3000 tokens if their balance
-- is below the new default. Pre-fix users started with 50 tokens and could
-- even land in negative numbers under the old extract/upload deduction logic.
-- Safe to re-run.
UPDATE users
SET tokens_balance = 3000, updated_at = NOW()
WHERE COALESCE(tier, 'free') = 'free'
  AND COALESCE(tokens_balance, 0) < 3000;
