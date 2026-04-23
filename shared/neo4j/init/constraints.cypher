CREATE CONSTRAINT entity_uri IF NOT EXISTS FOR (e:Entity) REQUIRE e.uri IS UNIQUE;
CREATE INDEX entity_name IF NOT EXISTS FOR (e:Entity) ON (e.name);
CREATE INDEX entity_type IF NOT EXISTS FOR (e:Entity) ON (e.type);
CREATE INDEX entity_classification IF NOT EXISTS FOR (e:Entity) ON (e._classification);
CREATE INDEX entity_owner IF NOT EXISTS FOR (e:Entity) ON (e._owner);
CREATE INDEX entity_source_job IF NOT EXISTS FOR (e:Entity) ON (e._source_job);
CREATE CONSTRAINT compilation_id IF NOT EXISTS FOR (c:Compilation) REQUIRE c.compilation_id IS UNIQUE;
