# BillSnap — Scaffolding Plan

**Derived from:** `PRD_BillSnap_Business_Payment_Tracker.md` (v1.0, with §5.8 auto-log decision adopted)
**Purpose:** turn the PRD's architecture into an implementable project skeleton, in vertical slices, with testability from day one.

---

## 1. Stack

| Layer | Choice | Notes |
|-------|--------|-------|
| Runtime | Cloudflare Worker (TypeScript) | Stateless, zero cold start (§5.1) |
| Router | Hono | Small, typed, Worker-native |
| DB + Storage | Supabase Postgres + Storage | Service-role key server-side only (§7.2/7.3) |
| Extraction | Gemini 2.5 Flash primary, regex fallback (§5.3) | Structured JSON per §5.4 |
| WhatsApp | Meta Cloud API (webhook + send API) | Verify-token + `X-Hub-Signature-256` (§7.2) |
| Tests | Vitest + `wrangler dev` | Mock WhatsApp + fake Gemini for CI |
| Eval | `eval/` harness over a golden corpus (§5.7) | Threshold sweep, committed baselines |
| Deploy | Wrangler + Supabase CLI | Cron for nudge/expiry sweep |

---

## 2. Repo layout

```
bill-snap/
├── package.json
├── tsconfig.json
├── wrangler.toml               # worker config, cron trigger, bindings
├── .dev.vars                   # local secrets (gitignored)
├── .env.example                # documented secret names
├── supabase/
│   ├── migrations/
│   │   ├── 0001_schema.sql     # users, businesses, memberships, share_links, transactions
│   │   ├── 0002_rls.sql        # RLS policies (§7.3)
│   │   └── 0003_storage.sql    # bills bucket + path policy
│   └── seed.sql                # dev seed (one owner, sample transactions)
├── src/
│   ├── index.ts                # worker entry: router, cron, health
│   ├── config.ts               # env parsing, thresholds, TTLs (all env-configurable)
│   ├── types.ts                # shared types (draft, event, extraction)
│   ├── webhook/
│   │   ├── verify.ts           # verify-token handshake + X-Hub-Signature-256 (§7.2)
│   │   ├── parse.ts            # WhatsApp payload → normalized inbound event
│   │   └── router.ts           # routing per §5.6 (idempotency → draft → command)
│   ├── flows/
│   │   ├── onboarding.ts       # §4.5: welcome, business auto-create, setup wizard
│   │   ├── photo.ts            # draft creation, multi-image queue (§5.6)
│   │   ├── confirm.ts          # 6.2 options (1-5)
│   │   ├── edit.ts             # 6.3 sub-flows (amount / vendor / date)
│   │   ├── commands.ts         # summary, find, delete, help, NEXT, setup
│   │   └── nudge.ts            # nudge + expiry sweep (cron)
│   ├── extraction/
│   │   ├── gemini.ts           # primary parser → §5.4 JSON
│   │   ├── regex.ts            # fallback parser (§5.3)
│   │   ├── validate.ts         # ABN checksum, GST, date/amount normalisation (§5.3)
│   │   └── gate.ts             # §5.4 gating rule (High / Partial / Low)
│   ├── db/
│   │   ├── client.ts           # Supabase client (service role, server-side)
│   │   ├── drafts.ts           # draft lifecycle + idempotency queries
│   │   ├── transactions.ts
│   │   └── businesses.ts
│   ├── messaging/
│   │   ├── whatsapp.ts         # send API (text, replies)
│   │   ├── screens.ts          # confirm variants A/B/C, welcome, nudge, help (§6.x)
│   │   └── mock.ts             # MockWhatsAppClient for tests (no Meta needed)
│   ├── storage/
│   │   └── bills.ts            # upload/download, business_id/YYYY/MM/ paths
│   └── commands/
│       └── (reserved for Phase 2: search, recurring, exports)
├── eval/
│   ├── corpus/                 # gitignored: images + label.json (private bucket mirror)
│   ├── harness.ts              # run extraction pipeline over corpus (§5.7)
│   ├── sweep.ts                # threshold sweep (amount 0.80–0.95)
│   └── reports/                # committed baselines
└── tests/
    ├── webhook.test.ts         # signature, verify-token, idempotency
    ├── flows.test.ts           # draft state machine, confirm/edit/nudge, undo
    ├── extraction.test.ts      # regex, validation, gating, GST
    └── fixtures/               # sample bills, Gemini JSON responses
```

---

## 3. Environment & secrets

