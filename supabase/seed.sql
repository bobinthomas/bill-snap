-- Dev seed (SCAFFOLDING_PLAN.md §2): one owner business + sample transactions.
-- Safe to re-run: everything is keyed and idempotent.

insert into businesses (id, name, abn, timezone, gst_registered, auto_save)
values (
  '11111111-1111-4111-8111-111111111111',
  'My Business',
  '51 824 753 556',
  'Australia/Sydney',
  true,
  true
)
on conflict (id) do nothing;

insert into users (phone_number, business_id)
values ('61400000000', '11111111-1111-4111-8111-111111111111')
on conflict (phone_number) do nothing;

insert into memberships (business_id, user_phone, role)
values ('11111111-1111-4111-8111-111111111111', '61400000000', 'owner')
on conflict (business_id, user_phone) do nothing;

insert into transactions (
  business_id, user_phone, type, amount, gst, category, vendor, abn,
  invoice_number, status, flow_state, wa_message_id, wa_received_at, confirmed_at
) values
  (
    '11111111-1111-4111-8111-111111111111', '61400000000', 'outgoing', 245.00, 22.27,
    'utilities', 'Telstra', '51 824 753 556', 'INV-2026-001',
    'logged', null, 'wamid.seed.1', now() - interval '2 days', now() - interval '2 days'
  ),
  (
    '11111111-1111-4111-8111-111111111111', '61400000000', 'outgoing', 500.00, null,
    'wages', 'Rajesh', null, null,
    'logged', null, 'wamid.seed.2', now() - interval '1 day', now() - interval '1 day'
  )
on conflict do nothing;
