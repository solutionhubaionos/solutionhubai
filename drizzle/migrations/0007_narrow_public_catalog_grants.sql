REVOKE ALL ON public.request_quotas FROM anon, authenticated;
GRANT ALL ON public.request_quotas TO service_role;
REVOKE SELECT ON public.industries FROM anon;
GRANT SELECT(slug,name,tagline,image_url) ON public.industries TO anon;
COMMENT ON TABLE public.request_quotas IS 'Private abuse counters: never readable by app users; no raw email addresses are stored.';