| Secret | Where | Used by |
|--------|-------|---------|
| `WHATSAPP_VERIFY_TOKEN` | Worker secret / `.dev.vars` | Handshake (§7.2) |
| `WHATSAPP_APP_SECRET` | Worker secret | Signature verification (§7.2) |
| `WHATSAPP_PHONE_NUMBER_ID` | Worker env | Send API |
| `WHATSAPP_TOKEN` | Worker secret | Send API |
| `GEMINI_API_KEY` | Worker secret | Extraction (§5.3) |
| `SUPABASE_URL` | Worker env | DB client |
| `SUPABASE_SERVICE_ROLE_KEY` | Worker secret | DB writes — never client-side (§7.3) |

Configurable (not secrets): extraction thresholds (§5.4), draft TTL (10 min), nudge delay (6 min), undo windows (24 h / 5 min), rate limits (§7.2), auto-log default (`businesses.auto_save`).

---

## 4. Supabase schema (from §5.5)

Tables: `businesses`, `users`, `memberships`, `share_links`, `transactions` (with `flow_state`, `flow_expires_at`, `flow_nudged_at`, `wa_message_id`, `wa_received_at`, `raw_extraction`).

Key constraints and indexes:
- `UNIQUE (user_phone, wa_message_id)` on `transactions` — idempotency (§5.6)
- Index `transactions (business_id, created_at)` — summaries, owner scope (§4.3)
- Index `transactions (user_phone, created_at)` — staff scope, undo lookup
- Partial index `transactions (user_phone) WHERE status = 'draft'` — active-draft lookup
- Index `transactions (status, flow_expires_at)` — nudge/expiry sweep
- FK `transactions.business_id → businesses.id`, `users.business_id → businesses.id`

RLS (§7.3): staff read/write their own `user_phone` rows; `owner` members read all rows for their `business_id`; `share_links` readable by token holders only.

Storage: bucket `bills`, private with signed URLs for Gemini extraction and accountant share; path `business_id/YYYY/MM/filename.jpg`.

---

## 5. Worker structure

- `GET /webhook` — verify-token handshake (§7.2)
- `POST /webhook` — signature check → parse → idempotency → route (§5.6): onboarding → draft flow → command parser
- Cron (every 1–2 min) — nudge send + draft expiry sweep (§5.6, 6.2)
- `GET /health` — config sanity (secrets present, DB reachable)

---

## 6. Scaffolding milestones (ordered, each ends green)

**M0 — Skeleton.** `wrangler init` + TS + Hono + `/health`. Done when: `wrangler dev` answers `/health`.

**M1 — Schema. ✅ done.** Supabase migrations (`0001_schema.sql` schema + extensions, `0002_rls.sql`, `0003_storage.sql`) + `seed.sql`; real `UserStore`/`BusinessStore`/`DraftStore` against the REST client (`src/db/client.ts`). Done when: `supabase db reset` applies cleanly; draft lookup + idempotency constraints verified with SQL queries.

**M2 — Webhook security.** `verify.ts` + `parse.ts` (§7.2). Done when: unit tests cover bad token, bad signature, malformed payloads.

**M3 — Command echo.** `router.ts` + `commands.ts` with `help`. Done when: a mocked inbound "help" produces the expected reply through the real pipeline. First end-to-end round trip.

**M4 — Draft lifecycle.** `db/drafts.ts` + `flows/photo.ts` (draft creation before extraction, queue, expiry on access). Done when: flow-state unit tests pass with a fake extractor; idempotent retry test passes.

**M5 — Extraction pipeline.** `extraction/*` with Gemini stub → real Gemini + regex + validation + gating (§5.3/5.4). Done when: `extraction.test.ts` passes on fixtures; `eval/harness.ts` runs on a 20-image subset and produces a report.

**M6 — Confirm/edit/nudge.** `flows/confirm.ts`, `flows/edit.ts`, `flows/nudge.ts` (§6.2/6.3, §5.6). Done when: full state machine tests (confirm, edit amount/vendor/date, skip, undo windows 24 h / 5 min, one-nudge cap).

**M7 — Onboarding + setup.** `flows/onboarding.ts` (§4.5) + auto-log adoption in `confirm.ts` (§5.8). Done when: unknown-number → welcome → first-bill flow passes; `setup` wizard updates `businesses`.

**M8 — Storage. ✅ done (upload half).** `storage/bills.ts` uploads the WhatsApp-downloaded bytes to the `bills` bucket at `business_id/YYYY/MM/{mediaId}.{ext}` and stores the public URL on the draft via `FlowPatch.imageUrls`; archival failure is non-fatal (extraction runs on the bytes in hand). Done when: upload round trip in tests with mock storage (downloads happen in the photo flow; the local Supabase smoke test exercises the real bucket).

