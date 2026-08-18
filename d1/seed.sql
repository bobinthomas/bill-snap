-- BillSnap D1 demo seed (npm run db:seed).
--
-- Seeds the demo phone (61400000111) with the six sample bills the dashboard's
-- ✨ Seed button logs — but directly into D1 via `wrangler d1 execute --file`,
-- so a fresh local database has dashboard data with no UI click:
--
--     npm run db:seed               # local  (miniflare SQLite)
--     npm run db:seed:remote        # production D1
--
-- The raw_extraction JSON below is byte-for-byte what the real extraction
-- pipeline produces for each typed seed line (captured from
-- createExtractionService.run({ text })), so the dashboard renders the same
-- amount/vendor/category/GST as a bill confirmed through the demo.
--
-- Idempotent: the first statement deletes only THIS seed's rows (wa_message_id
-- prefix wamid.seed-d1.*), so re-running resets the demo dataset to exactly
-- these six bills while leaving user-confirmed bills (wamid.demo.*, the UI
-- seed's wamid.seed.*) untouched. The business/user/membership inserts are
-- `insert or ignore` — a no-op once they exist.

delete from transactions
  where user_phone = '61400000111' and wa_message_id like 'wamid.seed-d1.%';

insert or ignore into businesses (id, name, timezone, gst_registered, auto_save)
  values ('00000000-0000-4000-8000-000000000001', 'My Business', 'Australia/Sydney', 1, 1);

insert or ignore into users (phone_number, business_id)
  values ('61400000111', '00000000-0000-4000-8000-000000000001');

insert or ignore into memberships (id, business_id, user_phone, role)
  values ('seed-owner-membership', '00000000-0000-4000-8000-000000000001', '61400000111', 'owner');

-- 1. wages 500 rajesh (GST n/a)
insert into transactions (
  id, business_id, user_phone, type, amount, gst, category, vendor, abn,
  invoice_number, due_date, image_urls, raw_extraction, gate_level,
  machine_read, auto_logged, status, flow_state, flow_expires_at,
  wa_message_id, confirmed_at
) values (
  'seed-d1-1', '00000000-0000-4000-8000-000000000001', '61400000111', 'outgoing',
  500, null, 'wages', 'rajesh', null, null, null, '[]',
  '{"amount":{"value":500,"confidence":1},"date":{"value":null,"confidence":0},"vendor":{"value":"rajesh","confidence":1},"vendor_resolved_to":{"value":null,"confidence":0},"abn":{"value":null,"confidence":0},"gst":{"value":null,"confidence":0},"gst_basis":"none","invoice_number":{"value":null,"confidence":0},"due_date":{"value":null,"confidence":0},"category_hint":{"value":"wages","confidence":1}}',
  'partial', 1, 0, 'logged', null, null,
  'wamid.seed-d1.1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-6 days')
);

-- 2. rent 2200 homebase (GST n/a)
insert into transactions (
  id, business_id, user_phone, type, amount, gst, category, vendor, abn,
  invoice_number, due_date, image_urls, raw_extraction, gate_level,
  machine_read, auto_logged, status, flow_state, flow_expires_at,
  wa_message_id, confirmed_at
) values (
  'seed-d1-2', '00000000-0000-4000-8000-000000000001', '61400000111', 'outgoing',
  2200, null, 'rent', 'homebase', null, null, null, '[]',
  '{"amount":{"value":2200,"confidence":1},"date":{"value":null,"confidence":0},"vendor":{"value":"homebase","confidence":1},"vendor_resolved_to":{"value":null,"confidence":0},"abn":{"value":null,"confidence":0},"gst":{"value":null,"confidence":0},"gst_basis":"none","invoice_number":{"value":null,"confidence":0},"due_date":{"value":null,"confidence":0},"category_hint":{"value":"rent","confidence":1}}',
  'partial', 1, 0, 'logged', null, null,
  'wamid.seed-d1.2', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 days')
);

