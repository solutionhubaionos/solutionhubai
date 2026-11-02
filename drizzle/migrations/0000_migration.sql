CREATE OR REPLACE FUNCTION public.is_allowed_email(_email text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT lower(split_part(coalesce(_email,''), '@', 2)) IN
    ('aionos.ai','whilter.ai','inetum.com','cloudanalogy.com','perpetuuitiaionos.com');
$$;

CREATE OR REPLACE FUNCTION public.enforce_allowed_domain()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_allowed_email(NEW.email) THEN
    RAISE EXCEPTION 'Email domain not allowed';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER enforce_allowed_domain_trg
BEFORE INSERT OR UPDATE OF email ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.enforce_allowed_domain();

CREATE TABLE public.content_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  industry text NOT NULL,
  customer_name text,
  title text NOT NULL,
  solution text,
  description text,
  content_type text NOT NULL DEFAULT 'other',
  file_path text NOT NULL,
  file_name text NOT NULL,
  mime_type text,
  file_size bigint,
  uploaded_by uuid NOT NULL DEFAULT auth.uid(),
  uploader_email text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON public.content_items (industry);
CREATE INDEX ON public.content_items (lower(customer_name));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.content_items TO authenticated;
GRANT ALL ON public.content_items TO service_role;
ALTER TABLE public.content_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allowed users read content" ON public.content_items FOR SELECT TO authenticated
  USING (public.is_allowed_email(auth.jwt()->>'email'));
CREATE POLICY "Allowed users add content" ON public.content_items FOR INSERT TO authenticated
  WITH CHECK (public.is_allowed_email(auth.jwt()->>'email') AND uploaded_by = auth.uid());
CREATE POLICY "Owners update content" ON public.content_items FOR UPDATE TO authenticated
  USING (uploaded_by = auth.uid());
CREATE POLICY "Owners delete content" ON public.content_items FOR DELETE TO authenticated
  USING (uploaded_by = auth.uid());