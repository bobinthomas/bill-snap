# PRD: BillSnap — Business Payment Tracker via WhatsApp

**Version:** 1.0  
**Date:** 14 August 2026  
**Status:** Draft — Deliberation  
**Author:** Product Team  

---

## 1. Overview

### 1.1 Problem Statement
Small business owners in Australia spend 4–6 hours per week manually logging incoming and outgoing payments. They take photos of bills and invoices but have no structured system to extract, categorise, and track them. Existing accounting software (Xero, MYOB) requires manual data entry or expensive add-ons. Spreadsheets are error-prone and lack audit trails.

### 1.2 Product Vision
**BillSnap** is a zero-cost, WhatsApp-first payment tracker that uses AI to read bill and invoice photos, extracts key financial data, and lets business owners confirm or edit in seconds. Every transaction is stored with its original image as proof.

### 1.3 Value Proposition
> "Snap a bill in WhatsApp. We read it. You tap confirm. Done."

### 1.4 Target Market
- Australian small businesses (1–20 employees)
- Tradies, cafés, retail shops, consultancies
- Owner-operators who do their own books or delegate to staff
- Businesses not yet using formal accounting software, or using it only for BAS lodgement

---

## 2. Target Users

### 2.1 Primary: Business Owner
- **Goal:** Know what the business owes and is owed, without manual data entry.
- **Pain:** Typing invoice details into spreadsheets, losing paper receipts, GST calculation errors.
- **Tech comfort:** High WhatsApp usage, low tolerance for new apps.

### 2.2 Secondary: Staff Member / Bookkeeper
- **Goal:** Quickly log bills they pay or receive on behalf of the business.
- **Pain:** Remembering to hand over paper receipts, writing amounts in a logbook.
- **Tech comfort:** WhatsApp only. Will not install a separate app.

### 2.3 Tertiary: Accountant
- **Goal:** Receive clean, exportable data with original images for audit.
- **Pain:** Chasing clients for receipts, reconciling messy spreadsheets.
- **Tech comfort:** Expects CSV/PDF export, ABN validation, GST summaries.

---

## 3. Core Features

### 3.1 MVP (Phase 1)

| ID | Feature | Description | Priority |
|----|---------|-------------|----------|
| F1 | WhatsApp Photo Receipt | User sends a photo of a bill or invoice to a WhatsApp business number. | P0 |
| F2 | AI Extraction | System extracts amount, date, vendor name, ABN, and GST (regex-first over the OCR text, with a Workers AI fallback). | P0 |
| F3 | Confirm Screen | Extracted data is presented to the user in WhatsApp for one-tap confirmation or quick edit. | P0 |
| F4 | Structured Storage | Every transaction saved with amount, category, vendor, GST, image URL, and timestamp. | P0 |
| F5 | Daily Summary | Automated end-of-day WhatsApp summary of all logged transactions. | P1 |
| F6 | Search & Query | User can text "Show me Telstra bills" or "This month total" and get a reply. | P1 |

### 3.2 Post-MVP (Phase 2)

| ID | Feature | Description | Priority |
|----|---------|-------------|----------|
| F7 | Recurring Payments | Auto-log monthly rent, wages, subscriptions based on user-defined rules. | P2 |
| F8 | Due-Date Alerts | Notify user 3 days before an extracted due date for payables. | P2 |
| F9 | Cash Flow Calendar | Calendar view (via simple web link) showing incoming vs. outgoing by date. | P2 |
| F10 | GST/BAS Export | One-click export of quarterly GST collected vs. paid, with ABN breakdown. | P2 |
| F11 | Multi-User Permissions | Owner vs. staff roles. Staff can only log outgoing; owner sees everything. | P2 |
| F12 | Accountant Share | Generate a read-only export link or email PDF for the accountant. | P3 |

---

## 4. User Stories & Flows

### 4.1 US-001: Log an Outgoing Bill

**As a** business owner, **I want to** snap a photo of a supplier invoice, **so that** it is logged without typing.

**Flow:**
1. User opens WhatsApp and sends a photo of an electricity bill to the BillSnap number.
2. System receives the image, downloads it, uploads to Supabase Storage.
3. The image's OCR text is parsed by the regex parser first (§5.3); if regex cannot find the amount, the Workers AI text fallback (`env.AI`) reads the same OCR text. Photos with no OCR text at all (the real webhook passes image bytes only) go to the Workers AI vision model, which reads the image directly. Both return structured fields (amount, date, vendor, ABN, GST, invoice number) as JSON.
4. Validation layer checks the ABN checksum, recomputes GST, and normalises date and amount; the duplicate check runs (`invoice_number` + `vendor` + `amount` within the last 90 days).
5. If extraction is **High confidence** (gating rule, §5.4) and no duplicate is detected: the transaction is logged automatically (`status: logged`, `confirmed_at` stamped) and the system replies: "✅ Logged: $245.00 | Utilities | Telstra. GST: $22.27. Reply `delete` within 24 hours to undo." (auto-log policy, §5.8)
6. If extraction is **Partial** (gating rule, §5.4), or High confidence with a duplicate or `auto_save` disabled: system replies with extracted data and "1️⃣ Confirm 2️⃣ Edit" (§6.2).
7. If extraction is **Low / failed** (gating rule, §5.4): regex falls back over any available text; if that also fails, system replies with a raw text preview and asks the user to reply in format `AMOUNT CATEGORY VENDOR` — an optional date may appear anywhere in the reply (e.g. `telstra 245.00 10-Aug-2026`); dash-separated dates like `10-Aug-2026` and `DD/MM/YYYY` are both accepted.
8. User taps "1" (or replies "confirm") on a confirm screen.
9. System saves transaction as `status: logged` and replies: "✅ Logged: $245.00 | Utilities | Telstra. GST: $22.27."

