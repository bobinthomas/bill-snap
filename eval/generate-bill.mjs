/**
 * Draws the demo sample bill to `eval/corpus/images/` as raster PNGs so
 * `npm run eval:ocr` has image input without needing the browser or the
 * private mirror. Reproduces the exact canvas drawing from the `/dev/demo`
 * sample-bill button, plus two variants:
 *
 *   sample-bill.png       — the clean demo bill (date 10/08/2026)
 *   sample-dash-date.png  — same bill, dash-separated date (03-08-2026),
 *                           the shape findDate was extended to handle
 *   sample-photo.png      — photo-like render (slight rotation + uneven
 *                           lighting) so tesseract produces realistic line
 *                           noise instead of a perfect synthetic print
 *
 * Run: `node eval/generate-bill.mjs` (needs the @napi-rs/canvas dev dep).
 * The images are gitignored — regenerate, don't commit.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(ROOT, "corpus", "images");
const SYNTHETIC_DIR = join(ROOT, "corpus", "synthetic");
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SYNTHETIC_DIR, { recursive: true });

/** Draw the exact demo sample bill on a fresh canvas. */
function drawBill({ date = "10/08/2026" } = {}) {
  const c = createCanvas(640, 400);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = "#111111";
  ctx.font = "bold 36px sans-serif";
  ctx.fillText("Origin Energy", 40, 64);
  ctx.font = "26px sans-serif";
  ctx.fillText("Electricity account", 40, 102);
  ctx.fillText(date, 40, 140);
  ctx.fillText("Subtotal: $243.00", 40, 196);
  ctx.fillText("GST: $24.30", 40, 234);
  ctx.font = "bold 30px sans-serif";
  ctx.fillText("Total:", 40, 290);
  ctx.fillText("$267.30", 40, 328);
  return c;
}

function save(canvas, name) {
  const path = join(OUT_DIR, name);
  writeFileSync(path, canvas.toBuffer("image/png"));
  console.log(`wrote ${path} (${canvas.width}x${canvas.height})`);
}

// 1. Clean demo bill.
save(drawBill(), "sample-bill.png");

// 2. Dash-separated date variant.
save(drawBill({ date: "03-08-2026" }), "sample-dash-date.png");

// 3. Photo-like render: the clean bill rotated ~2° on a slightly larger canvas
//    with uneven (gradient) lighting — what a phone snap of the paper bill
//    does to tesseract without being an actual photo.
{
  const src = drawBill();
  const pad = 60;
  const c = createCanvas(src.width + pad * 2, src.height + pad * 2);
  const ctx = c.getContext("2d");
  // Uneven lighting background (darker toward one corner).
  const g = ctx.createLinearGradient(0, 0, c.width, c.height);
  g.addColorStop(0, "#f2efe9");
  g.addColorStop(1, "#e3ddd0");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.save();
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((-2 * Math.PI) / 180); // ~2° anti-clockwise, like a loose snap
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  ctx.restore();
  save(c, "sample-photo.png");
}

// ── Committed synthetic bills ────────────────────────────────────────────────
// The three renders above are MEASUREMENT images (gitignored mirror). These are
// COMMITTED scoring labels: large, high-contrast, OCR-safe bills that tesseract
// reads deterministically, so CI scores the image path (OCR → regex) without
// the private mirror. Labels live at eval/corpus/labels/sample-v*.json and the
// ground truth is exactly what is drawn here — keep them in lockstep.
//
// OCR-safety rules (learned the hard way): big bold fonts, dates without the
// 6/8 confusable shape at small sizes, and the words "GST"/"tax" present only
// on inclusive/exclusive bills (detectGstBasis treats any GST mention as
// exclusive unless "inclusive" is spelled out).
function drawSyntheticBill(lines, { width = 1000, height = 640, leading = 64, base = 44 } = {}) {
  const c = createCanvas(width, height);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = "#111111";
  lines.forEach((line, i) => {
    const [text, bold] = Array.isArray(line) ? line : [line, false];
    ctx.font = `${bold ? "bold " : ""}${base}px sans-serif`;
    ctx.fillText(text, 48, 80 + i * leading);
  });
  return c;
}

const syntheticBills = [
  {
    name: "sample-v1.png",
    bill: drawSyntheticBill([
      ["Origin Energy", true],
      "ABN: 51 824 753 556",
      "Electricity account",
      "Invoice No. INV-2847",
      "Date: 10/08/2026",
      "Subtotal: $243.00",
      "GST: $24.30",
      "GST INCLUSIVE",
      ["Total: $267.30", true],
    ]),
  },
  {
    name: "sample-v2.png",
    bill: drawSyntheticBill([
      ["Telstra", true],
      "Phone bill",
      "Invoice No. INV-77123",
      "Date: 14/08/2026",
      "GST INCLUSIVE",
      ["Amount Due: $77.45", true],
      "ABN: 51 824 753 556",
    ]),
  },
  {
    name: "sample-v3.png",
    bill: drawSyntheticBill([
      ["Homebase", true],
      "ABN: 51 824 753 556",
      "Rent payment",
      "Date: 05/08/2026",
      "GST: $200.00",
      "GST EXCLUSIVE",
      ["Total: $2200.00", true],
    ]),
  },
];

for (const { name, bill } of syntheticBills) {
  writeFileSync(join(SYNTHETIC_DIR, name), bill.toBuffer("image/png"));
  console.log(`wrote ${join(SYNTHETIC_DIR, name)} (committed)`);
}

console.log("done — 3 measurement images in eval/corpus/images/ (gitignored) + 3 committed synthetic bills in eval/corpus/synthetic/.");
