/**
 * One-line summary of `npm run smoke` (vitest) output.
 *
 * Exported as its own module so the bootstrap can print a clean pass/fail
 * line, and so the parser is testable without Docker or a running Supabase.
 *
 * Understands the vitest summary shapes:
 *   pass:    Test Files  1 passed (1)   /   Tests  2 passed (2)
 *   fail:    Test Files  1 failed (1)   /   Tests  1 failed (1)
 *   skipped: Test Files  1 skipped (1)  /   Tests  1 skipped (1)
 *   partial: Tests  3 passed (3) | 1 skipped (4)
 */

export function summarizeSmoke(status, output) {
  const out = String(output ?? "");
  // Scope counts to the `Tests` line so "Test Files … passed" can't match.
  const testsLine = /^\s*Tests\s+(.*)$/m.exec(out);
  const line = testsLine ? testsLine[1] : "";
  const n = (re) => {
    const m = re.exec(line);
    return m ? Number(m[1]) : 0;
  };
  const passed = n(/(\d+)\s+passed/);
  const failed = n(/(\d+)\s+failed/);
  const skipped = n(/(\d+)\s+skipped/);

  if (status === 0 && passed > 0) {
    return {
      ok: true,
      line: `✅ Smoke test passed — photo → confirm → undo round trip OK (${passed} test${passed === 1 ? "" : "s"} passed${skipped ? `, ${skipped} skipped` : ""}).`,
    };
  }
  if (status === 0) {
    return {
      ok: false,
      line: `⚠️  Smoke test did not run (${passed} passed, ${failed} failed, ${skipped} skipped) — SUPABASE_URL wiring likely missing from .env.smoke.`,
    };
  }
  return {
    ok: false,
    line: `❌ Smoke test FAILED (${failed > 0 ? `${failed} failed` : `exit ${status}`}${skipped ? `, ${skipped} skipped` : ""}). The Supabase wiring is suspect.`,
  };
}