-- 3. internet 100 telstra gst (GST-exclusive → $10.00)
insert into transactions (
  id, business_id, user_phone, type, amount, gst, category, vendor, abn,
  invoice_number, due_date, image_urls, raw_extraction, gate_level,
  machine_read, auto_logged, status, flow_state, flow_expires_at,
  wa_message_id, confirmed_at
) values (
  'seed-d1-3', '00000000-0000-4000-8000-000000000001', '61400000111', 'outgoing',
  100, 10, 'utilities', 'telstra', null, null, null, '[]',
  '{"amount":{"value":100,"confidence":1},"date":{"value":null,"confidence":0},"vendor":{"value":"telstra","confidence":1},"vendor_resolved_to":{"value":null,"confidence":0},"abn":{"value":null,"confidence":0},"gst":{"value":10,"confidence":1},"gst_basis":"exclusive","invoice_number":{"value":null,"confidence":0},"due_date":{"value":null,"confidence":0},"category_hint":{"value":"utilities","confidence":1}}',
  'partial', 1, 0, 'logged', null, null,
  'wamid.seed-d1.3', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-4 days')
);

-- 4. electricity 340 origin gst (GST-exclusive → $34.00)
insert into transactions (
  id, business_id, user_phone, type, amount, gst, category, vendor, abn,
  invoice_number, due_date, image_urls, raw_extraction, gate_level,
  machine_read, auto_logged, status, flow_state, flow_expires_at,
  wa_message_id, confirmed_at
) values (
  'seed-d1-4', '00000000-0000-4000-8000-000000000001', '61400000111', 'outgoing',
  340, 34, 'utilities', 'origin', null, null, null, '[]',
  '{"amount":{"value":340,"confidence":1},"date":{"value":null,"confidence":0},"vendor":{"value":"origin","confidence":1},"vendor_resolved_to":{"value":null,"confidence":0},"abn":{"value":null,"confidence":0},"gst":{"value":34,"confidence":1},"gst_basis":"exclusive","invoice_number":{"value":null,"confidence":0},"due_date":{"value":null,"confidence":0},"category_hint":{"value":"utilities","confidence":1}}',
  'partial', 1, 0, 'logged', null, null,
  'wamid.seed-d1.4', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days')
);

-- 5. supplies 145 officeworks gst (GST-exclusive → $14.50)
insert into transactions (
  id, business_id, user_phone, type, amount, gst, category, vendor, abn,
  invoice_number, due_date, image_urls, raw_extraction, gate_level,
  machine_read, auto_logged, status, flow_state, flow_expires_at,
  wa_message_id, confirmed_at
) values (
  'seed-d1-5', '00000000-0000-4000-8000-000000000001', '61400000111', 'outgoing',
  145, 14.5, 'inventory', 'officeworks', null, null, null, '[]',
  '{"amount":{"value":145,"confidence":1},"date":{"value":null,"confidence":0},"vendor":{"value":"officeworks","confidence":1},"vendor_resolved_to":{"value":null,"confidence":0},"abn":{"value":null,"confidence":0},"gst":{"value":14.5,"confidence":1},"gst_basis":"exclusive","invoice_number":{"value":null,"confidence":0},"due_date":{"value":null,"confidence":0},"category_hint":{"value":"inventory","confidence":1}}',
  'partial', 1, 0, 'logged', null, null,
  'wamid.seed-d1.5', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 days')
);

-- 6. materials 215 bunnings gst (GST-exclusive → $21.50)
insert into transactions (
  id, business_id, user_phone, type, amount, gst, category, vendor, abn,
  invoice_number, due_date, image_urls, raw_extraction, gate_level,
  machine_read, auto_logged, status, flow_state, flow_expires_at,
  wa_message_id, confirmed_at
) values (
  'seed-d1-6', '00000000-0000-4000-8000-000000000001', '61400000111', 'outgoing',
  215, 21.5, 'inventory', 'bunnings', null, null, null, '[]',
  '{"amount":{"value":215,"confidence":1},"date":{"value":null,"confidence":0},"vendor":{"value":"bunnings","confidence":1},"vendor_resolved_to":{"value":null,"confidence":0},"abn":{"value":null,"confidence":0},"gst":{"value":21.5,"confidence":1},"gst_basis":"exclusive","invoice_number":{"value":null,"confidence":0},"due_date":{"value":null,"confidence":0},"category_hint":{"value":"inventory","confidence":1}}',
  'partial', 1, 0, 'logged', null, null,
  'wamid.seed-d1.6', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 days')
);
