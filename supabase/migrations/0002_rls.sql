-- RLS (§7.3). The Worker uses the service-role key (bypasses RLS, §7.2/7.3);
-- these policies guard any direct client access (future accountant portal/web).
-- The phone number of the calling user is carried in the JWT claim
-- `phone_number`, read via the helper below.

create schema if not exists app;

create or replace function app.current_phone() returns text
  language sql stable security definer
  set search_path = public
as $$
  select coalesce(
    current_setting('request.jwt.claims', true)::jsonb ->> 'phone_number',
    ''
  );
$$;

-- ------------------------------------------------------------------ users
alter table users enable row level security;

create policy users_own_select on users
  for select using (phone_number = app.current_phone());

create policy users_own_update on users
  for update using (phone_number = app.current_phone());

-- ------------------------------------------------------------- businesses
alter table businesses enable row level security;

-- Owner members can read their business; staff need it too (routing, GST flag).
create policy businesses_member_select on businesses
  for select using (
    exists (
      select 1 from memberships m
      where m.business_id = businesses.id
        and m.user_phone = app.current_phone()
    )
  );

-- ----------------------------------------------------------- memberships
alter table memberships enable row level security;

create policy memberships_own_select on memberships
  for select using (user_phone = app.current_phone());

create policy memberships_owner_update on memberships
  for update using (
    exists (
      select 1 from memberships owner_m
      where owner_m.business_id = memberships.business_id
        and owner_m.user_phone = app.current_phone()
        and owner_m.role = 'owner'
    )
  );

-- ----------------------------------------------------------- share_links
alter table share_links enable row level security;

-- Owner members manage links; token holders get read access (F12, Phase 3) via
-- the authenticated role's `share_token` claim.
create policy share_links_owner_select on share_links
  for select using (
    exists (
      select 1 from memberships m
      where m.business_id = share_links.business_id
        and m.user_phone = app.current_phone()
        and m.role = 'owner'
    )
  );

-- --------------------------------------------------------- transactions
alter table transactions enable row level security;

-- Staff read/write their own rows; owner members read all rows for the business.
create policy transactions_own_all on transactions
  for all using (user_phone = app.current_phone());

create policy transactions_owner_select on transactions
  for select using (
    exists (
      select 1 from memberships m
      where m.business_id = transactions.business_id
        and m.user_phone = app.current_phone()
        and m.role = 'owner'
    )
  );
