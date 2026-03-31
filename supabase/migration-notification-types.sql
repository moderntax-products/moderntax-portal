-- ============================================================
-- Expand notification types for admin daily summary and
-- manager weekly summary
-- ============================================================

ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'confirmation', 'completion', 'nudge', 'batch_complete',
    'expert_assigned', 'expert_completed', 'expert_issue', 'sla_warning',
    'admin_daily_summary', 'manager_weekly_summary'
  ));
