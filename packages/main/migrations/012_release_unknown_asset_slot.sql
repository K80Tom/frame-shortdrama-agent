-- An unknown submission may already have consumed provider credits. Its
-- unique job_key remains permanently idempotent and it can only be reconciled,
-- never resubmitted. It no longer prevents unrelated jobs from using the
-- single active generation/import slot.
DROP INDEX desktop_asset_single_active;

CREATE UNIQUE INDEX desktop_asset_single_active ON desktop_asset_jobs ((true))
  WHERE status IN ('queued','submitting','generating','importing');