**Edge Cases:**
- Blurry image → degraded OCR text → regex finds no amount → the Workers AI fallback returns missing/low-confidence fields, then the manual entry prompt.
- Duplicate detected → auto-log is skipped; the confirm screen shows the warning: "This looks like INV-2847 logged on 10 Aug. Log again?" with Confirm/Skip.
- Multiple images in one message → process first, queue others with "+2 more images. Reply NEXT to process."

### 4.2 US-002: Log a Daily Cash Payment (No Photo)

**As a** business owner, **I want to** log a wage or misc payment without a photo, **so that** cash outflows are tracked.

**Flow:**
1. User sends text: `wages 500 rajesh` or `misc 45 coffee`.
2. System parses: `CATEGORY AMOUNT [VENDOR/NOTE]`.
3. System replies: "✅ Logged: $500.00 | Wages | Rajesh. Confirm?"
4. User confirms.

### 4.3 US-003: Review Daily Activity

**As a** business owner, **I want to** see what was logged today, **so that** I know my cash position.

**Flow:**
1. User sends: `summary` or `today`.
2. System queries DB for today's transactions by `business_id` (owners see all staff logs; `user_phone` scopes a staff member's own view).
3. System replies:
   ```
   📊 Today (14 Aug)

   💸 OUT: $1,240
   ├─ Wages: $500
   ├─ Utilities: $245
   └─ Inventory: $495

   💰 IN: $0

   Net: -$1,240
   ```

### 4.4 US-004: Search Historical Transactions

**As a** business owner, **I want to** find old bills by vendor or amount, **so that** I can answer accountant queries.

**Flow:**
1. User sends: `find telstra` or `show august utilities`.
2. System queries DB with fuzzy match on vendor/category/date.
3. System replies with top 5 matches:
   ```
   🔍 Results for "telstra"

   1. $245 | 10 Aug | Utilities
   2. $198 | 12 Jul | Utilities
   Reply 1, 2 for details.
   ```

### 4.5 US-005: Onboard a New Business (First Contact)

**As a** new business owner, **I want to** start logging bills immediately with zero setup, **so that** my first bill is confirmed in under a minute.

**Flow:**
1. An unknown phone number sends any first message (photo or text).
2. System auto-creates the `users` row (phone number), a `businesses` row (name defaults to "My Business", `timezone` defaults to `Australia/Sydney`, `gst_registered` defaults to `true`), and the owner `memberships` row — sensible defaults so nothing blocks the first bill.
3. System replies with the welcome message:
   ```
   👋 Welcome to BillSnap!

   Snap a photo of any bill or invoice — I'll read the amount,
   date, vendor, and GST, and you just tap confirm.

   No photo? Log cash payments as text: wages 500 rajesh

   Reply `setup` to set your business name, timezone, and GST
   status — or send your first bill now.
   ```
4. If the first message was a photo, it proceeds straight into US-001 (the welcome is sent alongside "📸 Received. Reading...").
5. After the first confirmed transaction, a one-time settings prompt keeps capture off the critical path: "✅ First bill logged! Reply `setup` to set your business name, timezone, and GST status for accurate summaries — or `skip`."

**Settings wizard (`setup`)** — each step replies `skip` to keep the default:
1. "Business name? (currently: My Business)" → updates `businesses.name`.
2. "Timezone? Reply `sydney`, `melbourne`, `brisbane`, `perth`, `adelaide`, `darwin`, `hobart`, or `canberra` (currently Australia/Sydney)" → updates `businesses.timezone`, which defines "today" for summaries (§4.3).
3. "Are you GST-registered? Reply `yes` or `no` (currently yes)" → updates `businesses.gst_registered`; affects GST display from then on (§5.3).
4. "✅ Settings saved. Send your first bill!"

**Edge Cases:**
- Unknown user sends only commands (`summary`, `find`) before any bill → reply with the welcome message; data-less commands return empty results rather than failing.
- Onboarding runs once; `setup` stays available anytime to change settings.
- Photo-first onboarding never blocks: business creation is synchronous with defaults, and settings capture is always deferred.

---

## 5. Technical Architecture

### 5.1 System Diagram

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────────┐
│   WhatsApp  │────▶│  Cloudflare      │────▶│  Workers AI      │
│   (User)    │◀────│  Worker          │◀────│  (text fallback) │
└─────────────┘     └──────────────────┘     └──────────────────┘
                           │
                           ▼
                    ┌──────────────────┐
                    │  Supabase        │
                    │  • PostgreSQL    │
                    │  • Storage       │
                    └──────────────────┘
