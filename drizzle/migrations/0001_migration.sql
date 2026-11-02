CREATE POLICY "Allowed users read content files" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'content' AND public.is_allowed_email(auth.jwt()->>'email'));
CREATE POLICY "Allowed users upload content files" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'content' AND public.is_allowed_email(auth.jwt()->>'email') AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "Owners delete content files" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'content' AND (storage.foldername(name))[1] = auth.uid()::text);