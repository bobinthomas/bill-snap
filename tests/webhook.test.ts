import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { parseInbound } from "../src/webhook/parse";
import { safeEqual, verifySignature, verifyToken } from "../src/webhook/verify";

function sign(appSecret: string, body: string): string {
  return "sha256=" + createHmac("sha256", appSecret).update(body).digest("hex");
}

const TEXT_PAYLOAD = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "123",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "61400000000", phone_number_id: "1000" },
            contacts: [{ profile: { name: "Rajesh" }, wa_id: "61412345678" }],
            messages: [
              {
                from: "61412345678",
                id: "wamid.abc123",
                timestamp: "1723000000",
                type: "text",
                text: { body: "summary" },
              },
            ],
          },
        },
      ],
    },
  ],
});

const IMAGE_PAYLOAD = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        {
          value: {
            messages: [
              {
                from: "61412345678",
                id: "wamid.img1",
                timestamp: "1723000001",
                type: "image",
                image: { mime_type: "image/jpeg", sha256: "abc", id: "MEDIA-42" },
              },
            ],
          },
        },
      ],
    },
  ],
});

const STATUS_ONLY_PAYLOAD = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [{ field: "messages", value: { statuses: [{ id: "wamid.s", status: "read" }] } }],
    },
  ],
});

describe("verifyToken (GET /webhook handshake)", () => {
  const params = (mode: string, token: string, challenge: string) =>
    new URLSearchParams({ "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge });

  it("accepts subscribe mode with the configured token and echoes the challenge", () => {
    expect(verifyToken(params("subscribe", "my-token", "123456"), "my-token")).toBe("123456");
  });

  it("rejects a wrong verify token", () => {
    expect(verifyToken(params("subscribe", "wrong", "123456"), "my-token")).toBeNull();
  });

  it("rejects a non-subscribe mode", () => {
    expect(verifyToken(params("unsubscribe", "my-token", "123456"), "my-token")).toBeNull();
  });

  it("rejects when no token is configured", () => {
    expect(verifyToken(params("subscribe", "my-token", "123456"), undefined)).toBeNull();
  });

  it("rejects when the challenge is missing", () => {
    const p = params("subscribe", "my-token", "123456");
    p.delete("hub.challenge");
    expect(verifyToken(p, "my-token")).toBeNull();
  });
});

describe("verifySignature (X-Hub-Signature-256)", () => {
  const secret = "super-secret-app-secret";
  const body = JSON.stringify({ hello: "world" });

  it("accepts a valid signature", async () => {
    await expect(verifySignature(body, sign(secret, body), secret)).resolves.toBe(true);
  });

  it("rejects a signature from the wrong secret", async () => {
    await expect(verifySignature(body, sign("other-secret", body), secret)).resolves.toBe(false);
  });

  it("rejects a tampered body", async () => {
    await expect(verifySignature(body + " ", sign(secret, body), secret)).resolves.toBe(false);
  });

  it("rejects a missing header", async () => {
    await expect(verifySignature(body, undefined, secret)).resolves.toBe(false);
  });

  it("rejects a malformed header", async () => {
    await expect(verifySignature(body, "not-a-signature", secret)).resolves.toBe(false);
  });

  it("rejects a non-hex signature value", async () => {
    await expect(verifySignature(body, "sha256=zzzz", secret)).resolves.toBe(false);
  });

  it("rejects an empty app secret", async () => {
    await expect(verifySignature(body, sign(secret, body), "")).resolves.toBe(false);
  });

  it("is case-insensitive on the hex digest", async () => {
    const hex = sign(secret, body).replace("sha256=", "").toUpperCase();
    await expect(verifySignature(body, `sha256=${hex}`, secret)).resolves.toBe(true);
  });
});

describe("safeEqual", () => {
  it("matches equal strings", () => expect(safeEqual("abc", "abc")).toBe(true));
  it("mismatches different lengths", () => expect(safeEqual("abc", "abcd")).toBe(false));
  it("mismatches same-length differences", () => expect(safeEqual("abc", "abd")).toBe(false));
});

describe("parseInbound", () => {
  it("parses a text message", () => {
    const event = parseInbound(TEXT_PAYLOAD);
    expect(event).toEqual({
      userPhone: "61412345678",
      waMessageId: "wamid.abc123",
      waReceivedAt: new Date(1723000000 * 1000),
      kind: "text",
      text: "summary",
    });
  });

  it("parses an image message with the media id", () => {
    const event = parseInbound(IMAGE_PAYLOAD);
    expect(event?.kind).toBe("photo");
    expect(event?.imageUrls).toEqual(["MEDIA-42"]);
  });

  it("returns null for status-only payloads", () => {
    expect(parseInbound(STATUS_ONLY_PAYLOAD)).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseInbound("{not json")).toBeNull();
  });

  it("returns null for a payload with no messages", () => {
    expect(parseInbound('{"object":"whatsapp_business_account","entry":[]}')).toBeNull();
  });

  it("ignores unsupported message types", () => {
    const audio = JSON.stringify({
      entry: [{ changes: [{ value: { messages: [{ from: "1", id: "2", type: "audio" }] } }] }],
    });
    expect(parseInbound(audio)).toBeNull();
  });
});
