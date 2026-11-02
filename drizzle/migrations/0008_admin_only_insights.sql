CREATE OR REPLACE FUNCTION public.activity_summary(_days integer DEFAULT 30) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE cutoff timestamptz; report jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_allowed_email(auth.jwt()->>'email') OR NOT public.is_content_admin() THEN RAISE EXCEPTION 'Administrator access required' USING ERRCODE='42501'; END IF;
 IF _days NOT IN (7,30,90) THEN RAISE EXCEPTION 'Invalid date range'; END IF;
 cutoff := now() - make_interval(days=>_days);
 SELECT jsonb_build_object('opens',count(*) FILTER (WHERE event_type='file_open'), 'views',count(*) FILTER (WHERE event_type='industry_view'), 'people',count(DISTINCT user_id)) INTO report FROM public.activity_events WHERE created_at>=cutoff;
 report := report || jsonb_build_object('files', coalesce((SELECT jsonb_agg(to_jsonb(t)) FROM (SELECT content_id, count(*) AS count, count(DISTINCT user_id) AS people FROM public.activity_events WHERE created_at>=cutoff AND event_type='file_open' GROUP BY content_id ORDER BY count(*) DESC LIMIT 15) t),'[]'::jsonb));
 report := report || jsonb_build_object('industries', coalesce((SELECT jsonb_agg(to_jsonb(t)) FROM (SELECT industry, count(*) AS count, count(DISTINCT user_id) AS people FROM public.activity_events WHERE created_at>=cutoff AND event_type='industry_view' GROUP BY industry ORDER BY count(*) DESC) t),'[]'::jsonb));
 report := report || jsonb_build_object('recent', coalesce((SELECT jsonb_agg(to_jsonb(t)) FROM (SELECT id, user_email, event_type, industry, content_id, created_at FROM public.activity_events WHERE created_at>=cutoff AND (user_id=auth.uid() OR public.is_content_admin()) ORDER BY created_at DESC LIMIT 50) t),'[]'::jsonb));
 RETURN report;
END; $$;
REVOKE ALL ON FUNCTION public.activity_summary(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.activity_summary(integer) TO authenticated, service_role;