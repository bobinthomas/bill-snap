-- BillSnap D1 schema (§5.5) — Cloudflare D1 (SQLite).
--
-- Mirrors the old Supabase schema 1:1 (see git history for the Postgres
-- version). SQLite dialect notes:
--   * ids / timestamps are TEXT (crypto.randomUUID() and ISO-8601 strings —
--     lexicographic ISO comparisons match the Postgres timestamptz semantics)
--   * JSON columns are TEXT holding JSON.stringify'd values
--   * booleans are INTEGER 0/1
--   * the draft idempotency key is a partial unique index (SQLite supports
--     partial indexes, same as the Postgres version)

-- ---------------------------------------------------------------- businesses
create table if not exists businesses (
  id             text primary key,
  name           text not null,
  abn            text,
  timezone       text not null,             -- IANA tz, e.g. Australia/Sydney (§5.5)
  gst_registered integer not null default 1,
  auto_save      integer not null default 1,   -- §5.8 opt-out (owner can force always-confirm)
  created_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ------------------------------------------------------------------- users
create table if not exists users (
  phone_number  text primary key,           -- WhatsApp number / webapp device id (§5.5)
  business_id   text references businesses (id),
  setup_step    text,                       -- 'name' | 'timezone' | 'gst' (§4.5 wizard position)
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ------------------------------------------------------------ memberships
create table if not exists memberships (
  id            text primary key,
  business_id   text not null references businesses (id) on delete cascade,
  user_phone    text not null references users (phone_number) on delete cascade,
  role          text not null check (role in ('owner', 'staff')),
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  unique (business_id, user_phone)
);

-- ------------------------------------------------------------ share_links
create table if not exists share_links (
  id            text primary key,
  business_id   text not null references businesses (id) on delete cascade,
  token         text not null,              -- unguessable, short-lived (F12, Phase 3)
  created_by    text references users (phone_number),
  expires_at    text not null,
  created_at    text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ------------------------------------------------------------ transactions
-- Drafts ARE transactions rows (§5.6): status: draft → logged / expired / deleted.
create table if not exists transactions (
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
                                             'editing_date', 'queued')),
  flow_expires_at text,                    -- draft TTL (10 min, checked on every message)
  flow_nudged_at  text,                    -- one-nudge cap (§6.2)
  wa_message_id   text,                    -- idempotency key (§5.6)
  wa_received_at  text,
  payment_method  text check (payment_method in ('cash', 'bank_transfer', 'card', 'bpay')),
  created_at      text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  confirmed_at    text
);

-- Idempotency (§5.6): a retried webhook delivery finds its draft and is ignored.
-- Partial index so only drafts contend (one active draft per user at a time).
create unique index if not exists transactions_draft_idempotency
  on transactions (user_phone, wa_message_id)
  where status = 'draft';

-- Owner scope / summaries (§4.3).
create index if not exists transactions_business_created on transactions (business_id, created_at desc);
-- Staff scope / undo lookup (§5.6).
create index if not exists transactions_user_created on transactions (user_phone, created_at desc);
-- Active-draft lookup (§5.6 routing step 3).
create index if not exists transactions_active_draft on transactions (user_phone) where status = 'draft';
-- Nudge/expiry sweep (cron, §5.6).
create index if not exists transactions_sweep on transactions (status, flow_expires_at);
