-- ============================================================
-- SOC 2 AUDIT LOGGING
-- Tracks all security-relevant user actions for compliance
-- ============================================================

-- Audit log table
CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id),
  user_email TEXT,
  action TEXT NOT NULL,
  resource_type TEXT, -- 'request', 'entity', 'batch', 'profile', 'auth'
  resource_id TEXT,
  details JSONB DEFAULT '{}',
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Index for querying by user and time
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, resource_id);

-- Enable RLS
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Only admins can read audit logs
CREATE POLICY "Admins can read audit logs"
  ON audit_logs FOR SELECT
  USING (get_my_role() = 'admin');

-- Service role can insert (used by API routes)
-- Regular users cannot read or modify audit logs
CREATE POLICY "Service role inserts audit logs"
  ON audit_logs FOR INSERT
  WITH CHECK (true);

-- Prevent deletion of audit logs (immutability for SOC 2)
-- No DELETE or UPDATE policies — logs are append-only

COMMENT ON TABLE audit_logs IS 'SOC 2 compliant audit trail. Append-only log of all security-relevant user actions.';
