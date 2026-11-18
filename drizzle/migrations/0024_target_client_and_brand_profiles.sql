-- Target client + brand cache.
--
-- The company we are pitching is stored per conversation and is NOT an evidence
-- scope: it is never used as a retrieval filter. Its optional brand profile (the
-- client's logo, colours and fonts) is cached per domain so a re-export does not
-- re-scrape their site.
CREATE TABLE IF NOT EXISTS public.brand_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain text NOT NULL UNIQUE,
  profile jsonb NOT NULL,
  confidence numeric(3, 2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS brand_profiles_updated_idx
  ON public.brand_profiles (updated_at DESC);

GRANT SELECT, INSERT, UPDATE ON public.brand_profiles TO authenticated;
GRANT ALL ON public.brand_profiles TO service_role;

ALTER TABLE public.brand_profiles ENABLE ROW LEVEL SECURITY;

-- A brand profile is public marketing data scraped from a public website, so the
-- cache is shared: any allowed user may read it, and may refresh it. No user
-- identity or private data is stored here.
DROP POLICY IF EXISTS "Allowed users read the brand cache" ON public.brand_profiles;
CREATE POLICY "Allowed users read the brand cache" ON public.brand_profiles FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Allowed users add to the brand cache" ON public.brand_profiles;
CREATE POLICY "Allowed users add to the brand cache" ON public.brand_profiles FOR INSERT TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "Allowed users refresh the brand cache" ON public.brand_profiles;
CREATE POLICY "Allowed users refresh the brand cache" ON public.brand_profiles FOR UPDATE TO authenticated
  USING (true) WITH CHECK (true);

-- Who we are pitching: { name, websiteUrl, industry, brandProfileId, overrides,
-- anonymise, parties[] }. Null for a conversation that never named a client.
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS target_client jsonb;
