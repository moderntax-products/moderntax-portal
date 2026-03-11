-- ============================================================
-- Expert Management System Migration
-- Adds expert role, assignment tracking, and SLA monitoring
-- ============================================================

-- 1. Expand profiles role CHECK to include 'expert'
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_role_check;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('processor', 'manager', 'admin', 'expert'));

-- 2. Create expert_assignments table
CREATE TABLE public.expert_assignments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity_id UUID NOT NULL REFERENCES public.request_entities(id) ON DELETE CASCADE,
  expert_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  assigned_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  sla_deadline TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  sla_met BOOLEAN,
  status TEXT NOT NULL DEFAULT 'assigned' CHECK (
    status IN ('assigned', 'in_progress', 'completed', 'failed', 'reassigned')
  ),
  miss_reason TEXT,
  expert_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Indexes
CREATE INDEX idx_expert_assignments_expert_id ON public.expert_assignments(expert_id);
CREATE INDEX idx_expert_assignments_entity_id ON public.expert_assignments(entity_id);
CREATE INDEX idx_expert_assignments_status ON public.expert_assignments(status);
CREATE INDEX idx_expert_assignments_sla_deadline ON public.expert_assignments(sla_deadline);
CREATE INDEX idx_expert_assignments_assigned_at ON public.expert_assignments(assigned_at DESC);

-- 4. Enable RLS
ALTER TABLE public.expert_assignments ENABLE ROW LEVEL SECURITY;

-- 5. RLS Policies for expert_assignments
CREATE POLICY "Admins can read all expert assignments"
  ON public.expert_assignments
  FOR SELECT USING (public.get_my_role() = 'admin');

CREATE POLICY "Experts can read own assignments"
  ON public.expert_assignments
  FOR SELECT USING (expert_id = auth.uid());

CREATE POLICY "Admins can insert expert assignments"
  ON public.expert_assignments
  FOR INSERT WITH CHECK (public.get_my_role() = 'admin');

CREATE POLICY "Experts can update own assignments"
  ON public.expert_assignments
  FOR UPDATE USING (expert_id = auth.uid());

CREATE POLICY "Admins can update any assignment"
  ON public.expert_assignments
  FOR UPDATE USING (public.get_my_role() = 'admin');

-- 6. Experts can read request_entities they are assigned to
CREATE POLICY "Experts can read assigned entities"
  ON public.request_entities
  FOR SELECT USING (
    public.get_my_role() = 'expert' AND
    id IN (
      SELECT ea.entity_id FROM public.expert_assignments ea
      WHERE ea.expert_id = auth.uid()
      AND ea.status IN ('assigned', 'in_progress')
    )
  );

CREATE POLICY "Experts can update assigned entities"
  ON public.request_entities
  FOR UPDATE USING (
    public.get_my_role() = 'expert' AND
    id IN (
      SELECT ea.entity_id FROM public.expert_assignments ea
      WHERE ea.expert_id = auth.uid()
      AND ea.status IN ('assigned', 'in_progress')
    )
  );

-- 7. Experts can read requests that contain their assigned entities
CREATE POLICY "Experts can read requests with assigned entities"
  ON public.requests
  FOR SELECT USING (
    public.get_my_role() = 'expert' AND
    id IN (
      SELECT re.request_id FROM public.request_entities re
      JOIN public.expert_assignments ea ON ea.entity_id = re.id
      WHERE ea.expert_id = auth.uid()
      AND ea.status IN ('assigned', 'in_progress')
    )
  );

-- 8. Auto-update updated_at trigger
CREATE TRIGGER update_expert_assignments_updated_at
  BEFORE UPDATE ON public.expert_assignments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- 9. Expand notifications type CHECK
ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;

ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'confirmation', 'completion', 'nudge', 'batch_complete',
    'expert_assigned', 'expert_completed', 'expert_issue', 'sla_warning'
  ));

-- 10. Add text/html to uploads bucket allowed MIME types
UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/pdf',
  'text/html'
]
WHERE id = 'uploads';
