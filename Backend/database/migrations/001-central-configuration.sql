-- Run with a database administrator against the Core database.
-- psql -d <core-database> -v backend_role=<backend-runtime-role> -f 001-central-configuration.sql
\set ON_ERROR_STOP on
BEGIN;
CREATE TABLE IF NOT EXISTS public.deployment_configuration (
  id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL,
  config JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_by TEXT
);
CREATE TABLE IF NOT EXISTS public.deployment_configuration_history (
  revision INTEGER PRIMARY KEY, config JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_by TEXT
);
CREATE TABLE IF NOT EXISTS public.configuration_service_status (
  service_id TEXT PRIMARY KEY, active_revision INTEGER NOT NULL,
  fetched_revision INTEGER NOT NULL, last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
GRANT SELECT, INSERT, UPDATE ON public.deployment_configuration TO :"backend_role";
GRANT SELECT, INSERT ON public.deployment_configuration_history TO :"backend_role";
GRANT SELECT, INSERT, UPDATE ON public.configuration_service_status TO :"backend_role";
COMMIT;
