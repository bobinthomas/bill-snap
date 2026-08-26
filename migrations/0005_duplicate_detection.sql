-- Business-scoped, unconditional duplicate detection (see plan: multi-company
-- selection). Replaces the old phone-scoped, 90-day-windowed, auto-log-only
-- check with one that runs on every capture, matched on bill_date + amount
-- within a company, no time window.
--
-- 1) `flow_state` CHECK was missing 'awaiting_duplicate_confirm' — same
--    rebuild dance 0002 used for 'editing_category' (SQLite has no
--    `alter table ... drop constraint`).
-- 2) New column `bill_date` — a denormalised mirror of
--    `raw_extraction.date.value`, written by confirm()/updateLogged()
--    alongside the other denormalised columns. There was previously no
--    queryable bill-date column at all; matching on it via SQL needs one.
-- 3) New column `duplicate_of_id` — the id of the bill a flagged capture
--    collided with, null otherwise.
-- 4) New index for the duplicate-check query (business_id, bill_date).
-- 5) `transaction_audit_log.transaction_id` (0004) has `references
--    transactions (id)` — with D1's foreign_keys enforcement always on (no
--    way to disable it via PRAGMA through the execute API, confirmed by
--    testing against it directly), that FK blocks `drop table transactions`
--    below outright, even though nothing else about this migration touches
--    audit log rows. `transactions` gets rebuilt periodically (0002 already
--    did once) and always will as flow_state gains new states, so the FK
--    has to go rather than working around it once — rebuild
--    transaction_audit_log first, dropping the constraint (documentation-
--    only in practice: the app already only ever calls audit.record() with
--    a real transaction id).

create table transaction_audit_log_new (
  id             text primary key,
  transaction_id text not null,
  business_id    text references businesses (id),
  action         text not null check (action in ('edit', 'delete')),
  changes        text not null,
  changed_by     text not null default 'dashboard-admin',
  created_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
insert into transaction_audit_log_new (id, transaction_id, business_id, action, changes, changed_by, created_at)
select id, transaction_id, business_id, action, changes, changed_by, created_at from transaction_audit_log;
drop table transaction_audit_log;
alter table transaction_audit_log_new rename to transaction_audit_log;
create index if not exists audit_log_business_created on transaction_audit_log (business_id, created_at desc);

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
  bill_date       text,                                     -- denormalised mirror of raw_extraction.date.value
  duplicate_of_id text,                                     -- flagged-as-duplicate-of, see drafts.ts
  image_urls      text not null default '[]',               -- JSON array; multi-image queue (§5.6)
  raw_extraction  text,                                     -- JSON (§5.4)
  gate_level      text check (gate_level in ('high', 'partial', 'low')),
  machine_read    integer,
  auto_logged     integer,
  status          text not null default 'draft'
                    check (status in ('draft', 'logged', 'paid', 'overdue', 'expired', 'deleted')),
  flow_state      text check (flow_state in ('processing', 'awaiting_confirm',
                                             'editing_amount', 'editing_vendor',
                                             'editing_date', 'editing_category',
                                             'awaiting_duplicate_confirm', 'queued')),
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
create index if not exists transactions_business_vendor on transactions (business_id, vendor);

-- Duplicate-check lookup (business_id, bill_date).
create index if not exists transactions_business_bill_date on transactions (business_id, bill_date);

-- Backfill: derive bill_date for existing logged/paid rows from their own
-- raw_extraction JSON, so pre-existing bills participate in duplicate
-- detection immediately rather than only bills logged from now on.
update transactions
set bill_date = json_extract(raw_extraction, '$.date.value')
where bill_date is null and raw_extraction is not null and status in ('logged', 'paid');
