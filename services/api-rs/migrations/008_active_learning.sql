CREATE TABLE review_queue (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ontology_id UUID REFERENCES ontologies(id) ON DELETE SET NULL,
  compilation_id UUID REFERENCES compilations(id) ON DELETE SET NULL,
  entity_a_uri VARCHAR(500) NOT NULL,
  entity_a_name VARCHAR(500),
  entity_a_type VARCHAR(100),
  entity_b_uri VARCHAR(500) NOT NULL,
  entity_b_name VARCHAR(500),
  entity_b_type VARCHAR(100),
  confidence FLOAT NOT NULL,
  discovery_method VARCHAR(50),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  decision VARCHAR(20),
  decision_reason TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_review_queue_user ON review_queue(user_id);
CREATE INDEX idx_review_queue_status ON review_queue(status);
CREATE INDEX idx_review_queue_ontology ON review_queue(ontology_id);
CREATE INDEX idx_review_queue_compilation ON review_queue(compilation_id);

CREATE TABLE learned_weights (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ontology_id UUID NOT NULL REFERENCES ontologies(id) ON DELETE CASCADE,
  property_name VARCHAR(100) NOT NULL,
  weight FLOAT NOT NULL DEFAULT 1.0,
  feedback_count INTEGER NOT NULL DEFAULT 0,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(ontology_id, property_name)
);

CREATE INDEX idx_learned_weights_ontology ON learned_weights(ontology_id);
