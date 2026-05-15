-- ERC Check Reissue tracking
-- 2026-05-15 — Productizing the Mento $68K returned-checks workflow.
-- One row per individual returned check. Lifecycle tracked from
-- intake → IRS trace → reissue mailed → check received.

-- Intake metadata lives on request_entities so a single token gates
-- all reissues for the engagement.
ALTER TABLE request_entities ADD COLUMN IF NOT EXISTS erc_intake_token TEXT;
ALTER TABLE request_entities ADD COLUMN IF NOT EXISTS erc_intake_data JSONB;
ALTER TABLE request_entities ADD COLUMN IF NOT EXISTS erc_intake_submitted_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_request_entities_erc_intake_token
  ON request_entities (erc_intake_token)
  WHERE erc_intake_token IS NOT NULL;

-- Per-check tracking
CREATE TABLE IF NOT EXISTS erc_check_reissues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES request_entities(id) ON DELETE CASCADE,

  -- Check identification (set at engagement creation)
  tax_quarter TEXT NOT NULL,                            -- "2021-Q3"
  tax_period_end_date DATE,                             -- 2021-09-30
  form_type TEXT NOT NULL DEFAULT '941',
  original_check_amount NUMERIC(12, 2) NOT NULL,
  original_check_issued_date DATE,
  original_check_status TEXT NOT NULL DEFAULT 'returned_to_irs',

  -- Set during merchant intake (Box 1 = didn't receive; Box 3 = received, lost/destroyed)
  certification_box SMALLINT,

  -- Lifecycle status
  filing_status TEXT NOT NULL DEFAULT 'awaiting_intake',
  -- enum-ish: awaiting_intake | awaiting_payment | intake_complete
  --        | expert_assigned | irs_contact_in_progress | trace_filed
  --        | irs_verifying | check_in_mail | check_received | closed

  -- Expert workflow fields (populated as the case progresses)
  expert_id UUID REFERENCES profiles(id),
  filing_method TEXT,                                   -- phone | fax_ogden | fax_cincinnati | mail
  irs_trace_filed_at TIMESTAMPTZ,
  irs_trace_confirmation_number TEXT,
  irs_agent_name TEXT,
  expected_check_arrival_date DATE,
  check_received_at TIMESTAMPTZ,

  -- Append-only audit trail: [{status, changed_at, changed_by, note_internal, note_merchant_visible}]
  status_history JSONB NOT NULL DEFAULT '[]'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_erc_check_reissues_entity ON erc_check_reissues (entity_id);
CREATE INDEX IF NOT EXISTS idx_erc_check_reissues_status ON erc_check_reissues (filing_status);

-- updated_at trigger
CREATE OR REPLACE FUNCTION trg_erc_check_reissues_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS erc_check_reissues_updated_at ON erc_check_reissues;
CREATE TRIGGER erc_check_reissues_updated_at
  BEFORE UPDATE ON erc_check_reissues
  FOR EACH ROW EXECUTE FUNCTION trg_erc_check_reissues_updated_at();
