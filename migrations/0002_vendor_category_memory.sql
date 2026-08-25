-- Vendor -> category memory (episodic + semantic + procedural, see plan).
--
-- 1) `flow_state` CHECK was missing 'editing_category' (0001_schema.sql) even
--    though it's a valid FlowState (src/types.ts) reachable via confirm
--    option 6 -> beginEdit("category", ...). SQLite has no
--    `alter table ... drop constraint`, so the CHECK is fixed by the
--    standard rebuild dance: create corrected table, copy rows, drop old,
--    rename, recreate indexes.
-- 2) One-time backfill: `business_id` has never been written onto
--    `transactions` rows (createDraft/confirm never set it) — derive it from
--    `users.business_id` so existing history is usable by the episodic
--    lookup once business_id starts being persisted going forward.
-- 3) New index for the episodic vendor->category lookup (business_id, vendor).

create table transactions_new (
  id              text primary key,
  business_id     text references businesses (id),          -- denormalised tenant key (§5.5)
  user_phone      text references users (phone_number),     -- who logged it
  type            text not null default 'outgoing' check (type in ('incoming', 'outgoing')),
  amount          real,                                     -- AUD
  gst             real,                                     -- recomputed from gst_basis (§5.3)
  category        text check (category in ('wages', 'utilities', 'inventory', 'rent', 'misc')),
  vendor          text,
  abn             text,
  invoice_number  text,
  due_date        text,
  image_urls      text not null default '[]',               -- JSON array; multi-image queue (§5.6)
  raw_extraction  text,                                     -- JSON (§5.4)
  gate_level      text check (gate_level in ('high', 'partial', 'low')),
  machine_read    integer,
  auto_logged     integer,
  status          text not null default 'draft'
                    check (status in ('draft', 'logged', 'paid', 'overdue', 'expired', 'deleted')),
  flow_state      text check (flow_state in ('processing', 'awaiting_confirm',
                                             'editing_amount', 'editing_vendor',
                                             'editing_date', 'editing_category', 'queued')),
  flow_expires_at text,                    -- draft TTL (10 min, checked on every message)
  flow_nudged_at  text,                    -- one-nudge cap (§6.2)
  wa_message_id   text,                    -- idempotency key (§5.6)
  wa_received_at  text,
  payment_method  text check (payment_method in ('cash', 'bank_transfer', 'card', 'bpay')),
  created_at      text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  confirmed_at    text
);

insert into transactions_new
  (id, business_id, user_phone, type, amount, gst, category, vendor, abn, invoice_number,
   due_date, image_urls, raw_extraction, gate_level, machine_read, auto_logged, status,
   flow_state, flow_expires_at, flow_nudged_at, wa_message_id, wa_received_at, payment_method,
   created_at, confirmed_at)
select
   id, business_id, user_phone, type, amount, gst, category, vendor, abn, invoice_number,
   due_date, image_urls, raw_extraction, gate_level, machine_read, auto_logged, status,
   flow_state, flow_expires_at, flow_nudged_at, wa_message_id, wa_received_at, payment_method,
   created_at, confirmed_at
from transactions;

drop table transactions;
alter table transactions_new rename to transactions;

create unique index if not exists transactions_draft_idempotency
  on transactions (user_phone, wa_message_id)
  where status = 'draft';
create index if not exists transactions_business_created on transactions (business_id, created_at desc);
create index if not exists transactions_user_created on transactions (user_phone, created_at desc);
create index if not exists transactions_active_draft on transactions (user_phone) where status = 'draft';
create index if not exists transactions_sweep on transactions (status, flow_expires_at);

-- Episodic vendor->category lookup (business_id, vendor).
create index if not exists transactions_business_vendor on transactions (business_id, vendor);

-- Backfill: derive business_id for existing rows from the logging user's
-- business, so the episodic lookup has data to learn from immediately.
update transactions
set business_id = (select u.business_id from users u where u.phone_number = transactions.user_phone)
where business_id is null and user_phone is not null;
