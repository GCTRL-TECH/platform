-- Klassifikations-Scope fuer Zugriffstokens ("Freigabeklasse").
--
-- Bisher traegt ein Token eine feste Liste von Wissensbasen (api_key_grants). Die
-- Liste entsteht beim Ausstellen — eine Wissensbasis, die spaeter angelegt wird,
-- fehlt darin, und ein Kollege mit Freigabe "intern" sah deshalb nur Wissen, das
-- aelter ist als sein Token.
--
-- `class_scope_level_id` ergaenzt die Liste um eine REGEL statt einer Aufzaehlung:
-- das Token erreicht zusaetzlich JEDE Wissensbasis des Kontos, deren Einstufung
-- hoechstens so hoch ist wie diese Klasse — auch kuenftig angelegte. Zwei Grenzen
-- sind in der Aufloesung fest verdrahtet (services/api-rs/src/routes/kg.rs,
-- `api_key_class_scope`):
--   * NUR LESEN. Geschrieben wird weiterhin ausschliesslich in explizit
--     gegrantete Wissensbasen (`enforce_kb_write_scope`).
--   * NIE PERSOENLICH. Alles unter dem Wurzelordner `Users/` bleibt aussen vor,
--     egal wie es eingestuft ist; dort liegen die persoenlichen Wissensbasen
--     aller Kollegen (Ablageregel Users/<localpart>).
--
-- NULL (Vorgabe) = keine Klasse, Verhalten wie bisher.
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS class_scope_level_id UUID REFERENCES classification_levels(id);

CREATE INDEX IF NOT EXISTS idx_api_keys_class_scope ON api_keys(class_scope_level_id);
