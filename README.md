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
- **Persistence** (`src/db/`, `src/storage/`) — Supabase REST stores over the
  migrations in `supabase/migrations/`; bill images archive to the `bills`
  bucket at `business_id/YYYY/MM/`.

## Prerequisites

- Node 20+ and npm
- A Cloudflare account (`npx wrangler login`) — only needed for the Workers AI
  binding in local dev and for deploying
- The Supabase CLI — only for the local Supabase + smoke recipe (see below)

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
in-memory when `SUPABASE_URL` is unset, so you can try the whole flow with no
infrastructure at all.

### The demo console

Upload a bill photo (or use the sample bill), and watch the pipeline: local
OCR in the browser → regex parse → Workers AI fallback if needed → confirm
screen or auto-log reply. The confirm screen shows the OCR read-back with the
captured date/amount and a **Retry OCR** button. The dashboard shows the logged
bills with month/category/vendor filters, the auto-log KPI, and CSV export.

Set `GEMINI_MOCK=true` in `.dev.vars` for deterministic canned AI readings
(no Workers AI quota); leave it unset to exercise the real `env.AI` binding.

## Environment variables

| Variable | Required for | Purpose |
|---|---|---|
| `WHATSAPP_VERIFY_TOKEN` | real webhook | Verify-token handshake (GET `/webhook`) |
| `WHATSAPP_APP_SECRET` | real webhook | X-Hub-Signature-256 verification |
| `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TOKEN` | real webhook | Sending replies + media download |
| `AI_MODEL` | — (optional) | Workers AI text model override (default: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`) |
| `AI_VISION_MODEL` | — (optional) | Vision model override (default: `@cf/llava-hf/llava-1.5-7b-hf`) |
| `GEMINI_MOCK` | — (dev only) | `true` → deterministic mock AI extractor, never in production |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | real stores / smoke | Supabase REST + Storage (service-role is server-side only) |
| `DEV_DEMO` | demo (dev only) | `true` → enables `/dev/*` routes |
| `EXTRACTION_*`, `DRAFT_TTL_MINUTES`, `NUDGE_DELAY_MINUTES`, `UNDO_*` | — (optional) | §5.4 thresholds and §5.6/§5.8 TTLs; defaults in `src/config.ts` |

## Local Supabase + smoke test

```bash
npx supabase init           # creates supabase/config.toml (not committed)
npx supabase start          # boots local Postgres + Storage
npx supabase db reset       # applies supabase/migrations/ + supabase/seed.sql
cp .env.smoke.example .env.smoke
# fill in SUPABASE_URL (http://127.0.0.1:54321) and the service-role key
# printed by `supabase start`
npm run smoke               # photo → confirm → undo against the real stores
```

`npm test` auto-skips the smoke test when `SUPABASE_URL` isn't present, so a
clone without Supabase still gets a green suite.

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
node eval/generate-bill.mjs  # draw the synthetic photo-like corpus images
```

## Checks and scripts

```bash
npm run typecheck   # tsc, both app and test configs
npm test            # vitest — unit + flow tests (smoke auto-skipped)
npm run smoke       # Supabase round trip (needs local Supabase, see above)
npm run dev         # wrangler dev (add -- --var DEV_DEMO:true for the demo)
npm run deploy      # wrangler deploy
```

## Deploying

```bash
wrangler secret put WHATSAPP_VERIFY_TOKEN
wrangler secret put WHATSAPP_APP_SECRET
wrangler secret put WHATSAPP_PHONE_NUMBER_ID
wrangler secret put WHATSAPP_TOKEN
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npm run deploy
```

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
├── db/                   # Supabase REST stores (users, businesses, drafts)
├── storage/              # bills bucket uploads
└── dev/                  # demo console, dashboard, in-memory stores
eval/                     # §5.7 golden corpus + harness, OCR runner, sweep
supabase/migrations/      # schema, RLS, storage bucket (0001–0003) + seed
tests/                    # vitest suite (unit + flows + smoke)
```
