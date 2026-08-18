# BillSnap — WhatsApp bill-tracking Worker

A Cloudflare Worker that turns bill photos sent over WhatsApp into logged
business transactions. It receives the photo via the WhatsApp Cloud API
webhook, extracts amount / date / vendor / ABN / GST with a **regex-first →
Workers AI** parsing pipeline, gates the reading on confidence, and auto-logs
High-confidence AI readings with a 24-hour undo window (§5.8).

Product decisions and the full data model live in
[`PRD_BillSnap_Business_Payment_Tracker.md`](PRD_BillSnap_Business_Payment_Tracker.md);
the scaffold plan (milestones M0–M8) in
[`SCAFFOLDING_PLAN.md`](SCAFFOLDING_PLAN.md).

## Architecture at a glance

- **Entry** (`src/index.ts`) — Hono app: `/webhook` (GET verify handshake,
  POST X-Hub-Signature-256 verified messages), `/health`, plus dev-only demo
  and dashboard routes. A scheduled trigger runs the nudge/expiry sweep every
  2 minutes.
- **Routing** (`src/webhook/router.ts`) — unknown users go to onboarding,
  known users to the command parser or draft flows.
- **Extraction** (`src/extraction/pipeline.ts`) — regex parser is PRIMARY over
  OCR text (§5.3); when regex can't find the amount, Workers AI
  (`env.AI.run`, text model on OCR text) is the fallback. Photos with no OCR
  text (the real webhook sends image bytes only) go to the LLaVA **vision**
  model. Shared validation (ABN checksum, GST recompute, date normalisation,
  anti-fabrication guards) runs before `classify()` gates high / partial / low.
- **Flows** (`src/flows/`) — photo ingestion (idempotent draft on
  `(user_phone, wa_message_id)`), auto-log or confirm screen per §5.4, the
  confirm/edit/undo commands, onboarding, and the nudge + expiry sweep.
- **Persistence** (`src/db/`, `src/storage/`) — Cloudflare D1 (SQLite) stores
  over the migrations in `migrations/`; bill images archive to the `BILLS` R2
  bucket at `business_id/YYYY/MM/`. Everything stays inside Cloudflare — no
  external database.

## Prerequisites

- Node 20+ and npm
- A Cloudflare account (`npx wrangler login`) — only needed for **deploying**
  (the Workers AI binding is remote-only and lives in `wrangler.deploy.toml`,
  so local dev and CI run without any Cloudflare credentials)

## Install and run locally

```bash
npm install
cp .env.example .dev.vars      # fill in what you have — see the table below
npm run dev -- --var DEV_DEMO:true
```

Then open:

- `http://127.0.0.1:8787/health` — status incl. which secrets are configured
- `http://127.0.0.1:8787/dev/demo` — the browser demo (simulated WhatsApp)
- `http://127.0.0.1:8787/dev/dashboard` — the analytics dashboard

Without `--var DEV_DEMO:true` the `/dev/*` routes 404. The demo runs fully
in-memory when no D1/R2 bindings are present, so you can try the whole flow
with no infrastructure at all.

### Full stack in one command (`npm run dev:full`)

Want the real D1 stores + R2 storage too? `npm run dev:full` does it in one
step — no Docker, no Supabase, no Cloudflare account:

1. installs deps if `node_modules` is missing
2. applies `migrations/0001_schema.sql` to the **local D1 state**
   (`wrangler d1 migrations apply bill-snap --local`) — the exact schema that
   deploys to production, run against miniflare's local SQLite
3. runs `wrangler dev` with the demo enabled and waits for `/health`

The demo then runs against real D1 + R2 (badge shows `persistence: d1`), so
dashboard entries survive page reloads. Want sample data without clicking the
dashboard's ✨ Seed button? `npm run db:seed` inserts the six demo bills
directly into D1 (idempotent — safe to re-run). Use a different worker port
with `DEV_PORT=8790 npm run dev:full`. If you only want the demo without any
infrastructure, keep using the in-memory path above.

`RUN_SMOKE=1 npm run dev:full` additionally runs the smoke test (photo →
confirm → undo) against the D1 stores **before** starting `wrangler dev`, and
prints a one-line pass/fail report. The smoke always runs for real (no env
wiring needed — it builds the stores from the migration SQL directly); if the
round trip fails, the bootstrap aborts with the failure shown — rerun without
`RUN_SMOKE=1` to skip the gate.

