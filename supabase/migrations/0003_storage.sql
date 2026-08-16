-- Storage (§5.5). Bucket `bills`: public read (Gemini extraction, accountant
-- export), organised by business_id/YYYY/MM/filename.jpg so share links and
-- multi-user access are trivially scoped.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'bills',
  'bills',
  true,                                 -- public read; writes stay authenticated (§5.5)
  10485760,                             -- 10 MB cap (Gemini request-payload guard)
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']
)
on conflict (id) do nothing;

-- Write access: authenticated users may upload only under their own phone's
-- business folder; the service-role key (Worker) is unrestricted either way.
create policy "bills_authenticated_write" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'bills'
    and (storage.foldername(name))[1] = (
      select business_id::text from users where phone_number = app.current_phone()
    )
  );

create policy "bills_public_read" on storage.objects
  for select using (bucket_id = 'bills');