```

### 5.2 Component Responsibilities

| Component | Role |
|-----------|------|
| **WhatsApp Cloud API** | Message transport. Receives images/text. Sends replies. |
| **Cloudflare Worker** | Stateless webhook handler. Orchestrates extraction, parsing, DB writes. Zero cold start. |
| **Regex Parser** | Deterministic PRIMARY parser over the OCR/typed text layer — no external API, no latency, no quota. |
| **Workers AI (`env.AI`)** | FALLBACK when regex cannot find the amount: text-model JSON extraction over OCR text, plus the vision model (`@cf/llava-hf/llava-1.5-7b-hf`) reading photo bytes when no OCR text exists — both via the Worker's native binding, no API key, no external HTTP. |
| **Supabase PostgreSQL** | Transactional data store. User profiles, transactions, audit logs. |
| **Supabase Storage** | Bill image repository. Public URLs for the accountant share and future re-reading (§5.5). |

### 5.3 Extraction Strategy (Core USP)

**Primary Parser: Regex + Heuristics**
- Runs deterministically over the available text layer — local OCR text for photos, typed text for manual entries (`wages 500 rajesh`) — with no external API, no latency, and no quota.
- Amount: patterns `$4,850.00`, `AUD 4850`, `Total: 4850`; overseas card receipts (`Rs`/`INR`/`₹`) are also read — the amount owed is the largest currency amount on a total-like line, matched fuzzily so OCR-mangled labels (`101AL` for `TOTAL`) still fire, with `credit` lines excluded.
- Date: `DD/MM/YYYY`, `DD-MMM-YYYY` (Australian format — e.g. `10-Aug-2026`), dash/dot-separated `DD-MM-YYYY` / `DD.MM.YYYY`, and a DATE-label fallback that recovers space-month shapes (`09 May 2009`) from surviving `DATE :` lines. Date-shaped fragments that cannot be validated are stripped by the §5.7 guard so their digits never become the amount or the vendor.
- ABN: 11 digits with optional spaces, validated via checksum.
- GST: detect "GST INCLUSIVE" / "INC GST" → compute `amount / 11`; else `amount × 0.10`.
- Vendor: the first clean-looking line block of the raw text (letter-dense lines with at least one real word) — never the concatenation of every surviving OCR token, which turned noisy thermal receipts into a garbage wall.

**Fallback Parser: Workers AI (`env.AI`)**
- Text fallback — runs only when regex cannot find the amount in the OCR text. Calls the Worker's native binding — `env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", { prompt, max_tokens: 256, temperature: 0.1 })` — no external HTTP request, no API key, no base URL. (Llama 3.3 70B fp8-fast is a current catalog model; llama-3.1-8b-instruct was deprecated in the 2026-05-30 catalog refresh — `AI_MODEL` overrides the default per workspace.)
- Vision path — photos with **no OCR text** (the real WhatsApp webhook passes image bytes only; there is no server-side OCR) go to the vision model `env.AI.run("@cf/llava-hf/llava-1.5-7b-hf", { image: <binary bytes>, prompt, max_tokens: 256, temperature: 0.1 })`. LLaVA reads the image bytes directly and returns the same JSON schema, so a photo no longer falls straight through to manual entry; if it fails (binding down, unparseable JSON) the photo still lands on the manual-entry prompt. `AI_VISION_MODEL` overrides the default per workspace.
- The system prompt asks for structured JSON: `amount` (AUD), `vendor`, `date` (DD/MM/YYYY), `abn`, `gst`, `gst_basis`, `category`, `invoice_number`, `due_date`, and an overall `confidence` (`high`/`medium`/`low`). The text model reads the OCR text; the vision model reads the image — both are instructed to output `null` for anything not literally present, never to invent values.
- The response is parsed with `JSON.parse`; garbage or unparseable output is treated exactly like a regex failure: the regex result stands and the user is asked to reply with `AMOUNT CATEGORY VENDOR`.
- Anti-fabrication guard (text path): an AI-reported amount/date whose digits do not literally appear in the OCR text is nulled — a hallucinated reading drops the gate to Low and the user is asked for a manual entry instead of being offered a made-up amount. (The guard cannot run on the vision path, which has no text to check against; the machine-read confirm screen is the net there.)
- Workers AI output is the one **trusted** reading: it is not machine-read, so a High-confidence AI extraction auto-logs with the 24-hour undo window, the duplicate gate and the business's `auto_save` opt-out (§5.8, 4.1 step 5).

