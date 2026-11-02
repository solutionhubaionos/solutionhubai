CREATE TABLE public.request_quotas (key text PRIMARY KEY, window_start timestamptz NOT NULL, requests integer NOT NULL DEFAULT 0);
GRANT ALL ON public.request_quotas TO service_role;
ALTER TABLE public.request_quotas ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION public.consume_request_quota(_kind text, _subject text, _network text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE keys text[]; limits integer[]; window_time timestamptz; i integer; count_now integer;
BEGIN
 IF _kind = 'password' THEN
  keys := ARRAY['password:email:' || _subject, 'password:network:' || _network, 'password:global']; limits := ARRAY[1, 10, 100]; window_time := date_trunc('minute', now());
 ELSIF _kind = 'industry-image' THEN
  keys := ARRAY['image:user:' || _subject, 'image:global']; limits := ARRAY[3, 20]; window_time := date_trunc('hour', now());
 ELSE RAISE EXCEPTION 'Invalid quota'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(_kind, 0));
 FOR i IN 1..array_length(keys, 1) LOOP
  SELECT CASE WHEN window_start = window_time THEN requests ELSE 0 END INTO count_now FROM public.request_quotas WHERE key = keys[i];
  IF coalesce(count_now, 0) >= limits[i] THEN RETURN false; END IF;
 END LOOP;
 FOR i IN 1..array_length(keys, 1) LOOP
  INSERT INTO public.request_quotas(key, window_start, requests) VALUES(keys[i], window_time, 1) ON CONFLICT(key) DO UPDATE SET requests = CASE WHEN request_quotas.window_start = window_time THEN request_quotas.requests + 1 ELSE 1 END, window_start = window_time;
 END LOOP;
 RETURN true;
END; $$;
REVOKE ALL ON FUNCTION public.consume_request_quota(text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_request_quota(text,text,text) TO service_role;
DROP POLICY "Allowed users read activity" ON public.activity_events;
CREATE POLICY "Users read own activity and admins read team activity" ON public.activity_events FOR SELECT TO authenticated USING (public.is_allowed_email(auth.jwt()->>'email') AND (user_id = auth.uid() OR public.is_content_admin()));
CREATE INDEX activity_user_date_idx ON public.activity_events(user_id, created_at DESC);
CREATE FUNCTION public.validate_activity_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_allowed_email(auth.jwt()->>'email') THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE='42501'; END IF;
 IF NEW.user_id <> auth.uid() THEN RAISE EXCEPTION 'Cannot log another user' USING ERRCODE='42501'; END IF;
 NEW.user_email := auth.jwt()->>'email'; NEW.created_at := now();
 IF NEW.event_type = 'file_open' THEN
  IF NEW.content_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.content_items WHERE id=NEW.content_id AND industry=NEW.industry) THEN RAISE EXCEPTION 'Invalid content'; END IF;
 ELSIF NEW.event_type = 'industry_view' THEN
  IF NEW.content_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.industries WHERE slug=NEW.industry) THEN RAISE EXCEPTION 'Invalid industry'; END IF;
 ELSE RAISE EXCEPTION 'Invalid event'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(auth.uid()::text, 1));
 IF (SELECT count(*) FROM public.activity_events WHERE user_id=auth.uid() AND created_at > now()-interval '1 minute') >= 60 THEN RAISE EXCEPTION 'Activity limit reached'; END IF;
 RETURN NEW;
END; $$;
REVOKE ALL ON FUNCTION public.validate_activity_event() FROM PUBLIC;
CREATE TRIGGER validate_activity_before_insert BEFORE INSERT ON public.activity_events FOR EACH ROW EXECUTE FUNCTION public.validate_activity_event();
CREATE FUNCTION public.activity_summary(_days integer DEFAULT 30) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE cutoff timestamptz; report jsonb;
BEGIN
 IF auth.uid() IS NULL OR NOT public.is_allowed_email(auth.jwt()->>'email') THEN RAISE EXCEPTION 'Unauthorized' USING ERRCODE='42501'; END IF;
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