Tear it all down with `npm run dev:down` — it stops the `wrangler dev`
listening on the dev port (finding the real port-holder, so it also catches
an orphaned server a hard Ctrl+C left behind). Local D1/R2 state in
`.wrangler/` is kept for the next `dev:full`; delete that directory to reset
it. It's safe to run when nothing is up — it reports what it stopped and
exits 0. Use `DEV_PORT=8790 npm run dev:down` to match a custom worker port.

### The demo console

Upload a bill photo (or use the sample bill), and watch the pipeline: local
OCR in the browser → regex parse → Workers AI fallback if needed → confirm
screen or auto-log reply. The confirm screen shows the OCR read-back with the
captured date/amount and a **Retry OCR** button. The dashboard shows the logged
bills with month/category/vendor filters, the auto-log KPI, and CSV export.

Set `GEMINI_MOCK=true` in `.dev.vars` for deterministic canned AI readings
(no Workers AI quota, no binding needed). The real `env.AI` binding is
applied only at deploy time via `wrangler.deploy.toml`, so local dev and the
browser demo never require a Cloudflare login.

## Environment variables

| Variable | Required for | Purpose |
|---|---|---|
| `WHATSAPP_VERIFY_TOKEN` | real webhook | Verify-token handshake (GET `/webhook`) |
| `WHATSAPP_APP_SECRET` | real webhook | X-Hub-Signature-256 verification |
| `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TOKEN` | real webhook | Sending replies + media download |
| `AI_MODEL` | — (optional) | Workers AI text model override (default: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`) |
| `AI_VISION_MODEL` | — (optional) | Vision model override (default: `@cf/llava-hf/llava-1.5-7b-hf`) |
| `GEMINI_MOCK` | — (dev only) | `true` → deterministic mock AI extractor, never in production |
| `DEV_DEMO` | demo (dev only) | `true` → enables `/dev/*` routes |
| `EXTRACTION_*`, `DRAFT_TTL_MINUTES`, `NUDGE_DELAY_MINUTES`, `UNDO_*` | — (optional) | §5.4 thresholds and §5.6/§5.8 TTLs; defaults in `src/config.ts` |

The **data model and images need no env vars at all**: D1 (`DB` binding,
`migrations/`) and R2 (`BILLS` binding) are wrangler.toml bindings, not
secrets. WhatsApp vars are the only secrets the app itself uses.

## D1 + smoke test

```bash
npm run smoke     # photo → confirm → undo through the real D1 stores + R2
                  # storage, over the real migration SQL (node:sqlite shim)
npm run db:seed   # insert the six demo sample bills into local D1
                  # (npm run db:seed:remote for the production database)
```

The smoke test needs no infrastructure: it runs the production store
implementations against an in-memory SQLite that executes the exact
`migrations/0001_schema.sql` from this repo (plus a fake R2 bucket), so a
schema or store regression fails immediately on any machine — no Docker, no
Cloudflare account, no secrets. It is included in `npm test` (never skipped)
and run as its own CI job.

`db:seed` runs the committed `d1/seed.sql` via `wrangler d1 execute --file` —
the same six bills the dashboard's ✨ Seed button logs, written straight into
D1 with the exact `raw_extraction` JSON the pipeline produces. It is
idempotent: re-running resets only the seed's own rows (`wamid.seed-d1.*`),
leaving user-confirmed bills untouched. A regression test
(`tests/db-seed.test.ts`) pins the file so a typo fails CI.

## Eval & regression harness (§5.7)

The golden corpus (`eval/corpus/labels/`) pins extraction behaviour; images
live in a private mirror and are never committed. See
[`eval/corpus/README.md`](eval/corpus/README.md) for how to add a bill.

```bash
npm run eval        # §5.7 harness: replay the corpus through the pipeline,
                    # gate on success rate + per-field accuracy targets
npm run sweep       # §5.4 threshold sweep: find operating points that clear
                    # the targets across the corpus
npm run eval:ocr    # measurement (not a gate): OCR the corpus images with
                    # tesseract and report per-field confidence + guard fires
OCR_PHOTO=/path/to/bill.jpg npm run eval:ocr   # a single fresh photo instead
node eval/generate-bill.mjs  # draw the synthetic + committed corpus images
```

The committed golden corpus includes image labels (`eval/corpus/synthetic/`,
rendered by `generate-bill.mjs`) that CI scores via the OCR path — so image
reading is regression-tested on every push, not just the text corpus. The
LLaVA vision model itself is Worker-runtime-only and stays covered by unit
tests and the live demo.

## Checks and scripts

```bash
npm run typecheck   # tsc, both app and test configs
npm test            # vitest — unit + flow tests (smoke always runs)
npm run smoke       # photo → confirm → undo round trip (D1 stores, no infra)
npm run db:seed     # insert the six demo sample bills into local D1
npm run dev         # wrangler dev (add -- --var DEV_DEMO:true for the demo)
npm run dev:full    # one-command bootstrap: D1 migrations + wrangler dev
                    #   (RUN_SMOKE=1 npm run dev:full also runs the smoke first)
npm run dev:down    # teardown: stop wrangler dev on the dev port
npm run deploy      # wrangler deploy -c wrangler.deploy.toml (adds AI/D1/R2 bindings)
```

## Deploying

Deploys are automated: the **Deploy** workflow (`.github/workflows/deploy.yml`)
runs on every push to `main` and on `v*` tags — it re-runs the full CI gates
(typecheck, tests, the §5.7 eval, and the D1 smoke round trip) and only then
applies the migrations to the remote D1 (`wrangler d1 migrations apply
bill-snap --remote`) and `wrangler deploy`s. Configure GitHub Actions secrets
for the deploy:

- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (Cloudflare API token with
  Workers edit permission)
- the four WhatsApp worker secrets: `WHATSAPP_VERIFY_TOKEN`,
  `WHATSAPP_APP_SECRET`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TOKEN` — set as
  Cloudflare secrets by the workflow before each deploy

One-time infrastructure setup (from a logged-in machine):

```bash
wrangler d1 create bill-snap        # paste the returned id as database_id in wrangler.deploy.toml
wrangler r2 bucket create bill-snap-bills
wrangler d1 migrations apply bill-snap --remote
```

Manual deploy (same steps, no CI gate):

```bash
wrangler secret put WHATSAPP_VERIFY_TOKEN
wrangler secret put WHATSAPP_APP_SECRET
wrangler secret put WHATSAPP_PHONE_NUMBER_ID
wrangler secret put WHATSAPP_TOKEN
npm run deploy
```

A separate **Bootstrap E2E** workflow (`.github/workflows/bootstrap-e2e.yml`, on
main / `v*` tags / manual dispatch) proves the bootstrap itself: it runs
`npm run dev:full` on a fresh runner with no Docker and no Cloudflare account,
waits for the ✅ Full stack banner, asserts the demo/dashboard/webapp
endpoints, then runs `npm run dev:down` and reports the banner in the job
summary. Manual runs (dispatch) default the `run_smoke` input ON, which
additionally runs the photo → confirm → undo round trip inside the same job
(the bootstrap's `RUN_SMOKE=1` gate), so one run proves the full stack, the
real-store round trip, and the teardown together.

Then point the Meta WhatsApp webhook at `https://<your-worker>.workers.dev/webhook`
with your verify token. The `[triggers]` cron in `wrangler.toml` runs the
nudge/expiry sweep in production; in local dev, `wrangler dev --test-scheduled`
fires the scheduled handler when the dev URL is hit.

## Project layout

```
src/
├── index.ts              # Hono app: webhook, health, demo, dashboard routes
├── config.ts             # env config + §5.4 thresholds / TTL defaults
├── webhook/              # verify (handshake + HMAC), parse, router
├── extraction/           # regex (primary), workers-ai (text+vision fallback),
│                         # validate, gate, mock (dev)
├── flows/                # photo, confirm, edit, commands, onboarding, nudge
├── messaging/            # WhatsApp messenger + reply screens
├── db/                   # D1 stores (users, businesses, drafts) — SQLite
├── storage/              # R2 bill-image uploads
└── dev/                  # demo console, dashboard, in-memory stores
migrations/               # D1 schema (0001) — same file local + remote
eval/                     # §5.7 golden corpus + harness, OCR runner, sweep
tests/                    # vitest suite (unit + flows + smoke)
```