**M9 — Eval harness v1. ✅ done.** Shared machinery in `eval/lib.ts` (§5.7 scoring: success = High/Partial + correct amount & date; field accuracy measured where expected AND High-confidence, so the pool tracks the thresholds under test). `npm run eval` replays `eval/corpus/labels/*.json` through the real pipeline, scores the criteria (success ≥70%, amount ≥95% / date ≥90% / vendor ≥80%, GST within 1c), writes `eval/reports/latest.json`, and exits non-zero on any failure. `npm run sweep` re-gates one extraction pass per entry across the §5.4 threshold space (amount 0.80–0.95, date 0.75–0.95, vendor 0.60–0.90) and recommends the strictest passing operating point → `eval/reports/sweep-latest.json`. Corpus: 25 image bills + 5 text entries (labels committed; images gitignored private mirror) — balanced GST-inclusive/exclusive/none, portrait/landscape, 5 hard cases, and 3 near-duplicate pairs (`duplicate_of`) whose §5.8 gate is asserted in the harness (no false matches — once on labels, once on extractions; the shared `isDuplicateMatch` predicate in `src/db/drafts.ts` powers the SQL, the test fake, and the eval). First full-corpus Gemini baseline still owed (needs the mirror + GEMINI_API_KEY).

**M10 — Tests + CI + deploy.** Vitest in CI, wrangler deploy + cron, secrets checklist. Done when: a merge triggers lint + tests + eval-subset + deploy.

---

## 7. Dev loop & testing

- **Local:** `wrangler dev` + `.dev.vars`; `supabase start` for local Postgres/Storage.
- **Live webhook:** cloudflared/ngrok tunnel to `wrangler dev`; Meta test number for manual smoke tests.
- **No-Meta testing:** `messaging/mock.ts` implements the same send API the flows use, so every flow test runs without WhatsApp. Real WhatsApp integration is a thin, manually-smoked layer.
- **No-Gemini testing:** fixtures replay canned §5.4 JSON at each gating level; `eval/` uses the real API on the corpus only.

### Local Supabase (persistence smoke)

The persistence layer is real end to end — drafts, onboarding, and bill images all
live in Supabase. To run the full round trip against a real database:

1. **Start local Supabase** (needs Docker Desktop):
   ```bash
   npx supabase start
   ```
2. **Apply migrations + seed from scratch:**
   ```bash
   npx supabase db reset      # runs supabase/migrations/0001..0003 + seed.sql
   ```
3. **Grab credentials:** `npx supabase status` → copy the **API URL** and the
   **service_role** key.
4. **Point the smoke at it:** copy `.env.smoke.example` → `.env.smoke` (gitignored)
   and fill both values.
5. **Run the round trip:**
   ```bash
   npm run smoke
   ```
   This exercises, through the real stores and the real `bills` bucket: unknown
   phone → onboarding auto-creates the business → photo → media download
   (fixture bytes) → upload to `business_id/YYYY/MM/` → extraction → confirm
   screen → `1` → logged → `delete` → undone. It asserts the uploaded object is
   really fetchable and the undo really soft-deletes, then cleans up after itself.

   `npm test` auto-skips the smoke file when no `.env.smoke`/`SUPABASE_URL` is
   present, so CI stays green without Docker.

Hosted variant (no Docker): `npx supabase link --project-ref <ref>` then
`npx supabase db push`, and point `.env.smoke` at `https://<ref>.supabase.co`
with the project's service_role key.

---

## 8. Deploy checklist

1. Supabase project + `supabase db push` (migrations 0001–0003)
2. Worker secrets: `wrangler secret put` for all of §3
3. Cron trigger configured in `wrangler.toml`
4. WhatsApp: verify-token handshake against production number; smoke-test a photo
5. Eval baseline report committed before first release

---

## 9. Decisions to confirm during scaffolding

- **Hono vs raw fetch** — Hono recommended (typing, middleware); reversible.
- **Supabase client** — **decided (M1): raw PostgREST over `fetch`** in `src/db/client.ts`, not `@supabase/supabase-js` or `postgres.js`. Matches the raw-fetch style of `gemini.ts`/`whatsapp.ts`, keeps the Worker bundle small, and the service-role key bypasses RLS either way (§7.3). Stores inject `fetchFn` so PostgREST-query shapes are unit-tested without a live database.
- **Gemini SDK vs raw REST** — SDK recommended for structured-output typing; REST keeps the Worker bundle smaller. Verify against the §5.4 schema either way.
- **Monorepo vs single package** — single package for MVP; `eval/` stays a script directory until it grows a UI.
- **WhatsApp test number vs production number** — test number for dev; production number requires Meta app approval lead time — start early.
