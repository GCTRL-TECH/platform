-- KB-scoping for access tokens (Single-Owner + Scoped Tokens model).
--
-- Until now an access token's `api_key_grants` only RAISED access on specific
-- compilations on top of the token's base clearance — a token with one grant
-- could still READ every other compilation the owner has, at its base clearance.
-- That is wrong for the colleague use-case: a finance colleague's token must see
-- ONLY its assigned knowledge base(s), nothing else.
--
-- `kb_scoped = true` flips a token into "specific-KBs" mode: it may read/write
-- ONLY the compilations in its grant set; every other compilation is invisible
-- (effective rank denied), regardless of base clearance. `kb_scoped = false`
-- (default, back-compat) keeps the existing "all-KBs, grants raise" behaviour
-- used by the owner's own admin tokens.

ALTER TABLE api_keys
  ADD COLUMN kb_scoped BOOLEAN NOT NULL DEFAULT false;
