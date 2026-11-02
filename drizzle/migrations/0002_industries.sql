CREATE TABLE public.industries (
  slug text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  tagline text,
  image_url text,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.industries TO anon;
GRANT SELECT, INSERT, UPDATE ON public.industries TO authenticated;
GRANT ALL ON public.industries TO service_role;
ALTER TABLE public.industries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can view industries" ON public.industries FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Allowed users add industries" ON public.industries FOR INSERT TO authenticated
  WITH CHECK (public.is_allowed_email(auth.jwt()->>'email') AND created_by = auth.uid());
INSERT INTO public.industries (slug, name, tagline, created_by) VALUES
 ('airlines','Airlines','Passenger experience, ops & loyalty',NULL),
 ('airports','Airports','Terminal operations & smart flows',NULL),
 ('bfsi','BFSI','Banking, financial services & insurance',NULL),
 ('hospitality','Hospitality','Guest journeys & property tech',NULL),
 ('logistics','Logistics','Supply chain, ports & fleet',NULL),
 ('manufacturing','Manufacturing','Smart factory & Industry 4.0',NULL),
 ('retail','Retail','Omnichannel commerce & CX',NULL),
 ('telecom','Telecom','Networks, 5G & subscriber CX',NULL);