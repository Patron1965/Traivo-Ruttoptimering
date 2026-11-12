// Only installed in a separately approved, otherwise empty database.
export const POSTGRES_SCHEMA = `
CREATE SCHEMA IF NOT EXISTS siths_federation;
CREATE TABLE IF NOT EXISTS siths_federation.auth (
  record_key text PRIMARY KEY,
  expires_at bigint NOT NULL,
  binding_hash text,
  payload jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_expiry ON siths_federation.auth (expires_at);
CREATE TABLE IF NOT EXISTS siths_federation.replay (
  token_hash text PRIMARY KEY,
  expires_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS replay_expiry ON siths_federation.replay (expires_at);
CREATE TABLE IF NOT EXISTS siths_federation.audit (
  id text PRIMARY KEY,
  correlation_hash text NOT NULL,
  occurred_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  event jsonb NOT NULL,
  key_id text NOT NULL,
  mac text NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_correlation ON siths_federation.audit (correlation_hash, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_expiry ON siths_federation.audit (expires_at);
CREATE OR REPLACE FUNCTION siths_federation.guard_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    RAISE EXCEPTION 'AUDIT_APPEND_ONLY';
  END IF;
  IF OLD.expires_at > floor(extract(epoch FROM clock_timestamp()) * 1000) THEN
    RAISE EXCEPTION 'AUDIT_RETENTION_NOT_REACHED';
  END IF;
  RETURN OLD;
END;
$$;
CREATE OR REPLACE TRIGGER audit_mutation_guard BEFORE UPDATE OR DELETE
ON siths_federation.audit FOR EACH ROW EXECUTE FUNCTION siths_federation.guard_audit_mutation();
CREATE OR REPLACE TRIGGER audit_truncate_guard BEFORE TRUNCATE
ON siths_federation.audit FOR EACH STATEMENT EXECUTE FUNCTION siths_federation.guard_audit_mutation();
`;
