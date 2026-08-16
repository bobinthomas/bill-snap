-- BillSnap schema (§5.5).
-- Extensions over the PRD table spec (documented deviations):
--   users.setup_step           — setup-wizard position per phone (§4.5); the wizard must survive stateless workers
--   transactions.gate_level    — §5.4 gating outcome stored by the extraction pipeline (M5)
--   transactions.machine_read  — true when the source was not Gemini (§5.4 level 3 → Variant C)
--   transactions.auto_logged   — true for the §5.8 auto-log path (grants the 24 h undo window)
--   transactions.image_urls    — jsonb array; the multi-image queue (§5.6) needs N URLs, not one

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- businesses
create table businesses (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  abn           text,
  timezone      text not null,              -- IANA tz, e.g. Australia/Sydney (§5.5)
  gst_registered boolean not null default true,
  auto_save     boolean not null default true,  -- §5.8 opt-out (owner can force always-confirm)
  created_at    timestamptz not null default now()
);

-- ------------------------------------------------------------------- users
create table users (
  phone_number  text primary key,           -- WhatsApp number (§5.5)
  business_id   uuid references businesses (id),
  setup_step    text,                       -- 'name' | 'timezone' | 'gst' (§4.5 wizard position)
  created_at    timestamptz not null default now()
);

-- ------------------------------------------------------------ memberships
create table memberships (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses (id) on delete cascade,
  user_phone    text not null references users (phone_number) on delete cascade,
  role          text not null check (role in ('owner', 'staff')),
  created_at    timestamptz not null default now(),
  unique (business_id, user_phone)
);

-- ------------------------------------------------------------ share_links
create table share_links (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses (id) on delete cascade,
  token         text not null,              -- unguessable, short-lived (F12, Phase 3)
  created_by    text references users (phone_number),
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now()
);

-- ------------------------------------------------------------ transactions
-- Drafts ARE transactions rows (§5.6): status: draft → logged / expired / deleted.
create table transactions (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid references businesses (id),          -- denormalised tenant key (§5.5)
  user_phone      text references users (phone_number),     -- who logged it
  type            text not null default 'outgoing' check (type in ('incoming', 'outgoing')),
  amount          numeric(12, 2),                           -- AUD
  gst             numeric(12, 2),                           -- recomputed from gst_basis (§5.3)
  category        text check (category in ('wages', 'utilities', 'inventory', 'rent', 'misc')),
  vendor          text,
  abn             text,
  invoice_number  text,
  due_date        date,
  image_urls      jsonb not null default '[]'::jsonb,       -- multi-image queue (§5.6)
  raw_extraction  jsonb,                                    -- full Gemini JSON (§5.4)
  gate_level      text check (gate_level in ('high', 'partial', 'low')),
  machine_read    boolean,
  auto_logged     boolean,
  status          text not null default 'draft'
                    check (status in ('draft', 'logged', 'paid', 'overdue', 'expired', 'deleted')),
  flow_state      text check (flow_state in ('processing', 'awaiting_confirm',
                                             'editing_amount', 'editing_vendor',
                                             'editing_date', 'queued')),
  flow_expires_at timestamptz,             -- draft TTL (10 min, checked on every message)
  flow_nudged_at  timestamptz,             -- one-nudge cap (§6.2)
  wa_message_id   text,                    -- idempotency key (§5.6)
  wa_received_at  timestamptz,
  payment_method  text check (payment_method in ('cash', 'bank_transfer', 'card', 'bpay')),
  created_at      timestamptz not null default now(),
  confirmed_at    timestamptz
);

-- Idempotency (§5.6): a retried webhook delivery finds its draft and is ignored.
-- Partial index so only drafts contend (one active draft per user at a time).
create unique index transactions_draft_idempotency
  on transactions (user_phone, wa_message_id)
  where status = 'draft';

-- Owner scope / summaries (§4.3).
create index transactions_business_created on transactions (business_id, created_at desc);
-- Staff scope / undo lookup (§5.6).
create index transactions_user_created on transactions (user_phone, created_at desc);
-- Active-draft lookup (§5.6 routing step 3).
create index transactions_active_draft on transactions (user_phone) where status = 'draft';
-- Nudge/expiry sweep (cron, §5.6).
create index transactions_sweep on transactions (status, flow_expires_at);
