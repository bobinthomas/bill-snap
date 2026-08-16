/**
 * WhatsApp webhook security (§7.2).
 *
 * - `verifyToken`: the Meta setup handshake — only `hub.mode=subscribe` with the
 *   configured token is accepted; the challenge is echoed back. Anything else → 403.
 * - `verifySignature`: `X-Hub-Signature-256` is HMAC-SHA256 of the raw request body
 *   keyed with the app secret, compared in constant time. Reject before any parsing
 *   or database write.
 */
export function verifyToken(
  params: URLSearchParams,
  expectedToken: string | undefined,
): string | null {
  if (params.get("hub.mode") !== "subscribe") return null;
  if (!expectedToken) return null;
  if (!safeEqual(params.get("hub.verify_token") ?? "", expectedToken)) return null;
  const challenge = params.get("hub.challenge");
  return challenge === null ? null : challenge;
}

export async function verifySignature(
  rawBody: string,
  header: string | undefined,
  appSecret: string,
): Promise<boolean> {
  if (!header || !appSecret) return false;
  const expected = header.startsWith("sha256=") ? header.slice("sha256=".length) : header;
  if (!/^[0-9a-f]{64}$/i.test(expected)) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const actual = [...new Uint8Array(signature)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return safeEqual(actual, expected.toLowerCase());
}

/** Constant-time string comparison (lengths are not secret). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
