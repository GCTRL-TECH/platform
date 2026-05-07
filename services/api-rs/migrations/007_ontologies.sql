CREATE TYPE ontology_scope AS ENUM ('private', 'shared', 'public');

CREATE TABLE ontologies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  parent_ontology_id UUID REFERENCES ontologies(id) ON DELETE SET NULL,
  scope ontology_scope NOT NULL DEFAULT 'private',
  source VARCHAR(100) DEFAULT 'custom',
  entity_type_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, name)
);

CREATE INDEX idx_ontologies_user ON ontologies(user_id);
CREATE INDEX idx_ontologies_scope ON ontologies(scope);

CREATE TABLE ontology_entity_types (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ontology_id UUID NOT NULL REFERENCES ontologies(id) ON DELETE CASCADE,
  qid VARCHAR(50),
  name VARCHAR(255) NOT NULL,
  aliases TEXT[] DEFAULT '{}',
  description TEXT,
  parent_qid VARCHAR(50),
  confidence_threshold FLOAT DEFAULT 0.3,
  color VARCHAR(20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(ontology_id, name)
);

CREATE INDEX idx_ontology_entity_types_ontology ON ontology_entity_types(ontology_id);
CREATE INDEX idx_ontology_entity_types_qid ON ontology_entity_types(qid);

CREATE TABLE ontology_properties (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity_type_id UUID NOT NULL REFERENCES ontology_entity_types(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  data_type VARCHAR(50) DEFAULT 'text',
  required BOOLEAN DEFAULT FALSE,
  searchable BOOLEAN DEFAULT TRUE,
  weight_in_matching FLOAT DEFAULT 1.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ontology_properties_type ON ontology_properties(entity_type_id);

CREATE TABLE ontology_match_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ontology_id UUID NOT NULL REFERENCES ontologies(id) ON DELETE CASCADE,
  entity_type_a VARCHAR(255) NOT NULL,
  entity_type_b VARCHAR(255) NOT NULL,
  can_match BOOLEAN DEFAULT TRUE,
  similarity_metric VARCHAR(100) DEFAULT 'trigrams',
  threshold FLOAT DEFAULT 0.85,
  blocking_strategy VARCHAR(50) DEFAULT 'type_based',
  properties_to_match TEXT[] DEFAULT '{"name"}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ontology_match_rules_ontology ON ontology_match_rules(ontology_id);

ALTER TABLE compilations ADD COLUMN IF NOT EXISTS ontology_id UUID REFERENCES ontologies(id);
ALTER TABLE compilations ADD COLUMN IF NOT EXISTS ontology_version INTEGER;
