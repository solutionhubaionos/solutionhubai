CREATE TABLE public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  industry text NOT NULL,
  name text NOT NULL,
  created_by uuid NOT NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX customers_industry_name_uq ON public.customers (industry, lower(name));
GRANT SELECT, INSERT, DELETE ON public.customers TO authenticated;
GRANT ALL ON public.customers TO service_role;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allowed users read customers" ON public.customers FOR SELECT TO authenticated
  USING (public.is_allowed_email(auth.jwt()->>'email'));
CREATE POLICY "Allowed users add customers" ON public.customers FOR INSERT TO authenticated
  WITH CHECK (public.is_allowed_email(auth.jwt()->>'email') AND created_by = auth.uid());
CREATE POLICY "Creators delete customers" ON public.customers FOR DELETE TO authenticated
  USING (created_by = auth.uid());