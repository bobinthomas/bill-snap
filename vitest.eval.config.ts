/**
 * Vitest config for the §5.7 eval harness. The default config (npm test) only
 * collects tests/; this one targets the eval harness files so they never run as
 * part of the unit suite.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["eval/**/*.run.ts"],
    environment: "node",
  },
});
