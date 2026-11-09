-- 估价确认卡的展示明细：预计耗时与费用构成。
-- 仅用于人工确认前的展示与审计，不参与计价；
-- 计价事实仍以 estimate_cost_micros / budget_micros 与冻结价格表为准。
ALTER TABLE assistant_quotes
  ADD COLUMN IF NOT EXISTS estimated_duration_sec integer,
  ADD COLUMN IF NOT EXISTS cost_breakdown_json jsonb NOT NULL DEFAULT '[]'::jsonb;
