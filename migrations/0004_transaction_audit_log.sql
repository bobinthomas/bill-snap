-- Audit trail for admin edits/deletes of logged bills (§dev/dashboard bills
-- table). `changed_by` is a constant for now — no per-admin identity exists
-- yet (the dashboard is a single shared-password admin surface) — the column
-- is here so a future real login doesn't need a schema change.
create table if not exists transaction_audit_log (
  id             text primary key,
  transaction_id text not null references transactions (id),
  business_id    text references businesses (id),
  action         text not null check (action in ('edit', 'delete')),
  changes        text not null,   -- JSON: {field: {from, to}} (edit) or a snapshot (delete)
  changed_by     text not null default 'dashboard-admin',
  created_at     text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create index if not exists audit_log_business_created on transaction_audit_log (business_id, created_at desc);
