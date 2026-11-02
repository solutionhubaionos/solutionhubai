-- Private buckets used by the app. Existing buckets are left untouched.
insert into storage.buckets (id, name, public, file_size_limit)
values
  ('content', 'content', false, 1073741824),
  ('industry-images', 'industry-images', false, 10485760)
on conflict (id) do nothing;
