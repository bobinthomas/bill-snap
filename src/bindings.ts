/**
 * The Cloudflare bindings the deps layer consumes (§5.5). Narrow interfaces so
 * tests can pass node:sqlite / in-memory shims; the real D1Database / R2Bucket
 * bindings satisfy them structurally.
 */
import type { D1Like } from "./db/d1";
import type { R2Like } from "./storage/bills";

export interface CloudBindings {
  /** D1 database — the data model (users/businesses/memberships/transactions). */
  db?: D1Like;
  /** R2 bucket — bill images. */
  bills?: R2Like;
}
