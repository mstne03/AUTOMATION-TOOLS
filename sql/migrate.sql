-- Migraciones posteriores a la creacion de la BD.
--
-- init.sql solo corre al crear el volumen por primera vez, asi que cualquier
-- cambio de esquema posterior va AQUI. Aplicalo con:
--
--     uv run kb-migrate
--
-- Escribe siempre sentencias idempotentes (IF NOT EXISTS, IF EXISTS, DO $$ ... $$)
-- para poder ejecutarlo mas de una vez sin romper nada.
--
-- Ejemplo:
-- ALTER TABLE documents ADD COLUMN IF NOT EXISTS notes TEXT;

-- (vacio de momento)
SELECT 1;
