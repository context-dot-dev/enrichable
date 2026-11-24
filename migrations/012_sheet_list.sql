-- Listing, searching and indexing a workspace's sheets read these instead of each sheet's whole definition.
ALTER TABLE enrichable.sheets
  ADD COLUMN IF NOT EXISTS name text GENERATED ALWAYS AS (data->>'name') STORED,
  ADD COLUMN IF NOT EXISTS created_at double precision GENERATED ALWAYS AS ((data->>'createdAt')::double precision) STORED,
  ADD COLUMN IF NOT EXISTS updated_at double precision GENERATED ALWAYS AS ((data->>'updatedAt')::double precision) STORED;