**Shared Validation Layer**
- Runs on all parsers before the confirm screen is built: ABN checksum validation, GST inclusive/exclusive recomputation, date normalisation to ISO, amount normalisation to AUD decimal, and fabricated invoice numbers dropped (a run of ≥ 10 identical digits, e.g. a vision model's all-zero hallucination, is not an invoice).
- GST is stored as null when the business is not GST-registered (`businesses.gst_registered`), regardless of `gst_basis` — the confirm screen then shows "GST: —".

**Machine-read policy.** Regex, OCR and typed manual entries are machine-read: they always land on a confirm screen (§6.2 Variant C) and are never auto-logged. **Workers AI readings (text + vision) are the trusted parser** — they are not machine-read, so High-confidence AI extractions auto-log per §5.8 (24-hour undo window, duplicate gate, `auto_save` opt-out). The confirm screen still appears for AI readings that are Partial/Low, duplicated, or blocked by `auto_save = false`.

### 5.4 Extraction Schema & Confidence Gating

**Parser response schema** — every parser emits this shape after the shared validation layer. `value` is `null` for any field that cannot be found (never guess); `confidence` is the parser's score in [0, 1]. Dates come back as ISO `YYYY-MM-DD`, amounts as decimal AUD. Regex produces this shape directly (confidence 0/1); the Workers AI fallback returns a flatter JSON — plain fields plus an overall `high`/`medium`/`low` confidence — that is mapped into this schema.

```json
{
  "amount":         { "value": 245.00,          "confidence": 0.97 },
  "date":           { "value": "2026-08-10",   "confidence": 0.99 },
  "vendor":         { "value": "Telstra",      "confidence": 0.95 },
  "abn":            { "value": "12 345 678 901", "confidence": 0.90 },
  "gst":            { "value": 22.27,           "confidence": 0.92 },
  "gst_basis":      "inclusive",
  "invoice_number": { "value": "INV-2847",     "confidence": 0.88 },
  "due_date":       { "value": "2026-09-10",   "confidence": 0.85 },
  "category_hint":  { "value": "utilities",    "confidence": 0.60 }
}
```

- `gst_basis` is an enum: `inclusive` (GST = amount / 11), `exclusive` (GST = amount × 0.10), or `none` (GST = null; confirm screen shows "GST: —"). Final GST is always recomputed by the shared validation layer, never taken verbatim from the parser.
- `category_hint` is advisory only — the user picks the final category on the confirm screen; it is never used to auto-save.
- The full response is stored in `transactions.raw_extraction` (jsonb) for debugging and re-parsing.

**Per-field thresholds** — each field is **high** (usable as-is), **low** (shown with a verify/edit flag), or **absent** (`value: null`):

| Field | High (≥) | Low band | Absent / dropped when |
|-------|----------|----------|----------------------|
| `amount` | 0.90 | 0.70–0.89 | < 0.70 |
| `date` | 0.85 | 0.60–0.84 | < 0.60 |
| `vendor` | 0.75 | 0.50–0.74 | < 0.50 |
| `abn` | 0.80 + passes checksum | — | fails checksum → show "ABN not verified" |
| `gst`, `invoice_number`, `due_date` | 0.70 | — | absence never blocks confirmation |

**Gating rule** — every bill image is classified into exactly one level; 4.1 steps 5–7 dispatch on it:

1. **High confidence** → auto-log with 24-hour undo (§5.8, 4.1 step 5): `amount` high AND `date` high AND `vendor` non-null, AND the source is Workers AI (the trusted parser, §5.3). The confirm screen (6.2 Variant A) appears only when auto-log is disabled (`auto_save = false`), a duplicate is suspected, or the reading came from regex/OCR (always machine-read).
2. **Partial** → confirm screen with each missing/low field flagged "Not found — edit to add" (4.1 step 6; user can still confirm): `amount` high but `date` or `vendor` absent/low, or `amount` low (0.70–0.89).
3. **Low / failed** → 4.1 step 7: `amount` absent or < 0.70 — regex found no amount and the Workers AI fallback either failed (garbage/unparseable JSON) or also returned nothing. Reply with a raw-text preview and ask for `AMOUNT CATEGORY VENDOR`.

Thresholds are configurable via Worker environment variables so they can be tuned against the eval corpus without code deploys.

### 5.5 Data Model

**Table: `businesses`** — the tenant behind every multi-user feature (F11/F12). Phase 1 auto-creates one per owner on first confirmed transaction; staff join via invite in Phase 3.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid (PK) | |
| name | text | Business name |
| abn | text | 11-digit ABN if provided |
| timezone | text | IANA tz (e.g. `Australia/Sydney`) — defines "today" for summaries (§4.3) and the daily-summary boundary |
| gst_registered | boolean | Whether the business charges/claims GST — controls GST computation and display (§5.3) |
| auto_save | boolean | Auto-log High-confidence extractions (default `true`; §5.8) |
| created_at | timestamptz | |

**Table: `users`** — one row per WhatsApp number.

| Column | Type | Description |
|--------|------|-------------|
| phone_number | text (PK) | WhatsApp number |
| business_id | uuid (FK) | Links to `businesses`; auto-created on first contact (§4.5) |
| created_at | timestamptz | |

**Table: `memberships`** — business ↔ user. Role lives here (not on `users`) so a person can belong to multiple businesses and permissions follow the membership.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid (PK) | |
| business_id | uuid (FK) | |
| user_phone | text (FK) | |
| role | text | `owner` / `staff` |
| created_at | timestamptz | |

**Table: `share_links`** — read-only accountant access (F12). Each link scopes to one business and expires.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid (PK) | |
| business_id | uuid (FK) | |
| token | text | Unguessable, short-lived |
| created_by | text (FK) | Owner's phone number |
| expires_at | timestamptz | |
| created_at | timestamptz | |

**Table: `transactions`**
| Column | Type | Description |
|--------|------|-------------|
| id | uuid (PK) | |
| business_id | uuid (FK) | Denormalised tenant key — owner "see everything", summaries, and search all scope on it (§4.3/§4.4) |
| user_phone | text (FK) | Who logged it — staff log on the business's behalf |
| type | text | `incoming` / `outgoing` |
| amount | decimal | AUD |
| gst | decimal | Auto-calculated from `gst_basis`; null when the business is not GST-registered |
| category | text | `wages`, `utilities`, `inventory`, `rent`, `misc` |
| vendor | text | |
| abn | text | 11-digit ABN if found |
| invoice_number | text | If found |
| due_date | date | If found |
| image_url | text | Supabase public URL |
| raw_extraction | jsonb | Full parser JSON response for debugging and re-parsing |
| status | text | `draft` / `logged` / `paid` / `overdue` / `expired` / `deleted` |
| flow_state | text | Active-draft state: `processing` / `awaiting_confirm` / `editing_amount` / `editing_vendor` / `editing_date` / `queued` (null once logged) |
| flow_expires_at | timestamptz | Draft TTL — checked on every message (10 min, configurable) |
| flow_nudged_at | timestamptz | When the confirm-screen nudge was sent (null until then; §6.2) |
| wa_message_id | text | Originating WhatsApp message ID — idempotency key |
| wa_received_at | timestamptz | Webhook receipt time |
| payment_method | text | `cash`, `bank_transfer`, `card`, `bpay` |
| created_at | timestamptz | |
| confirmed_at | timestamptz | |

**Storage Bucket: `bills`**
- Public read access (for re-reading and accountant export)
- Organised by `business_id/YYYY/MM/filename.jpg` (tenant-scoped so accountant share links and multi-user access are trivially scoped)

### 5.6 Session State, Queue & Idempotency

The Worker is stateless, but the product is a multi-turn state machine: photo → draft → confirm → logged, single-field edits, the multi-image queue, and undo. All transient state lives in PostgreSQL so any Worker instance can resume any conversation with one query per message. RLS (7.3) applies unchanged, because drafts are `transactions` rows.

**Drafts are `transactions` rows.** A draft is a row with `status: draft` plus the flow columns defined in 5.5. The row is created on webhook receipt — before extraction — so a retried delivery can never double-process. Confirming flips the same row to `logged` and stamps `confirmed_at`; edits mutate it in place; discarding sets `expired`. Nothing is ever hard-deleted (7.4).

**Message routing.** Every webhook delivery:
1. Validate the WhatsApp webhook signature (`X-Hub-Signature-256`).
2. Idempotency: `(user_phone, wa_message_id)` is unique on draft rows, so re-delivered image messages find their draft and are ignored. Commands are naturally idempotent (a re-delivered `delete` is a no-op).
3. Load the user's active draft: `status: draft` AND `flow_expires_at > now`.
4. Route: unknown user (no `users` row) → onboarding (§4.5); active draft → act on its `flow_state` (6.2 options, 6.3 edits); none → command parser (`summary`, `find`, `delete`, `help`, `NEXT`, `setup`).

**Multi-image queue.** A message with N images creates N draft rows. The first is extracted immediately and set to `awaiting_confirm`; the rest stay `queued` holding only `image_url` + `wa_message_id`. Extraction for queued images runs lazily when the user replies `NEXT` (promoting the oldest `queued` draft to `awaiting_confirm`), so ignored images never consume an extraction. Queued drafts expire under the same TTL.

**Edit state (6.3).** Replies 2️⃣/3️⃣/5️⃣ set `flow_state` to `editing_amount` / `editing_vendor` / `editing_date`; the next message is validated, applied, and the screen re-renders with `flow_state` back to `awaiting_confirm`. `4`, `help`, or a new photo cancels — a new photo also expires the whole draft.

**Undo (window by path).** `delete` finds the user's most recent row with `status: logged` or `paid` within the undo window, then sets it to `deleted` (soft delete per 7.4). The window is 24 hours for auto-logged bills (High confidence, §5.8) and 5 minutes for confirm-path bills, measured from `confirmed_at` in both cases.

**Nudge & expiry.** A scheduled sweep sends the confirm-screen nudge (§6.2) to drafts still awaiting a reply — one nudge per draft, timed ~6 minutes after the confirm screen so the user has ~4 minutes to act before expiry. Drafts past `flow_expires_at` are treated as expired on access; the same sweep flips them to `status: expired`. TTLs (draft 10 min, nudge delay 6 min, undo 24 h / 5 min) are env-configurable.

### 5.7 Extraction Evaluation & Regression Harness

The 5.4 thresholds and the auto-extract KPI (§8.2) are only meaningful if extraction changes can be measured. Every change to the extraction prompt, the confidence thresholds, or the regex parser ships through this harness first.

**Golden corpus (first pass).**
- ~100 real Australian bills donated with permission (tradies, cafés, retail) covering electricity/telecom/internet, rent, supplier invoices, fuel, cash receipts, and GST-inclusive vs GST-exclusive vs no-GST documents. High-fidelity mockups fill gaps where donated bills are unavailable — user uploads are never used.
- Hard cases are deliberate: crumpled/blurry photos, portrait vs landscape, dark or angled shots, handwritten amounts, and non-bill images (to exercise the polite-redirect path).
- Each image carries ground-truth labels in the exact §5.4 schema: expected `amount`, `date`, `vendor`, `abn`, `gst`, `gst_basis`, `invoice_number`, `due_date`, plus a `should_log` flag.
- The corpus lives in a private bucket (never user data), labels in the repo. Every real support ticket (< 5 per 100 bills, §8.2) is a standing invitation to add its bill to the corpus.

**Pass criteria (tied to §8.2 KPIs).**
- **Auto-extract success rate** = share of corpus images that reach a High or Partial confirm screen with the correct `amount` and `date`. Target ≥ 70% at MVP launch and ≥ 85% by Month 3; any prompt/threshold change must not drop the current rate by more than 2 points.
- **Field accuracy** (where a field is present and High confidence): `amount` ≥ 95%, `date` ≥ 90%, `vendor` ≥ 80%. A change may trade one field against another but never goes below these floors.
- **Gating correctness**: the harness reclassifies every corpus image into a §5.4 level; a change that flips a High-confidence image to Low (or vice versa) beyond a small tolerance fails.
- **GST correctness**: computed GST matches ground truth for every `gst_basis` value within 1 cent.

**Regression workflow.**
1. Run the harness against the current pipeline → baseline report: success rate, per-field accuracy, gating distribution, and per-bill failures with their raw extraction JSON for inspection. Reports are committed so drift is visible.
2. A proposed prompt/threshold/regex change produces its own report.
3. The change ships only if it clears the pass criteria — no regressions beyond tolerance, no success-rate drop.
4. The full corpus (~100 entries) runs at launch and every Phase gate; a hard-case subset (e.g. 20 images) is used for quick iteration between gates.

**Threshold tuning.** Initial 5.4 thresholds are set from the first full corpus run by sweeping e.g. the `amount` threshold across 0.80–0.95 to find an operating point where success rate and field accuracy both clear their targets. Because thresholds are env-configurable (§5.4), tuning never requires a deploy.

### 5.8 Product Decision: Auto-Log vs Always-Confirm

**Status: decided (Option B adopted).** This PRD specifies **auto-log on High confidence** with undo as the safety net. Option A (always confirm) is retained below for comparison and as the behavior when auto-log is disabled for a business.

The core tension: the USP claims "speed, not autonomy", yet the North Star — median time to log < 15 s — is dominated by the confirm round-trip, and users who never reply to the confirm screen silently lose their bill (a real data-loss path under Option A).

**Option B — auto-log on High confidence, with undo as the safety net:**
- **Trigger:** extraction is High confidence (§5.4: `amount` ≥ 0.90, `date` ≥ 0.85, `vendor` non-null) AND the duplicate check passes (no `invoice_number` + `vendor` + `amount` match in the last 90 days) AND the business has completed onboarding (§4.5).
- **Behavior:** the transaction is logged immediately (`status: logged`, `confirmed_at` stamped). Reply: "✅ Logged: $245.00 | Utilities | Telstra. GST: $22.27. Reply `delete` within 24 hours to undo."
- **Safety net:** the existing `delete` command (§5.6, window measured from `confirmed_at`), extended to 24 hours for auto-logged bills so mistakes are easy to fix long after the fact.
- **Unchanged paths:** Partial (level 2) and Low/failed (level 3) extractions always show the confirm screen (§6.2 variants B/C) — confirmation remains the rule whenever confidence is not maximal or a duplicate is suspected.
- **Opt-out:** `businesses.auto_save` (default `true`) lets an owner force always-confirm for their business.
- **Adopted changes:** §4.1 step 5 auto-logs High-confidence extractions (no confirm tap); §5.3's auto-save policy replaces the old "Never auto-save" paragraph; duplicate detection is Phase 1 because it gates every auto-log.

**§8.2 KPI set under Option B (adopted):**

| Metric | Option A (MVP → M3) | Option B (MVP → M3) |
|--------|---------------------|---------------------|
| Auto-extract success rate | 70% → 85% | 70% → 85% (unchanged — extraction quality is orthogonal) |
| User confirmation rate (no edit) | 60% → 75% | — (replaced by undo rate) |
| Auto-log rate (share of bills logged without a confirm tap) | 0% (by design) | ≥ 60% → ≥ 75% |
| Undo/delete rate | < 1% | < 2% — the safety net must stay rarely-used; a rising undo rate is a red flag on the High-confidence gate |
| Median time to log (North Star) | < 15 s | < 8 s for auto-logged bills; < 15 s overall |
| Support tickets / 100 bills | < 5 → < 2 | unchanged |

**Tradeoffs:**
- **For B:** removes the confirm round-trip — the largest term in time-to-log; eliminates silent data loss when users never reply to the confirm prompt; matches the "snap and done" value prop; the gating (§5.4), undo (§5.6), and eval harness (§5.7) that make it safe already exist.
- **Against B:** changes the trust posture — an incorrect auto-log hurts confidence more than a skipped confirm; duplicate detection and solid GST settings become launch requirements (moves Phase 2 scope into Phase 1); the confirm screen becomes the exception path, so undo discoverability and the `delete` prompt matter more.

**Decision:** Option B adopted for High-confidence extractions only, with `businesses.auto_save` opt-out and a 24-hour undo window for auto-logged bills. Decision owners: product lead + accountant representative (the audit story is the main risk).

---

## 6. WhatsApp Interaction Design

### 6.1 Message Types

| Trigger | Bot Response |
|---------|-------------|
| Photo sent | "📸 Received. Reading..." → extracted data → auto-log (High) or confirm buttons (Partial/Low, §5.8) |
| Text: `AMOUNT CATEGORY [VENDOR]` | "✅ Draft: $X \| Category. Confirm?" |
| Text: `summary` / `today` | Daily totals |
| Text: `find [keyword]` | Top 5 matching transactions |
| Text: `delete` | Undo last transaction (within 5 minutes) |
| Text: `help` | Command list |
| Text: `NEXT` | Process next queued image ("+2 more images" flow, §5.6) |
| First message from unknown number | Welcome + auto-create business (§4.5) |
| Text: `setup` | Edit business name / timezone / GST status (§4.5) |

### 6.2 Confirm Screen Format

The confirm screen adapts to the extraction gating level (see §5.4). Missing or low-confidence fields are never silently dropped — they are flagged so the user knows exactly what to check before confirming. All variants use the same numbered reply menu.

By default, High-confidence extractions auto-log and never reach this screen (§5.8); Variant A appears only when auto-log is disabled for the business (`businesses.auto_save = false`) or a duplicate is suspected.

**Variant A — High confidence (no edits required; auto-log disabled / duplicate)**

```
📄 Bill Read — ✅ High confidence

Amount: $245.00
Vendor: Telstra
Date: 10/08/2026
ABN: 12 345 678 901
GST: $22.27

Reply:
1️⃣ Confirm & Save
2️⃣ Edit amount
3️⃣ Edit vendor
4️⃣ Skip / Wrong bill
```

**Variant B — Partial (missing / low fields flagged)**

```
📄 Bill Read — ⚠️ Check details

Amount: $245.00
Vendor: Not found — edit to add
Date: 10/08/2026 ⚠️ verify
ABN: Not verified
GST: $22.27

Reply:
1️⃣ Confirm & Save
2️⃣ Edit amount
3️⃣ Edit vendor
4️⃣ Skip / Wrong bill
```

**Variant C — Low confidence recovered by regex (machine-read)**

```
📄 Bill Read — ⚠️ Machine-read, please verify

Amount: $245.00
Vendor: Telstra
Date: Not found — edit to add
GST: —

Reply:
1️⃣ Confirm & Save
2️⃣ Edit amount
3️⃣ Edit vendor
4️⃣ Skip / Wrong bill
```

Rules:
- "Not found — edit to add" marks an absent field; a value followed by "⚠️ verify" is below the high threshold and should be double-checked.
- "ABN: Not verified" means the ABN failed the checksum (or was below 0.80 confidence) — the field is shown but never trusted.
- "GST: —" is shown when `gst_basis` is `none`; GST is otherwise recomputed by the validation layer.
- If extraction is Low/failed and regex finds no amount, this screen is skipped entirely: the system replies with a raw-text preview and the manual-entry prompt (`AMOUNT CATEGORY VENDOR`, 4.1 step 6).

**Nudge (drafts awaiting a reply).** If the user does not reply, the system sends one re-prompt ~6 minutes after the confirm screen (leaving ~4 minutes before the 10-minute draft expiry): "⏳ This bill isn't saved yet. Reply `1` to confirm, `2`/`3` to edit, or `4` to skip."
- Applies to any draft in `awaiting_confirm` or `editing_*` state — Partial, machine-read (Variant C), auto-log-disabled, and duplicate-warning screens. Auto-logged bills and queued images are never nudged.
- Frequency cap: one nudge per draft (configurable); never repeated.
- Fires inside WhatsApp's 24-hour service window (the user messaged minutes earlier), so no pre-approved template is required.
- Mechanics and the `flow_nudged_at` column live in §5.6.

### 6.3 Edit Sub-Flows (Edit Amount / Edit Vendor)

Options 2️⃣ and 3️⃣ on every confirm-screen variant (6.2) enter a single-field edit sub-flow. The pending draft is untouched until the user confirms; once a user edits a field it is treated as user-verified, so its confidence flag is cleared when the screen re-renders.

**Edit amount (2️⃣)**
1. Bot replies: "✏️ Edit amount — reply with the correct amount, e.g. `245.00` (or `4` to cancel)."
2. User replies with a value.
3. Validation: parse as decimal AUD (accept `$`, commas, and `245.00`; reject non-numeric text).
   - Valid → update the draft amount, recompute GST from the draft's `gst_basis` (`inclusive` → amount / 11; `exclusive` → amount × 0.10; `none` → GST stays null), then re-render: "✅ Amount updated — $245.00" followed by the applicable 6.2 variant.
   - Invalid → bot replies: "That doesn't look like an amount — reply with digits only, e.g. `245.00`." and stays in the sub-flow.
4. Expiry: if the user sends nothing for 10 minutes, the edit — and the pending draft — is discarded.

**Edit vendor (3️⃣)**
1. Bot replies: "✏️ Edit vendor — reply with the correct business name, e.g. `Telstra` (or `4` to cancel)."
2. User replies with text.
3. Validation: non-empty, trimmed, ≤ 60 characters. Valid → update the draft vendor and re-render: "✅ Vendor updated — Telstra" + variant. Empty reply → re-prompt once, then return to the confirm screen.
4. Same 10-minute expiry as Edit amount.

**Shared rules**
- Only one edit at a time. Replying `4` (skip), sending a new photo, or sending `help` cancels the pending edit (a new photo also clears the draft).
- Confirming (`1️⃣`) on the re-rendered screen saves the transaction as `logged` with the edited values.
- A missing/low date (Variant B) surfaces an optional `5️⃣ Edit date` entry on the menu; it follows the same sub-flow with ISO `YYYY-MM-DD` validation.

---

## 7. Security & Privacy

### 7.1 Data Handling
- Images stored in Supabase (AWS Sydney region for Australian data residency).
- No images retained by Workers AI after processing.
- All API calls over HTTPS.
- WhatsApp end-to-end encryption applies to message transit.

### 7.2 Webhook Security
- **Verify-token handshake.** During setup, Meta calls `GET /webhook` with `hub.mode`, `hub.verify_token`, and `hub.challenge`. The Worker accepts only when `hub.mode = subscribe` and the token matches the `WHATSAPP_VERIFY_TOKEN` secret, echoing `hub.challenge` back; anything else returns 403.
- **Signature verification.** Every delivery carries `X-Hub-Signature-256`, an HMAC-SHA256 of the raw request body keyed with the WhatsApp app secret. The Worker recomputes it with a constant-time compare and rejects mismatches with 403 before any parsing or database write — this is step 1 of the routing pipeline in §5.6.
- **Rate limiting.** Per-user inbound limits (e.g. 30 messages/minute, burst 60) are enforced in the Worker with a short-window counter in Supabase; over-limit traffic gets a polite "slow down" reply rather than a silent drop. Outbound replies use a queue with retry/backoff so bursts stay within WhatsApp's own limits.
- **Secrets.** The app secret and verify token live in Worker environment secrets, never in code or logs; the Supabase service-role key is server-side only (7.3). WhatsApp message IDs are treated as untrusted input — used only as idempotency keys (§5.6).

### 7.3 Access Control
- Row Level Security (RLS) in Supabase: users can only read/write their own `phone_number` rows; `owner` members additionally read all rows scoped to their `business_id` (multi-user, F11).
- Service role key never exposed to client.

### 7.4 Compliance
- Australian Privacy Principles (APP): user data not shared with third parties beyond the Workers AI binding.
- GST records retained for 5 years (system enforces soft delete only).

---

## 8. Success Metrics

### 8.1 North Star
**Time to Log:** Median time from photo send to logged transaction < 15 seconds overall; < 8 seconds for auto-logged bills (§5.8).

### 8.2 KPIs

| Metric | Target (MVP) | Target (Month 3) |
|--------|-------------|------------------|
| Bills logged / user / week | 5 | 20 |
| Auto-extract success rate | 70% | 85% |
| Auto-log rate (logged without a confirm tap) | 60% | 75% |
| Undo/delete rate | < 2% | < 2% |
| Daily active users (DAU) | 5 | 50 |
| Support tickets / 100 bills | < 5 | < 2 |

*Adopted from §5.8: "User confirmation rate (no edit)" is replaced by auto-log rate and undo rate.*

### 8.3 Anti-Goals (What We Won't Track)
- Bank account sync or live balances.
- Payment execution (we track, don't pay).
- Multi-currency (AUD only for MVP).

---

## 9. Roadmap

### Phase 1: MVP (Weeks 1–2)
- WhatsApp webhook + image receive
- Regex parser (primary) + Workers AI fallback
- Auto-log + confirm/save flow (§5.8)
- Duplicate detection (gates auto-log)
- Daily summary command
- Supabase dashboard for owner review

### Phase 2: Polish (Weeks 3–4)
- Extraction eval harness on a golden corpus of Australian bills
- Search command
- ABN validation
- Undo/delete command (24 h / 5 min windows)

### Phase 3: Business Intelligence (Weeks 5–8)
- Recurring payment rules
- Due-date alerts
- Cash flow calendar (web view)
- GST/BAS quarterly export
- Multi-user (owner invites staff)

### Phase 4: Scale (Months 3–6)
- Accountant portal (read-only web access)
- Xero/MYOB CSV export
- BPay code extraction for payment initiation
- Voice note parsing

---

## 10. Non-Goals (Out of Scope for 6 Months)

1. **Native mobile app** — WhatsApp is the app.
2. **Automatic bank reconciliation** — manual confirmation only.
3. **Multi-currency** — AUD only.
4. **Payroll processing** — track wages, don't calculate tax/super.
5. **Invoice generation** — we track incoming invoices, don't create them.
6. **Real-time collaboration** — async WhatsApp is sufficient.
7. **AI chatbot** — command-based interface, not conversational.

---

## 11. Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|------------|
| Extraction accuracy too low on crumpled receipts | High | Medium | Regex + Workers AI fallback handle messy layouts; fallback to manual entry. Train users to photograph flat, well-lit bills. |
| WhatsApp API rate limits or policy changes | High | Low | Abstract message layer; can migrate to Telegram or native app if needed. |
| Workers AI quota/limits | Low | Low | Regex + manual entry cover overflow; Workers AI is metered per token and can be queued/batched off-peak. |
| User sends sensitive non-bill photos | Low | Medium | Auto-detect non-invoice images (no dollar amounts) → polite redirect. |
| Data privacy concerns (images on cloud) | Medium | Low | Clear privacy policy. Images encrypted at rest. No human review. |

---

## 12. Open Questions

1. Should we support **email forwarding** (e.g. forward PDF invoices to a WhatsApp-linked email)?
2. Should **staff** see only their own logs, or all business logs?
3. Do we need **BPay code + reference extraction** for Phase 1, or Phase 2?
4. Should the **daily summary** be opt-in, opt-out, or on-demand only?
5. Is there value in a **simple web dashboard** for Phase 1, or purely WhatsApp?

---

**End of PRD**
