CREATE TYPE public.app_role AS ENUM ('admin', 'member');
CREATE TABLE public.user_roles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 role public.app_role NOT NULL DEFAULT 'member',
 UNIQUE(user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own roles" ON public.user_roles FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
 SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$$;
REVOKE ALL ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;
CREATE FUNCTION public.is_content_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
 SELECT public.is_allowed_email(auth.jwt()->>'email') AND public.has_role(auth.uid(), 'admin');
$$;
REVOKE ALL ON FUNCTION public.is_content_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_content_admin() TO authenticated, service_role;
CREATE FUNCTION public.assign_solution_hub_role() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
 INSERT INTO public.user_roles(user_id, role) VALUES (NEW.id, 'member') ON CONFLICT DO NOTHING;
 IF NEW.email_confirmed_at IS NOT NULL AND lower(NEW.email) = 'arjun.nagulapally@aionos.ai' THEN
  INSERT INTO public.user_roles(user_id, role) VALUES (NEW.id, 'admin') ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.assign_solution_hub_role() FROM PUBLIC;
CREATE TRIGGER solution_hub_assign_role_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.assign_solution_hub_role();
CREATE TRIGGER solution_hub_assign_role_verified AFTER UPDATE OF email_confirmed_at ON auth.users FOR EACH ROW WHEN (OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL) EXECUTE FUNCTION public.assign_solution_hub_role();
INSERT INTO public.user_roles(user_id, role) SELECT id, 'member'::public.app_role FROM auth.users ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) SELECT id, 'admin'::public.app_role FROM auth.users WHERE lower(email) = 'arjun.nagulapally@aionos.ai' AND email_confirmed_at IS NOT NULL ON CONFLICT DO NOTHING;
CREATE POLICY "Admins update all content" ON public.content_items FOR UPDATE TO authenticated USING (public.is_content_admin()) WITH CHECK (public.is_content_admin());
CREATE POLICY "Admins delete all content" ON public.content_items FOR DELETE TO authenticated USING (public.is_content_admin());
CREATE POLICY "Admins delete content files" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'content' AND public.is_content_admin());
CREATE FUNCTION public.manage_company(_industry text, _name text, _new_name text DEFAULT NULL, _delete boolean DEFAULT false) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE cleaned text;
BEGIN
 IF NOT public.is_content_admin() THEN RAISE EXCEPTION 'Only admins can manage companies' USING ERRCODE = '42501'; END IF;
 PERFORM 1 FROM public.industries WHERE slug = _industry FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Industry not found'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.customers WHERE industry = _industry AND lower(name) = lower(_name)) AND NOT EXISTS (SELECT 1 FROM public.content_items WHERE industry = _industry AND lower(customer_name) = lower(_name)) THEN RAISE EXCEPTION 'Company not found'; END IF;
 IF _delete THEN
  UPDATE public.content_items SET customer_name = NULL WHERE industry = _industry AND lower(customer_name) = lower(_name);
  DELETE FROM public.customers WHERE industry = _industry AND lower(name) = lower(_name);
 ELSE
  cleaned := regexp_replace(btrim(_new_name), '\s+', ' ', 'g');
  IF cleaned IS NULL OR length(cleaned) < 2 OR length(cleaned) > 80 THEN RAISE EXCEPTION 'Company name must be 2–80 characters'; END IF;
  IF lower(cleaned) <> lower(_name) AND (EXISTS (SELECT 1 FROM public.customers WHERE industry = _industry AND lower(name) = lower(cleaned)) OR EXISTS (SELECT 1 FROM public.content_items WHERE industry = _industry AND lower(customer_name) = lower(cleaned))) THEN RAISE EXCEPTION 'That company already exists here'; END IF;
  UPDATE public.customers SET name = cleaned WHERE industry = _industry AND lower(name) = lower(_name);
  IF NOT FOUND THEN INSERT INTO public.customers(industry, name, created_by) VALUES (_industry, cleaned, auth.uid()); END IF;
  UPDATE public.content_items SET customer_name = cleaned WHERE industry = _industry AND lower(customer_name) = lower(_name);
 END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.manage_company(text,text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.manage_company(text,text,text,boolean) TO authenticated;