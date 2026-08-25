-- Company profile fields for the settings page (§dev/dashboard/settings).
-- Simple additive columns — no CHECK constraint, no rebuild dance needed
-- (unlike 0002's flow_state fix). All nullable; existing rows (incl. the
-- demo/seed business) get NULL, no backfill required.
alter table businesses add column gst_number text;
alter table businesses add column address text;
alter table businesses add column phone text;
