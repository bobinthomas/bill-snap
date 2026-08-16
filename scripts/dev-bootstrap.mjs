#!/usr/bin/env node
/**
 * One-command local dev bootstrap — `npm run dev:full`.
 *
 * Gets a fresh clone to a running full-stack dev environment in one step:
 *   1. initialises local Supabase (creates supabase/config.toml if missing)
 *   2. starts it (Docker) — first run pulls images, subsequent runs are fast
 *   3. applies supabase/migrations/ + supabase/seed.sql (`supabase db reset`)
 *   4. writes SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY into .dev.vars and
 *      .env.smoke (preserving anything already there, e.g. WhatsApp tokens)
 *   5. runs `wrangler dev` with the demo enabled and waits for /health
 *
 * Prerequisites: Node + npm (this project), Docker Desktop running, and
 * internet for the first `npx supabase` + image pulls.
 *
 * Note: `supabase db reset` recreates the local database each run, so local
 * data is reset to a known seeded state — that's the point of a bootstrap.
 *
 * Optional: DEV_PORT=8790 npm run dev:full   (default port 8787)
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const IS_WIN = process.platform === "win32";
const NPM = IS_WIN ? "npm.cmd" : "npm";
const NPMX = IS_WIN ? "npx.cmd" : "npx";
const DEV_PORT = process.env.DEV_PORT ?? "8787";

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

// ── 0. Prerequisites ─────────────────────────────────────────────────────────
const docker = spawnSync("docker", ["info"], { stdio: "ignore", shell: IS_WIN });
if (docker.status !== 0) {
  console.error(
    "[bootstrap] Docker is not available. Start Docker Desktop (or install Podman) " +
      "before running the full stack — or run `npm run dev -- --var DEV_DEMO:true` " +
      "for the in-memory demo which needs no Docker or Supabase.",
  );
  process.exit(1);
}

// ── 1. supabase init (only when config.toml is missing) ──────────────────────
if (!existsSync(join(ROOT, "supabase", "config.toml"))) {
  console.log("\n[bootstrap] no supabase/config.toml — creating it");
  run(NPMX, ["-y", "supabase", "init"]);
}

// ── 2. Start ─────────────────────────────────────────────────────────────────
console.log("\n[bootstrap] starting local Supabase (first run pulls Docker images — be patient)");
run(NPMX, ["-y", "supabase", "start"]);

// ── 3. Migrations + seed ─────────────────────────────────────────────────────
console.log("\n[bootstrap] applying migrations + seed (resets local data to a known state)");
run(NPMX, ["-y", "supabase", "db", "reset"]);

// ── 4. Read the local URL + service-role key ─────────────────────────────────
const status = run(NPMX, ["-y", "supabase", "status", "-o", "env"], { pipe: true });
const envOut = status.stdout.toString();
const pick = (key) => {
  const m = new RegExp(`^${key}=(.*)$`, "m").exec(envOut);
  return m ? m[1].trim() : null;
};
const url = pick("SUPABASE_URL");
const key = pick("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) {
  console.error("[bootstrap] could not read SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY from `supabase status -o env`");
  process.exit(1);
}

// ── 5. Wire env files (merge, never clobber existing keys) ───────────────────
function mergeEnvFile(name, pairs) {
  const path = join(ROOT, name);
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  for (const [k, v] of pairs) {
    const idx = lines.findIndex((l) => new RegExp(`^\\s*${k}\\s*=`).test(l));
    if (idx >= 0) lines[idx] = `${k}=${v}`;
    else lines.push(`${k}=${v}`);
  }
  writeFileSync(path, lines.join("\n") + "\n");
  console.log(`[bootstrap] wrote ${name}: ${pairs.map(([k]) => k).join(", ")}`);
}
mergeEnvFile(".dev.vars", [
  ["SUPABASE_URL", url],
  ["SUPABASE_SERVICE_ROLE_KEY", key],
]);
mergeEnvFile(".env.smoke", [
  ["SUPABASE_URL", url],
  ["SUPABASE_SERVICE_ROLE_KEY", key],
]);

// ── 6. wrangler dev (demo on), and wait for /health ──────────────────────────
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
  console.log(`\n✅ Full stack is up!\n   Worker health:  ${healthUrl}\n   Browser demo:   http://127.0.0.1:${DEV_PORT}/dev/demo\n   Dashboard:      http://127.0.0.1:${DEV_PORT}/dev/dashboard\n   Supabase:       ${url}\n\n   Smoke test:     npm run smoke\n   Stop:           Ctrl+C (then \`supabase stop\` if you want to stop the DB too)`);
} else {
  console.warn(`\n[bootstrap] wrangler dev did not answer ${healthUrl} within 60s — check the logs above.`);
}

process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
await new Promise((resolve) => child.on("exit", resolve));
