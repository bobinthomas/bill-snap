/**
 * One consistent line-icon family (24x24, 1.75 stroke, round caps) used across
 * /dev/demo and /dev/dashboard. There's no bundler in this Hono/Worker project
 * to pull an icon package from, so these are hand-authored — kept deliberately
 * simple/geometric and shared from one module so both pages draw from the
 * same set rather than drifting.
 */
const svg = (body: string) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const iconCamera = svg(
  `<path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="3.25"/>`,
);

export const iconReceipt = svg(
  `<path d="M6 3h12v17l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3-2 1.3Z"/><path d="M8.5 8h7M8.5 11.5h7M8.5 15h4.5"/>`,
);

export const iconRefresh = svg(
  `<path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3"/><path d="M18 3v4h-4M6 21v-4h4"/>`,
);

export const iconHelp = svg(
  `<circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.5 2.5 0 1 1 3.6 2.25c-.9.45-1.35 1-1.35 1.8"/><circle cx="12" cy="16.6" r="0.65" fill="currentColor" stroke="none"/>`,
);

export const iconTrash = svg(
  `<path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13"/><path d="M10 11v6M14 11v6"/>`,
);

export const iconSend = svg(
  `<path d="M20.5 3.5 3 10.2c-.7.3-.6 1.3.1 1.5l6.2 1.9 1.9 6.2c.2.7 1.2.8 1.5.1L20.5 3.5Z"/><path d="M9.5 13.7 20.5 3.5"/>`,
);

export const iconBarChart = svg(
  `<rect x="4" y="12" width="3.5" height="8" rx="1"/><rect x="10.25" y="6" width="3.5" height="14" rx="1"/><rect x="16.5" y="9" width="3.5" height="11" rx="1"/>`,
);

export const iconMessageCircle = svg(
  `<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.4 0-2.7-.32-3.87-.9L4 20l1.03-4.2A8.5 8.5 0 1 1 21 11.5Z"/>`,
);

export const iconHome = svg(
  `<path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9a1 1 0 0 0 1 1h4v-5h2v5h4a1 1 0 0 0 1-1v-9"/>`,
);

export const iconSparkles = svg(
  `<path d="M11 2 12.6 8.4 19 10l-6.4 1.6L11 18l-1.6-6.4L3 10l6.4-1.6Z"/><path d="M18 15l.7 2.3L21 18l-2.3.7L18 21l-.7-2.3L15 18l2.3-.7Z"/>`,
);

export const iconDownload = svg(`<path d="M12 4v11"/><path d="M7.5 11.5 12 16l4.5-4.5"/><path d="M5 20h14"/>`);

export const iconAlertTriangle = svg(
  `<path d="M12 4 22 20H2Z"/><path d="M12 10v4"/><circle cx="12" cy="17" r="0.7" fill="currentColor" stroke="none"/>`,
);

export const iconSearch = svg(`<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.8-4.8"/>`);

export const iconTag = svg(
  `<path d="M12 3h6a1 1 0 0 1 1 1v6L9.5 20.5a1 1 0 0 1-1.4 0l-6-6a1 1 0 0 1 0-1.4L12 3Z"/><circle cx="16" cy="8" r="1.4" fill="currentColor" stroke="none"/>`,
);

export const iconCheckCircle = svg(`<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.5 2.5L16 9"/>`);

export const iconXCircle = svg(`<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>`);

export const iconImage = svg(
  `<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5" fill="currentColor" stroke="none"/><path d="m4 17 5-5 3.5 3.5L17 11l3 3"/>`,
);

export const iconPencil = svg(
  `<path d="M4 20h4l10.5-10.5a2 2 0 0 0 0-2.83l-1.17-1.17a2 2 0 0 0-2.83 0L4 16v4Z"/><path d="M13.5 6.5 17.5 10.5"/>`,
);

export const iconUndo = svg(`<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 1 1 0 12H9"/>`);

export const iconChevronRight = svg(`<path d="m9 6 6 6-6 6"/>`);
