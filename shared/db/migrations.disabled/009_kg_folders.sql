-- KG Folders: visual organization layer for knowledge graphs
CREATE TABLE IF NOT EXISTS kg_folders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  parent_folder_id UUID REFERENCES kg_folders(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_kg_folders_user ON kg_folders(user_id);
CREATE INDEX idx_kg_folders_parent ON kg_folders(parent_folder_id);

-- Add folder_id to compilations (nullable = root level)
ALTER TABLE compilations ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES kg_folders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_compilations_folder ON compilations(folder_id);
