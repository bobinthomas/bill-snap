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
- A Cloudflare account (`npx wrangler login`) — only needed for **deploying**
  (the Workers AI binding is remote-only and lives in `wrangler.deploy.toml`,
  so local dev and CI run without any Cloudflare credentials)
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

### Full stack in one command (`npm run dev:full`)

Want the real Supabase stores, storage bucket, and the smoke-test wiring too?
`npm run dev:full` (requires **Docker Desktop running** and the Supabase CLI,
which `npx` fetches on first use) does it all in one step:

1. uses the committed `supabase/config.toml` (pinned project `bill-snap` and
   ports, so every clone boots the same stack; `supabase init` runs only if
   you deleted that file)
2. starts local Supabase (`supabase start`) — first run pulls Docker images
3. applies `supabase/migrations/` + `supabase/seed.sql` (`supabase db reset`;
   this resets local DB data to the seeded state each run)
4. writes `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` into `.dev.vars` and
   `.env.smoke`, preserving any WhatsApp tokens already there
5. runs `wrangler dev` with the demo enabled and waits for `/health`

The demo then runs against real Supabase (badge shows `persistence: supabase`),
and `npm run smoke` works because `.env.smoke` is already populated. Use a
different worker port with `DEV_PORT=8790 npm run dev:full`. If you only want
the demo without any infrastructure, keep using the in-memory path above.

`RUN_SMOKE=1 npm run dev:full` additionally runs the smoke test (photo →
confirm → undo) against the freshly reset Supabase **before** starting
`wrangler dev`, and prints a one-line pass/fail report. Because the bootstrap
just wrote `.env.smoke`, the smoke runs for real (never auto-skips); if the
round trip fails, the bootstrap aborts with the failure shown — rerun without
`RUN_SMOKE=1` to skip the gate.

Tear it all down with `npm run dev:down` — it stops the `wrangler dev`
listening on the dev port (finding the real port-holder, so it also catches
an orphaned server a hard Ctrl+C left behind) and runs `npx supabase stop`
(keeps data volumes; `npx supabase stop --no-backup` deletes them). It's safe
to run when nothing is up — it reports what it stopped and exits 0. Use
`DEV_PORT=8790 npm run dev:down` to match a custom worker port.

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
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | real stores / smoke | Supabase REST + Storage (service-role is server-side only) |
| `DEV_DEMO` | demo (dev only) | `true` → enables `/dev/*` routes |
| `EXTRACTION_*`, `DRAFT_TTL_MINUTES`, `NUDGE_DELAY_MINUTES`, `UNDO_*` | — (optional) | §5.4 thresholds and §5.6/§5.8 TTLs; defaults in `src/config.ts` |

## Local Supabase + smoke test

```bash
npx supabase start          # boots local Postgres + Storage (config.toml is
                            # committed and pinned — no `supabase init` needed)
npx supabase db reset       # applies supabase/migrations/ + supabase/seed.sql
cp .env.smoke.example .env.smoke
# fill in SUPABASE_URL (http://127.0.0.1:54321) and the service-role key
# printed by `supabase start`
npm run smoke               # photo → confirm → undo against the real stores
```

`supabase/config.toml` is committed with `project_id = "bill-snap"` and every
local port pinned (54321 API / 54322 Postgres / 54323 Studio / …), so a fresh
clone gets the exact same local stack as everyone else — delete it and re-run
`npx supabase init` only if you want to regenerate it from the CLI template.

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
npm test            # vitest — unit + flow tests (smoke auto-skipped)
npm run smoke       # Supabase round trip (needs local Supabase, see above)
npm run dev         # wrangler dev (add -- --var DEV_DEMO:true for the demo)
npm run dev:full    # one-command bootstrap: Supabase up + seed + wrangler dev
                    #   (RUN_SMOKE=1 npm run dev:full also runs the smoke first)
npm run dev:down    # teardown: stop wrangler dev on the dev port + supabase stop
npm run deploy      # wrangler deploy -c wrangler.deploy.toml (adds the AI binding)
```

## Deploying

Deploys are automated: the **Deploy** workflow (`.github/workflows/deploy.yml`)
runs on every push to `main` and on `v*` tags — it re-runs the full CI gates
(typecheck, tests, the §5.7 eval, and the Supabase smoke round trip, which
boots local Supabase on the runner and runs `npm run smoke` against the real
migrations + seed) and only then `wrangler deploy`s. Configure
GitHub Actions secrets for the deploy:

- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (Cloudflare API token with
  Workers edit permission)
- the six worker secrets: `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`,
  `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_TOKEN`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY` — set as Cloudflare secrets by the workflow
  before each deploy
- optional `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` — authenticates the Docker
  pulls in the smoke and Bootstrap E2E jobs, which avoids anonymous
  rate-limit flakes (`toomanyrequests`) when parallel jobs pull the Supabase
  images on shared runner IPs

Manual deploy (same steps, no CI gate):

```bash
wrangler secret put WHATSAPP_VERIFY_TOKEN
wrangler secret put WHATSAPP_APP_SECRET
wrangler secret put WHATSAPP_PHONE_NUMBER_ID
wrangler secret put WHATSAPP_TOKEN
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npm run deploy
```

A separate **Bootstrap E2E** workflow (`.github/workflows/bootstrap-e2e.yml`, on
main / `v*` tags / manual dispatch) proves the bootstrap itself: it runs
`npm run dev:full` on a real Docker runner, waits for the ✅ Full stack banner,
asserts the demo/dashboard endpoints and env wiring, then runs `npm run dev:down`
and reports the banner in the job summary.

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
