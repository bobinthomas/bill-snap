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

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "corpus", "images");
mkdirSync(OUT_DIR, { recursive: true });

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

console.log("done — 3 bill images in eval/corpus/images/ (gitignored).");
