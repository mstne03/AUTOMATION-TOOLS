-- Migraciones posteriores a la creacion de la BD.
--
-- init.sql solo corre al crear el volumen por primera vez, asi que cualquier
-- cambio de esquema posterior va AQUI. Aplicalo con:
--
--     uv run kb-migrate
--
-- Escribe siempre sentencias idempotentes (IF NOT EXISTS, IF EXISTS, DO $$ ... $$)
-- para poder ejecutarlo mas de una vez sin romper nada.

-- 2026-10-11: de bge-m3 (1024 dims) a multilingual-e5-small (384 dims).
-- Los vectores viejos no se pueden convertir: se borran los chunks y se vacia
-- content_hash para que `ingest all` reingiera todas las fuentes.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'
          AND format_type(atttypid, atttypmod) = 'vector(1024)'
    ) THEN
        DELETE FROM chunks;
        UPDATE documents SET content_hash = '';
        ALTER TABLE chunks ALTER COLUMN embedding TYPE VECTOR(384);
    END IF;
END $$;
