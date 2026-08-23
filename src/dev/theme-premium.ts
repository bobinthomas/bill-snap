/**
 * Dashboard design system — the Apple Wallet/Pay/Cash-inspired, true-black
 * OLED look /app shipped in its last redesign, ported here so /dev/dashboard
 * doesn't drift onto an older visual language. Deep OLED black, flat elevated
 * surfaces with hairline borders (no glass/blur, no nested bezels), a sticky
 * flush navbar, Google Sans for UI text, IBM Plex Mono for money digits.
 *
 * An opt-in layer on top of BASE_STYLES (theme.ts), used only by
 * /dev/dashboard. /dev/demo intentionally keeps the plain BASE_STYLES look,
 * so this lives in its own module rather than folding into theme.ts and
 * bleeding into every dev-tool screen. /app itself is fully self-contained
 * (its own inline styles) and no longer shares this module.
 */

export const PREMIUM_FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500;600;700&display=swap" rel="stylesheet">`;

export const PREMIUM_STYLES = `
  :root {
    --font-sans: 'Google Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --font-display: var(--font-sans);
    --font-numeral: 'IBM Plex Mono', ui-monospace, "SF Mono", Menlo, Consolas, monospace;

    --bg: #000000;
    --surface: #1c1c1e;
    --surface-2: #2c2c2e;
    --surface-3: #3a3a3c;
    --border: rgba(255,255,255,0.14);
    --border-soft: rgba(255,255,255,0.08);
    --text: #ffffff;
    --text-dim: rgba(235,235,245,0.60);
    --text-faint: rgba(235,235,245,0.30);

    --accent: #0a84ff;
    --accent-solid: #0a84ff;
    --accent-solid-hover: #409cff;
    --accent-soft: rgba(10,132,255,0.16);
    --accent-border: rgba(10,132,255,0.32);
    --accent-text: #0a84ff;
    --accent-glow: rgba(10,132,255,0.35);

    --success: #30d158;
    --success-soft: rgba(48,209,88,0.16);
    --success-border: rgba(48,209,88,0.32);
    --success-text: #30d158;
    --success-glow: rgba(48,209,88,0.3);

    --warn: #ff9f0a;
    --warn-soft: rgba(255,159,10,0.16);
    --warn-border: rgba(255,159,10,0.32);
    --warn-text: #ff9f0a;

    --danger: #ff453a;
    --danger-soft: rgba(255,69,58,0.16);
    --danger-border: rgba(255,69,58,0.32);

    --radius-sm: 10px;
    --radius-md: 14px;
    --radius-lg: 20px;
    --radius-xl: 26px;
    --radius-2xl: 26px;
    --radius-pill: 999px;

    --shadow-sm: none;
    --shadow-md: none;
    --shadow-glow: none;

    --ease: cubic-bezier(.32,.72,0,1);
    --ease-spring: cubic-bezier(.34,1.56,.64,1);
  }

  html { color-scheme: dark; }
  body { background: var(--bg); font-family: var(--font-sans); }

  h1, h2, h3, .brand-title, .hero-title { font-family: var(--font-display); letter-spacing: -0.01em; }

  /* --- sticky flush navbar (matches /app's .navbar) --- */
  .topbar {
    position: sticky; top: 0; z-index: 5; margin: 0; padding: 11px 20px;
    background: rgba(28,28,30,0.72);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border: none; border-bottom: 1px solid var(--border);
    border-radius: 0; box-shadow: none;
    row-gap: 10px;
  }
  .brand-mark { background: var(--accent-soft); }
  .nav-link { border-radius: var(--radius-pill); }

  /* --- flat elevated surface: one hairline layer, no nested bezel --- */
  .panel { background: transparent; border: none; border-radius: 0; padding: 0; box-shadow: none; }
  .panel-inner {
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-lg);
    padding: 20px 22px;
  }
  .panel h2 { margin-top: 0; }

  /* --- eyebrow tag --- */
  .eyebrow {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 5px 12px 5px 10px; border-radius: var(--radius-pill);
    background: var(--accent-soft); border: 1px solid var(--accent-border); color: var(--accent-text);
    font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .16em;
  }
  .eyebrow .dot { width: 5px; height: 5px; border-radius: 999px; background: var(--accent); }

  /* --- buttons: quick press feedback, flat fills --- */
  .btn, .btn-lg {
    transition: transform .15s var(--ease-spring), background-color .15s var(--ease), border-color .15s var(--ease), color .15s var(--ease);
  }
  .btn:active, .btn-lg:active { transform: scale(.97); }
  .btn-primary, .btn-lg.primary { background: var(--accent); color: #fff; }
  .btn-primary:hover, .btn-lg.primary:hover { background: var(--accent-solid-hover); }
  .btn-ghost, .btn-lg.ghost { background: var(--surface); border-color: var(--border-soft); }
  .btn-ghost:hover, .btn-lg.ghost:hover { background: var(--surface-2); }

  .icon-chip {
    display: inline-flex; align-items: center; justify-content: center;
    width: 26px; height: 26px; border-radius: 999px; flex: none;
    background: rgba(255,255,255,.14);
  }
  .btn-lg.ghost .icon-chip, .btn-ghost .icon-chip { background: var(--surface-2); }

  /* --- inputs & chips --- */
  .text-input, select { background: var(--surface); border: 1px solid var(--border-soft); }
  .text-input:focus, select:focus { border-color: var(--accent-border); box-shadow: 0 0 0 3px var(--accent-soft); }
  .chip { background: var(--surface); border-color: var(--border-soft); }

  /* --- one-shot scroll reveal (applied only to static shell containers —
     never to the polling-refreshed inner content, or it would replay every
     2-3s as data reloads) --- */
  [data-reveal] {
    opacity: 0; transform: translateY(16px);
    transition: opacity .5s var(--ease), transform .5s var(--ease);
  }
  [data-reveal].is-in { opacity: 1; transform: none; }
  @media (prefers-reduced-motion: reduce) {
    [data-reveal] { opacity: 1; transform: none; transition: none; }
  }
`;

/** One-shot IntersectionObserver reveal — fires once per element, never
 *  re-observes, so elements that live inside polling-refreshed containers
 *  are safe to mark with data-reveal too (the mark just won't re-animate). */
export const PREMIUM_REVEAL_SCRIPT = `
  (function () {
    if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      document.querySelectorAll('[data-reveal]').forEach(function (el) { el.classList.add('is-in'); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { entry.target.classList.add('is-in'); io.unobserve(entry.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -60px 0px' });
    document.querySelectorAll('[data-reveal]').forEach(function (el) { io.observe(el); });
  })();
`;
