CREATE TABLE public.activity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  user_email text,
  event_type text NOT NULL CHECK (event_type IN ('file_open','industry_view')),
  industry text,
  content_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON public.activity_events (created_at DESC);
CREATE INDEX ON public.activity_events (content_id);
GRANT SELECT, INSERT ON public.activity_events TO authenticated;
GRANT ALL ON public.activity_events TO service_role;
ALTER TABLE public.activity_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allowed users read activity" ON public.activity_events FOR SELECT TO authenticated
  USING (public.is_allowed_email(auth.jwt()->>'email'));
CREATE POLICY "Users log own activity" ON public.activity_events FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.is_allowed_email(auth.jwt()->>'email') AND user_email = auth.jwt()->>'email');