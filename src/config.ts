/**
 * Central config (SCAFFOLDING_PLAN.md §3).
 *
 * Extraction thresholds (§5.4) and TTLs (§5.6/§5.8) are env-configurable so
 * tuning never requires a deploy. Secrets are read through the same interface;
 * /health tolerates missing secrets — real flows must not.
 */
export interface AppConfig {
  whatsapp: {
    verifyToken?: string;
    appSecret?: string;
    phoneNumberId?: string;
    token?: string;
  };
  /** Workers AI text model (§5.3) — env AI_MODEL; the extractor applies its default when unset. */
  aiModel?: string;
  /** Workers AI vision model (§5.3) — env AI_VISION_MODEL; reads photo bytes when no OCR text exists. */
  aiVisionModel?: string;
  /** DEV-only: use the deterministic mock AI extractor instead of the real binding (GEMINI_MOCK=true). */
  geminiMock: boolean;
  /** Local-only: enables the /dev/* demo console (never set in production). */
  devDemo: boolean;
  extraction: {
    /** §5.4 per-field thresholds. */
    amountHigh: number;
    amountLow: number;
    dateHigh: number;
    dateLow: number;
    vendorHigh: number;
    vendorLow: number;
  };
  ttl: {
    /** Draft TTL (10 min). */
    draftMinutes: number;
    /** Nudge delay after the confirm screen (6 min). */
    nudgeDelayMinutes: number;
    /** Undo window for auto-logged bills (24 h, §5.8). */
    undoAutoLogHours: number;
    /** Undo window for confirm-path bills (5 min). */
    undoConfirmMinutes: number;
  };
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  return {
    whatsapp: {
      verifyToken: env.WHATSAPP_VERIFY_TOKEN,
      appSecret: env.WHATSAPP_APP_SECRET,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
      token: env.WHATSAPP_TOKEN,
    },
    aiModel: env.AI_MODEL,
    aiVisionModel: env.AI_VISION_MODEL,
    geminiMock: env.GEMINI_MOCK === "true",
    devDemo: env.DEV_DEMO === "true",
    extraction: {
      amountHigh: num(env.EXTRACTION_AMOUNT_HIGH, 0.9),
      amountLow: num(env.EXTRACTION_AMOUNT_LOW, 0.7),
      dateHigh: num(env.EXTRACTION_DATE_HIGH, 0.85),
      dateLow: num(env.EXTRACTION_DATE_LOW, 0.6),
      vendorHigh: num(env.EXTRACTION_VENDOR_HIGH, 0.75),
      vendorLow: num(env.EXTRACTION_VENDOR_LOW, 0.5),
    },
    ttl: {
      draftMinutes: int(env.DRAFT_TTL_MINUTES, 10),
      nudgeDelayMinutes: int(env.NUDGE_DELAY_MINUTES, 6),
      undoAutoLogHours: int(env.UNDO_AUTO_LOG_HOURS, 24),
      undoConfirmMinutes: int(env.UNDO_CONFIRM_MINUTES, 5),
    },
  };
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function int(value: string | undefined, fallback: number): number {
  return Math.round(num(value, fallback));
}
