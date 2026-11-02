BEGIN;

CREATE TABLE evolution_evidence (
  id text PRIMARY KEY,
  run_id text NOT NULL UNIQUE,
  evidence_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  CHECK (evidence_json->>'schemaVersion' = 'asset-run-evidence/1'),
  CHECK (evidence_json->>'runId' = run_id)
);

CREATE TABLE evolution_proposals (
  id text PRIMARY KEY,
  key text NOT NULL UNIQUE,
  proposal_json jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (proposal_json->>'schemaVersion' = 'asset-deterministic-proposal/1'),
  CHECK (proposal_json->>'key' = key)
);

CREATE TABLE evolution_candidates (
  id text PRIMARY KEY,
  proposal_id text NOT NULL REFERENCES evolution_proposals(id),
  base_policy_digest text NOT NULL,
  policy_digest text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','probed','failed','adopted','rolledBack')),
  candidate_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (proposal_id, base_policy_digest, policy_digest),
  CHECK (candidate_json->>'policyDigest' = policy_digest),
  CHECK (candidate_json->>'basePolicyDigest' = base_policy_digest),
  CHECK (candidate_json->>'status' = status)
);

CREATE TABLE evolution_probes (
  id text PRIMARY KEY,
  candidate_id text NOT NULL REFERENCES evolution_candidates(id),
  probe_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  CHECK (probe_json->>'fixtureVersion' = 'asset-retrieval-probe/1'),
  CHECK (probe_json->>'candidateId' = candidate_id),
  CHECK ((probe_json->>'modelCalls')::integer = 0)
);
CREATE INDEX evolution_probes_candidate_created ON evolution_probes(candidate_id, created_at DESC);

CREATE TABLE evolution_registry (
  domain text PRIMARY KEY CHECK (domain = 'AssetRetrievalPolicy'),
  policy_json jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  reason text NOT NULL,
  CHECK (policy_json->>'schemaVersion' = 'asset-retrieval-policy/1')
);

CREATE TABLE evolution_registry_events (
  id text PRIMARY KEY,
  domain text NOT NULL CHECK (domain = 'AssetRetrievalPolicy'),
  revision integer NOT NULL CHECK (revision > 0),
  event_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (domain, revision),
  CHECK (event_json->>'revision' = revision::text),
  CHECK (event_json->>'action' IN ('adopt','rollback'))
);

CREATE OR REPLACE FUNCTION reject_evolution_immutable_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable evolution record: %', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER evolution_evidence_immutable
BEFORE UPDATE OR DELETE ON evolution_evidence
FOR EACH ROW EXECUTE FUNCTION reject_evolution_immutable_change();
CREATE TRIGGER evolution_probes_immutable
BEFORE UPDATE OR DELETE ON evolution_probes
FOR EACH ROW EXECUTE FUNCTION reject_evolution_immutable_change();
CREATE TRIGGER evolution_registry_events_immutable
BEFORE UPDATE OR DELETE ON evolution_registry_events
FOR EACH ROW EXECUTE FUNCTION reject_evolution_immutable_change();

COMMIT;
