/**
 * Minimal D1-compatible surface (§5.5). The stores are written against this
 * narrow interface — not the full `D1Database` type — so:
 *
 *  - the real Cloudflare D1 binding satisfies it structurally, and
 *  - tests can pass a node:sqlite-backed shim (tests/fakes.ts) that exercises
 *    the REAL migration SQL + SQL semantics with zero Docker / no Cloudflare.
 */
export interface D1PreparedLike {
  bind(...values: unknown[]): D1PreparedLike;
  all<T = unknown>(): Promise<{ results: T[] }>;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface D1Like {
  prepare(sql: string): D1PreparedLike;
  exec(sql: string): Promise<unknown>;
}

/** JSON helpers for the TEXT-encoded JSON columns (image_urls, raw_extraction). */
export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
