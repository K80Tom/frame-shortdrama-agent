-- Persist the paid model response payload so a validation failure can be
-- post-mortemed from the ledger without re-paying for the same call.
-- request payloads stay digest-only (reconstructable from prompt + script);
-- responses are the irreproducible paid artifact.

ALTER TABLE model_calls ADD COLUMN IF NOT EXISTS response_json JSONB NULL;
