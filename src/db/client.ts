/**
 * Supabase REST client (PostgREST), service-role, server-side only (§7.3).
 *
 * Deliberately a thin fetch layer — no SDK — matching the raw-fetch style of
 * whatsapp.ts and keeping the Worker bundle small
 * (SCAFFOLDING_PLAN.md §9: "Supabase client" decision → REST, not supabase-js).
 *
 * `fetchFn` is injectable so store tests run against a fake PostgREST.
 */
export interface RestClientOptions {
  url: string;
  key: string;
  fetchFn?: typeof fetch;
}

export interface InsertOptions {
  /** Add `Prefer: return=representation` so the created row(s) come back. */
  returnRepresentation?: boolean;
  /** Add `Prefer: resolution=ignore-duplicates` — idempotent inserts (§5.6). */
  ignoreDuplicates?: boolean;
}

export interface RestClient {
  /** GET /rest/v1/{table}?{filters} — filters are raw PostgREST expressions. */
  select<T>(table: string, filters: Record<string, string>): Promise<T[]>;
  /** POST /rest/v1/{table}; returns rows when `returnRepresentation`, else null. */
  insert<T>(table: string, body: unknown, opts?: InsertOptions): Promise<T[] | null>;
  /** PATCH /rest/v1/{table}?{filters}; returns updated rows. */
  update<T>(table: string, body: unknown, filters: Record<string, string>): Promise<T[] | null>;
  /** PATCH with return=minimal + count=exact; returns the affected row count. */
  updateCount(table: string, body: unknown, filters: Record<string, string>): Promise<number>;
}

export class SupabaseRestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "SupabaseRestError";
  }
}

export function createRestClient(options: RestClientOptions): RestClient {
  const fetchFn = options.fetchFn ?? fetch;
  const base = `${options.url.replace(/\/+$/, "")}/rest/v1`;

  async function request(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
    prefer?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      apikey: options.key,
      Authorization: `Bearer ${options.key}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (prefer) headers.Prefer = prefer;

    const res = await fetchFn(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      let message = `Supabase ${method} ${path} failed: HTTP ${res.status}`;
      let code: string | null = null;
      try {
        const err = (await res.json()) as { message?: unknown; code?: unknown };
        if (typeof err.message === "string" && err.message !== "") message = err.message;
        if (typeof err.code === "string") code = err.code;
      } catch {
        // Non-JSON error body — keep the HTTP-status message.
      }
      throw new SupabaseRestError(message, res.status, code);
    }
    return res;
  }

  function pathWithFilters(table: string, filters: Record<string, string>): string {
    const qs = Object.entries(filters)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    return `/${table}${qs ? `?${qs}` : ""}`;
  }

  return {
    async select<T>(table: string, filters: Record<string, string>): Promise<T[]> {
      const res = await request("GET", pathWithFilters(table, filters));
      if (res.status === 204) return [];
      return (await res.json()) as T[];
    },

    async insert<T>(table: string, body: unknown, opts: InsertOptions = {}): Promise<T[] | null> {
      const prefer = [
        opts.returnRepresentation ? "return=representation" : "return=minimal",
        opts.ignoreDuplicates ? "resolution=ignore-duplicates" : null,
      ]
        .filter((p): p is string => p !== null)
        .join(",");
      const res = await request("POST", `/${table}`, body, prefer);
      if (res.status === 204 || !opts.returnRepresentation) return null;
      return (await res.json()) as T[];
    },

    async update<T>(table: string, body: unknown, filters: Record<string, string>): Promise<T[] | null> {
      const res = await request(
        "PATCH",
        pathWithFilters(table, filters),
        body,
        "return=representation",
      );
      if (res.status === 204) return null;
      return (await res.json()) as T[];
    },

    async updateCount(table: string, body: unknown, filters: Record<string, string>): Promise<number> {
      const res = await request(
        "PATCH",
        pathWithFilters(table, filters),
        body,
        "return=minimal,count=exact",
      );
      const range = res.headers.get("content-range");
      if (!range) return 0;
      const match = /\/\*?(\d+)$/.exec(range);
      return match ? Number(match[1]) : 0;
    },
  };
}
