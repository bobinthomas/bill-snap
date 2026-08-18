#!/usr/bin/env node
/**
 * One-command local dev bootstrap — `npm run dev:full`.
 *
 * Gets a fresh clone to a running full-stack dev environment in one step —
 * everything inside Cloudflare, no Docker, no Supabase:
 *   1. installs deps if node_modules is missing (`npm install`)
 *   2. applies the D1 migrations to the LOCAL D1 state
 *      (`wrangler d1 migrations apply bill-snap --local`) — the same
 *      migrations/0001_schema.sql that deploys to production, run against
 *      miniflare's local SQLite; no Cloudflare login, no account
 *   3. optionally runs the smoke test (photo → confirm → undo) against the
 *      D1 stores and reports the result — fails the bootstrap if the round
 *      trip breaks (set RUN_SMOKE=1 to enable)
 *   4. runs `wrangler dev` with the demo enabled and waits for /health
 *
 * Prerequisites: Node + npm (this project). Internet only for the first
 * `npx wrangler` + npm install.
 *
 * Optional: DEV_PORT=8790 npm run dev:full   (default port 8787)
 *           RUN_SMOKE=1 npm run dev:full    (also run the smoke test first)
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { summarizeSmoke } from "./smoke-summary.mjs";

const ROOT = process.cwd();
const IS_WIN = process.platform === "win32";
const NPM = IS_WIN ? "npm.cmd" : "npm";
const NPMX = IS_WIN ? "npx.cmd" : "npx";
const DEV_PORT = process.env.DEV_PORT ?? "8787";
const RUN_SMOKE = process.env.RUN_SMOKE === "1";

/** Run a command synchronously, streaming output; exits the script on failure. */
function run(cmd, args, { pipe = false } = {}) {
  console.log(`\n[bootstrap] $ ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, {
    stdio: pipe ? "pipe" : "inherit",
    shell: IS_WIN,
  });
  if (res.status !== 0) {
    console.error(`\n[bootstrap] command failed (exit ${res.status ?? "signal"}): ${cmd} ${args.join(" ")}`);
    process.exit(res.status ?? 1);
  }
  return res;
}

// ── 1. Dependencies ──────────────────────────────────────────────────────────
if (!existsSync(join(ROOT, "node_modules"))) {
  console.log("\n[bootstrap] node_modules missing — installing dependencies");
  run(NPM, ["install"]);
} else {
  console.log("[bootstrap] node_modules found — skipping install");
}

// ── 2. Apply D1 migrations to the local state ────────────────────────────────
console.log("\n[bootstrap] applying D1 migrations to the local database (migrations/0001_schema.sql)");
run(NPMX, ["wrangler", "d1", "migrations", "apply", "bill-snap", "--local"]);

// ── 3. Optional smoke: photo → confirm → undo against the D1 stores ─────────
if (RUN_SMOKE) {
  console.log("\n[bootstrap] running smoke test against the D1 stores (photo → confirm → undo)");
  const smoke = spawnSync(NPM, ["run", "smoke"], { stdio: "pipe", shell: IS_WIN });
  const out = `${smoke.stdout?.toString() ?? ""}${smoke.stderr?.toString() ?? ""}`;
  process.stdout.write(out);
  const { ok, line } = summarizeSmoke(smoke.status, out);
  console.log(`\n${line}`);
  if (!ok) {
    console.error(
      "[bootstrap] smoke failed — the D1 wiring is suspect. Fix it (see README 'Local dev'), " +
        "or rerun without RUN_SMOKE=1 to skip this gate.",
    );
    process.exit(1);
  }
}

// ── 4. wrangler dev (demo on), and wait for /health ──────────────────────────
console.log(`\n[bootstrap] starting wrangler dev on :${DEV_PORT} (demo + dashboard enabled)`);
const child = spawn(NPM, ["run", "dev", "--", "--port", DEV_PORT, "--var", "DEV_DEMO:true"], {
  stdio: "inherit",
  shell: IS_WIN,
});

const healthUrl = `http://127.0.0.1:${DEV_PORT}/health`;
const deadline = Date.now() + 60_000;
let healthy = false;
while (Date.now() < deadline) {
  try {
    const res = await fetch(healthUrl);
    if (res.ok) {
      healthy = true;
      break;
    }
  } catch {
    /* wrangler still booting */
  }
  await new Promise((r) => setTimeout(r, 500));
}

if (healthy) {
  console.log(`\n✅ Full stack is up!\n   Worker health:  ${healthUrl}\n   Browser demo:   http://127.0.0.1:${DEV_PORT}/dev/demo\n   Dashboard:      http://127.0.0.1:${DEV_PORT}/dev/dashboard\n   Webapp:         http://127.0.0.1:${DEV_PORT}/app\n   Storage:        D1 (local) + R2 (local) — everything inside Cloudflare\n\n   Smoke test:     npm run smoke\n   Sample bills:   npm run db:seed   (dashboards with data, no ✨ Seed click)\n   Stop:           npm run dev:down`);
} else {
  console.warn(`\n[bootstrap] wrangler dev did not answer ${healthUrl} within 60s — check the logs above.`);
}

process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
await new Promise((resolve) => child.on("exit", resolve));
