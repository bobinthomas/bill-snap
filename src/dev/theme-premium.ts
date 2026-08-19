/**
 * "Ethereal Glass" premium design system — an opt-in layer on top of
 * BASE_STYLES (theme.ts), used only by the /app webapp and /dev/dashboard
 * pages. /dev/demo intentionally keeps the plain BASE_STYLES look, so this
 * lives in its own module rather than folding into theme.ts and bleeding
 * into every dev-tool screen.
 *
 * Deep OLED black, glass "double-bezel" panels (an outer shell + a nested
 * inner core, like a plate sitting in a machined tray), a detached
 * floating-pill topbar, spring-y button motion, and a one-shot scroll-reveal
 * — all vanilla CSS/JS (no bundler, no Tailwind, no React in this Worker),
 * animating only transform/opacity/filter so it stays GPU-cheap on mobile.
 */

export const PREMIUM_FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">`;

export const PREMIUM_STYLES = `
  :root {
    --font-sans: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --font-display: 'Space Grotesk', var(--font-sans);

    --bg: #050506;
    --surface: rgba(255,255,255,0.035);
    --surface-2: rgba(255,255,255,0.055);
    --surface-3: rgba(255,255,255,0.09);
    --border: rgba(255,255,255,0.1);
    --border-soft: rgba(255,255,255,0.06);
    --text: #f7f7f9;
    --text-dim: #adadb8;
    --text-faint: #77777f;

    --accent: #8f7bff;
    --accent-solid: #7c5cff;
    --accent-solid-hover: #6d4bf0;
    --accent-soft: rgba(143,123,255,0.16);
    --accent-border: rgba(143,123,255,0.42);
    --accent-text: #bfb2ff;
    --accent-glow: rgba(143,123,255,0.4);

    --success: #34d399;
    --success-soft: rgba(52,211,153,0.15);
    --success-border: rgba(52,211,153,0.4);
    --success-text: #86eec4;
    --success-glow: rgba(52,211,153,0.32);

    --warn: #f2b705;
    --warn-soft: rgba(242,183,5,0.12);
    --warn-border: rgba(242,183,5,0.4);
    --warn-text: #f7ce5b;

    --danger: #ff6b6b;
    --danger-soft: rgba(255,107,107,0.13);
    --danger-border: rgba(255,107,107,0.4);

    --radius-sm: 10px;
    --radius-md: 16px;
    --radius-lg: 24px;
    --radius-xl: 28px;
    --radius-2xl: 32px;
    --radius-pill: 999px;

    --shadow-sm: 0 1px 2px rgba(0,0,0,.5);
    --shadow-md: 0 24px 60px -26px rgba(0,0,0,.8);
    --shadow-glow: 0 0 1px rgba(255,255,255,.5), 0 18px 46px -16px var(--accent-glow);

    --ease: cubic-bezier(.32,.72,0,1);
    --ease-spring: cubic-bezier(.34,1.56,.64,1);
  }

  html { color-scheme: dark; }
  body { background: var(--bg); position: relative; font-family: var(--font-sans); }
  body::before {
    content: ""; position: fixed; inset: 0; z-index: 0; pointer-events: none;
    background:
      radial-gradient(680px circle at 12% 6%, var(--accent-glow), transparent 62%),
      radial-gradient(560px circle at 90% 88%, var(--success-glow), transparent 60%);
    opacity: .4;
  }
  body::after {
    content: ""; position: fixed; inset: 0; z-index: 0; pointer-events: none;
    opacity: .035; mix-blend-mode: overlay;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  }
  body > * { position: relative; z-index: 1; }
  .icon { stroke-width: 1.25px; }

  h1, h2, h3, .brand-title, .hero-title { font-family: var(--font-display); letter-spacing: -0.01em; }

  /* --- floating island topbar --- */
  .topbar {
    margin: 14px 14px 0; padding: 11px 20px;
    background: var(--surface-2);
    backdrop-filter: blur(22px) saturate(150%);
    -webkit-backdrop-filter: blur(22px) saturate(150%);
    border: 1px solid var(--border);
    border-radius: var(--radius-pill);
    box-shadow: var(--shadow-md);
  }
  .brand-mark {
    background: linear-gradient(155deg, var(--accent-soft), rgba(255,255,255,.02));
    box-shadow: inset 0 1px 1px rgba(255,255,255,.18);
  }
  .nav-link { border-radius: var(--radius-pill); }

  /* --- double-bezel: an outer shell around a distinct inner core --- */
  .bezel {
    padding: 6px;
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-2xl);
    box-shadow: var(--shadow-md);
  }
  .bezel-inner {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: calc(var(--radius-2xl) - 6px);
    box-shadow: inset 0 1px 1px rgba(255,255,255,.08);
  }

  .panel {
    background: var(--surface);
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-xl);
    padding: 6px;
    box-shadow: var(--shadow-md);
  }
  .panel-inner {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: calc(var(--radius-xl) - 6px);
    box-shadow: inset 0 1px 1px rgba(255,255,255,.07);
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
  .eyebrow .dot { width: 5px; height: 5px; border-radius: 999px; background: var(--accent); box-shadow: 0 0 8px 1px var(--accent-glow); }

  /* --- buttons: spring press + glow lift, nested icon-chip --- */
  .btn, .btn-lg {
    transition: transform .45s var(--ease-spring), box-shadow .35s var(--ease), background-color .3s var(--ease), border-color .3s var(--ease), color .3s var(--ease);
  }
  .btn:hover, .btn-lg:hover { transform: translateY(-1px); }
  .btn:active, .btn-lg:active { transform: scale(.97); }
  .btn-primary, .btn-lg.primary {
    background: linear-gradient(155deg, var(--accent-solid), var(--accent-solid-hover));
  }
  .btn-primary:hover, .btn-lg.primary:hover { box-shadow: var(--shadow-glow); }
  .btn-ghost, .btn-lg.ghost { background: var(--surface-2); border-color: var(--border); backdrop-filter: blur(8px); }
  .btn-ghost:hover, .btn-lg.ghost:hover { background: var(--surface-3); }

  .icon-chip {
    display: inline-flex; align-items: center; justify-content: center;
    width: 26px; height: 26px; border-radius: 999px; flex: none;
    background: rgba(255,255,255,.16);
    box-shadow: inset 0 1px 1px rgba(255,255,255,.25);
  }
  .btn-lg.ghost .icon-chip, .btn-ghost .icon-chip { background: var(--surface-3); }

  /* --- inputs & chips, glassy --- */
  .text-input, select {
    background: var(--surface-2);
    border: 1px solid var(--border);
    backdrop-filter: blur(8px);
  }
  .text-input:focus, select:focus { border-color: var(--accent-border); box-shadow: 0 0 0 3px var(--accent-soft); }
  .chip { background: var(--surface-2); border-color: var(--border); backdrop-filter: blur(6px); }

  /* --- one-shot scroll reveal (applied only to static shell containers —
     never to the polling-refreshed inner content, or it would replay every
     2-3s as data reloads) --- */
  [data-reveal] {
    opacity: 0; transform: translateY(26px); filter: blur(6px);
    transition: opacity .9s var(--ease), transform .9s var(--ease), filter .9s var(--ease);
  }
  [data-reveal].is-in { opacity: 1; transform: none; filter: blur(0); }
  @media (prefers-reduced-motion: reduce) {
    [data-reveal] { opacity: 1; transform: none; filter: none; transition: none; }
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
