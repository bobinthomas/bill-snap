/**
 * Shared design tokens + component CSS for the /dev/demo and /dev/dashboard
 * pages (DEV-only tool screens, never shipped to end users). Kept in one
 * place so the two pages don't drift into different colors/radii — one
 * accent, one shape system, per the taste checklist. Dark-only on purpose:
 * these are internal engineering/analyst screens, not consumer-facing.
 */
export const BASE_STYLES = `
  :root {
    color-scheme: dark;
    --bg: #0a0a0c;
    --surface: #16161a;
    --surface-2: #1e1e24;
    --surface-3: #27272e;
    --border: #2c2c34;
    --border-soft: #232329;
    --text: #f5f5f7;
    --text-dim: #9d9da8;
    --text-faint: #6c6c76;

    --accent: #4c7cf0;
    --accent-solid: #1d4ed8;
    --accent-solid-hover: #1e40af;
    --accent-soft: rgba(76, 124, 240, 0.14);
    --accent-border: rgba(76, 124, 240, 0.4);
    --accent-text: #9db8fb;

    --success: #22c55e;
    --success-soft: rgba(34, 197, 94, 0.14);
    --success-border: rgba(34, 197, 94, 0.38);
    --success-text: #7fe3a3;

    --warn: #eab308;
    --warn-soft: rgba(234, 179, 8, 0.12);
    --warn-border: rgba(234, 179, 8, 0.38);
    --warn-text: #f4cf6b;

    --danger: #f87171;
    --danger-soft: rgba(248, 113, 113, 0.12);
    --danger-border: rgba(248, 113, 113, 0.38);

    --radius-sm: 8px;
    --radius-md: 12px;
    --radius-lg: 18px;
    --radius-pill: 999px;

    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.4);
    --shadow-md: 0 10px 30px -12px rgba(0, 0, 0, 0.55);

    --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --font-mono: ui-monospace, "SF Mono", "Cascadia Code", Consolas, "Liberation Mono", monospace;
  }

  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-sans);
    -webkit-font-smoothing: antialiased;
  }
  ::selection { background: var(--accent-soft); color: var(--text); }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--surface-3); border-radius: 999px; border: 2px solid var(--bg); }
  * { scrollbar-color: var(--surface-3) transparent; scrollbar-width: thin; }

  a { color: var(--accent-text); }
  code {
    font-family: var(--font-mono);
    font-size: 0.92em;
    background: var(--surface-3);
    color: #ffb27a;
    padding: 1px 5px;
    border-radius: 4px;
  }

  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }

  .icon { width: 16px; height: 16px; flex: none; display: block; }

  /* --- topbar --- */
  .topbar {
    padding: 10px 20px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
    min-height: 56px;
  }
  .topbar-brand { display: flex; align-items: center; gap: 10px; }
  .brand-mark {
    display: flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; border-radius: var(--radius-sm);
    background: var(--accent-soft); color: var(--accent-text);
    border: 1px solid var(--accent-border);
    flex: none;
  }
  .brand-mark .icon { width: 18px; height: 18px; }
  .brand-title { font-size: 14px; font-weight: 700; line-height: 1.2; }
  .brand-sub { font-size: 11.5px; color: var(--text-faint); line-height: 1.2; }
  .topbar-nav { display: flex; align-items: center; gap: 4px; }
  .nav-link {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 12.5px; font-weight: 600; text-decoration: none;
    color: var(--text-dim); padding: 6px 10px; border-radius: var(--radius-sm);
    transition: background-color 0.15s ease, color 0.15s ease;
  }
  .nav-link:hover { background: var(--surface-2); color: var(--text); }
  .topbar-status { margin-left: auto; display: flex; align-items: center; }

  /* --- status chips --- */
  .status-badge { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .chip {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 3px 10px; border-radius: var(--radius-pill);
    font-size: 11.5px; font-weight: 600; letter-spacing: 0.01em;
    background: var(--surface-2); color: var(--text-dim);
    border: 1px solid var(--border); white-space: nowrap;
  }
  .chip-accent { background: var(--accent-soft); color: var(--accent-text); border-color: var(--accent-border); }
  .chip-success { background: var(--success-soft); color: var(--success-text); border-color: var(--success-border); }
  .chip-warn { background: var(--warn-soft); color: var(--warn-text); border-color: var(--warn-border); }

  /* --- buttons --- */
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 7px;
    font-family: inherit; font-size: 13px; font-weight: 600;
    padding: 8px 14px; border-radius: var(--radius-sm);
    border: 1px solid transparent; cursor: pointer;
    transition: background-color 0.15s ease, border-color 0.15s ease, transform 0.08s ease, opacity 0.15s ease;
    white-space: nowrap;
  }
  .btn:active { transform: translateY(1px); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; pointer-events: none; }
  .btn-primary { background: var(--accent-solid); color: #fff; }
  .btn-primary:hover { background: var(--accent-solid-hover); }
  .btn-ghost { background: var(--surface-2); color: var(--text); border-color: var(--border); }
  .btn-ghost:hover { background: var(--surface-3); border-color: var(--border-soft); }
  .btn-icon { padding: 8px; width: 36px; height: 36px; }

  /* --- inputs --- */
  .text-input, select {
    font-family: inherit; font-size: 13.5px; color: var(--text);
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 8px 12px;
  }
  .text-input::placeholder { color: var(--text-faint); }
  select { padding-right: 28px; appearance: none; cursor: pointer;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%239d9da8' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='m6 9 6 6 6-6'/></svg>");
    background-repeat: no-repeat; background-position: right 8px center; background-size: 14px;
  }

  /* --- surfaces --- */
  .panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 16px; }
  .panel h2 {
    font-size: 12px; margin: 0 0 12px; color: var(--text-faint);
    text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700;
  }

  /* --- notices --- */
  .notice {
    display: none; margin: 10px 20px 0; padding: 10px 14px;
    border-radius: var(--radius-md); border: 1px solid;
    font-size: 12.5px; line-height: 1.55; align-items: flex-start; gap: 10px;
  }
  .notice-icon { flex: none; margin-top: 1px; color: inherit; }
  .notice-warn { background: var(--warn-soft); border-color: var(--warn-border); color: var(--warn-text); }
  .notice-success { background: var(--success-soft); border-color: var(--success-border); color: var(--success-text); }
  .notice strong { color: inherit; }

  .hint { font-size: 12px; color: var(--text-faint); line-height: 1.6; }
  .empty { color: var(--text-faint); font-size: 13px; padding: 12px 0; }

  @media (prefers-reduced-motion: no-preference) {
    @keyframes msg-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  }
`;
