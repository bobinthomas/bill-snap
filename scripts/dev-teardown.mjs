#!/usr/bin/env node
/**
 * One-command local dev teardown — `npm run dev:down`.
 *
 * Undoes `npm run dev:full` (scripts/dev-bootstrap.mjs):
 *   1. stops the `wrangler dev` server holding DEV_PORT (default 8787),
 *      including orphaned processes a hard Ctrl+C left behind (the
 *      bootstrap's own SIGINT handler is best-effort and cannot always reach
 *      the grandchild node/workerd on Windows)
 *   2. stops local Supabase (`npx supabase stop` — keeps data volumes so
 *      the next `dev:full` restart is fast; `--no-backup` deletes them)
 *
 * Why kill by command line instead of the port-holder PID: `wrangler dev`
 * watches its worker and RESTARTS it when the listener dies, so killing just
 * the workerd leaves a respawned server behind. Matching `--port <DEV_PORT>`
 * in process command lines finds the whole npm → wrangler → workerd chain;
 * killing the root with `/T` takes the tree down with no restart. The
 * port-holder PID is only a fallback for servers started without `--port`.
 *
 * Safe to run when nothing is up: it reports what it stopped and what it
 * couldn't find, and exits 0 in all "nothing to do" cases — only a genuine
 * stop failure (e.g. a kill that refused) exits non-zero.
 *
 * Optional: DEV_PORT=8790 npm run dev:down
 */
import { spawnSync } from "node:child_process";

const IS_WIN = process.platform === "win32";
const NPMX = IS_WIN ? "npx.cmd" : "npx";
const DEV_PORT = process.env.DEV_PORT ?? "8787";

const log = (...a) => console.log("[teardown]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. Stop wrangler dev on DEV_PORT ─────────────────────────────────────────
/** PIDs of the whole npm → wrangler → workerd chain for DEV_PORT. */
function findDevServerPids() {
  const pids = new Set();
  if (IS_WIN) {
    // Command lines carry `--port <DEV_PORT>` (bootstrap spawns) or
    // `--socket-addr=…:<DEV_PORT>` (workerd). Exclude powershell (its own
    // -Command line contains the pattern) and the teardown script itself.
    const ps =
      `Get-CimInstance Win32_Process | Where-Object { ` +
      `( ($_.CommandLine -match '--port ${DEV_PORT}' -or $_.CommandLine -match '--socket-addr=.*${DEV_PORT}') ` +
      `-and $_.CommandLine -notmatch 'dev-teardown' -and $_.Name -notmatch 'powershell|pwsh' ) } ` +
      `| ForEach-Object { $_.ProcessId }`;
    const res = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" });
    for (const pid of (res.stdout ?? "").trim().split(/\s+/).filter(Boolean)) pids.add(pid);
  } else {
    const res = spawnSync("ps", ["-eo", "pid,args"], { encoding: "utf8" });
    for (const line of (res.stdout ?? "").split(/\r?\n/)) {
      if (line.includes("dev-teardown")) continue;
      if (line.includes(`--port ${DEV_PORT}`) || line.includes(`--socket-addr=.*${DEV_PORT}`) || line.includes(`--socket-addr=entry=127.0.0.1:${DEV_PORT}`)) {
        const m = /^\s*(\d+)/.exec(line);
        if (m) pids.add(m[1]);
      }
    }
  }

  // Fallback: whoever actually holds the port (a server started without
  // `--port`, e.g. plain `npm run dev`). Note this alone can respawn; the
  // caller's post-kill port check catches that and warns.
  if (pids.size === 0) {
    if (IS_WIN) {
      const net = spawnSync("netstat", ["-ano"], { encoding: "utf8" });
      for (const line of (net.stdout ?? "").split(/\r?\n/)) {
        const m = /TCP\s+(\S+):(\d+)\s+\S+:\d+\s+LISTENING\s+(\d+)/.exec(line);
        if (m && m[2] === DEV_PORT) pids.add(m[3]);
      }
    } else {
      const lsof = spawnSync("lsof", ["-ti", `tcp:${DEV_PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" });
      if (!lsof.error) for (const pid of (lsof.stdout ?? "").trim().split(/\s+/).filter(Boolean)) pids.add(pid);
    }
  }
  return [...pids];
}

/** Is anything still LISTENING on DEV_PORT? */
function portHeld() {
  if (IS_WIN) {
    const net = spawnSync("netstat", ["-ano"], { encoding: "utf8" });
    return /TCP\s+\S+:(\d+)\s+\S+:\d+\s+LISTENING\s+(\d+)/.test(net.stdout ?? "") &&
      (net.stdout ?? "").split(/\r?\n/).some((l) => {
        const m = /TCP\s+(\S+):(\d+)\s+\S+:\d+\s+LISTENING\s+(\d+)/.exec(l);
        return m && m[2] === DEV_PORT;
      });
  }
  const lsof = spawnSync("lsof", ["-ti", `tcp:${DEV_PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  return !lsof.error && lsof.status === 0 && (lsof.stdout ?? "").trim() !== "";
}

async function stopWrangler() {
  const pids = findDevServerPids();
  if (pids.length === 0) {
    log(`nothing listening on :${DEV_PORT} — wrangler dev is not running (or use DEV_PORT=… to target another port)`);
    return;
  }
  log(`stopping wrangler dev on :${DEV_PORT} — killing ${pids.length} process(es): ${pids.join(", ")}`);
  if (IS_WIN) {
    for (const pid of pids) {
      // /T kills the whole tree from this member down (npm → wrangler →
      // workerd); the topmost kill ends everything, so no restart happens.
      spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "inherit", shell: IS_WIN });
    }
  } else {
    for (const pid of pids) {
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    await sleep(3000);
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 0); // still alive?
        process.kill(Number(pid), "SIGKILL");
        log(`PID ${pid} ignored SIGTERM — SIGKILL sent`);
      } catch {
        /* exited cleanly */
      }
    }
  }
  await sleep(1500);
  if (portHeld()) {
    log(`⚠️  :${DEV_PORT} is STILL listening after the kill — a process outside the matched tree holds it. ` +
        "Check `netstat -ano | findstr :" + DEV_PORT + "` (or `lsof -i :" + DEV_PORT + "`) and kill it manually.");
  } else {
    log(`:${DEV_PORT} is free.`);
  }
}

// ── 2. Stop local Supabase ───────────────────────────────────────────────────
function stopSupabase() {
  log("stopping local Supabase (`npx supabase stop` — data volumes kept; use `supabase stop --no-backup` to delete them)");
  const res = spawnSync(NPMX, ["-y", "supabase", "stop"], { encoding: "utf8", shell: IS_WIN });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (res.status === 0) {
    log("Supabase stopped.");
    return;
  }
  const nothingToStop =
    /not running|no (running )?supabase|no containers|nothing to stop|command not found/i.test(out) ||
    /docker.*(not|isn'?t|is not).*(available|running)/i.test(out);
  if (nothingToStop) {
    log("Supabase wasn't running (or Docker isn't available) — nothing to stop.");
  } else {
    process.stdout.write(out);
    console.error(`\n[teardown] \`supabase stop\` failed (exit ${res.status ?? "signal"}) — see output above.`);
    process.exit(res.status ?? 1);
  }
}

// ── 3. Go ────────────────────────────────────────────────────────────────────
console.log(`[teardown] dev:down — stopping the stack from \`npm run dev:full\` (port ${DEV_PORT})`);
await stopWrangler();
stopSupabase();
console.log("\n[teardown] done.");
