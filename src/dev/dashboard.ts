/**
 * /dev/dashboard — analytics over a user's logged bills (DEV-only, gated by
 * config.devDemo like the /dev/demo console). Defaults to the demo user; the
 * webapp passes ?device= so the mobile flow's bills show up here too. Reads
 * the SAME store the flow writes to, so bills confirmed in the chat or the
 * webapp show up.
 */
import type { AppConfig } from "../config";
import type { CloudBindings } from "../bindings";
import type { AuditEntry } from "../db/audit";
import { createD1AuditLogStore } from "../db/audit";
import type { BusinessPatch, BusinessRecord, MembershipRecord } from "../db/businesses";
import type { DraftRecord, LoggedBillPatch } from "../db/drafts";
import { CATEGORIES, type RegularVendor } from "../extraction/vendor-categories";
import { mergeKnownVendors } from "../extraction/regex";
import { resolveBusiness } from "../flows/helpers";
import { demoDeps, DEMO_PHONE } from "./demo";
import {
  iconBarChart,
  iconCheckCircle,
  iconDownload,
  iconHome,
  iconPencil,
  iconReceipt,
  iconRefresh,
  iconSettings,
  iconTag,
  iconTrash,
} from "./icons";
import { getSharedMemoryStack } from "./memory";
import { BASE_STYLES } from "./theme";
import { PREMIUM_FONTS, PREMIUM_REVEAL_SCRIPT, PREMIUM_STYLES } from "./theme-premium";

export interface CategoryStat {
  category: string;
  count: number;
  amount: number;
}

export interface VendorStat {
  vendor: string;
  count: number;
  amount: number;
}

export interface DayStat {
  date: string; // YYYY-MM-DD (UTC)
  count: number;
  amount: number;
}

export interface LoggedBill {
  id: string;
  confirmedAt: string; // ISO
  date: string | null; // bill date from the extraction
  vendor: string | null;
  /** The known vendor a mangled reading was canonicalised to (§5.3 vendor
   *  cleanup) — lets the accountant see a name was machine-resolved, not read. */
  vendorResolvedTo: string | null;
  category: string;
  amount: number | null;
  gst: number | null;
  gstBasis: "inclusive" | "exclusive" | "none" | null;
  invoiceNumber: string | null;
  abn: string | null;
  autoLogged: boolean;
  gateLevel?: string;
}

export interface DashboardFilters {
  /** YYYY-MM; null/absent = all time. */
  month?: string;
  category?: string;
  vendor?: string;
}

export interface DashboardData {
  persistence: "d1" | "in-memory";
  /** Known-vendor list (seed + learned from this user's logged bills) that
   *  canonicalises mangled merchant names at extraction time. */
  knownVendors: string[];
  totals: { count: number; amount: number; gst: number; autoLogged: number; manual: number };
  categories: CategoryStat[];
  vendors: VendorStat[];
  /** Last 7 days (all-time view) or per-day within the selected month. */
  days: DayStat[];
  /** YYYY-MM keys present across ALL logged bills, newest first — the month selector. */
  months: string[];
  /** Cascading filter options at the current month level (for the selects). */
  categoryOptions: string[];
  /** Cascading filter options at the month+category level. */
  vendorOptions: string[];
  /** The active filters (echoed so the client can render the selects). */
  filters: { month: string | null; category: string | null; vendor: string | null };
  /** All bills in the filtered scope (export) — recent is the page's slice. */
  rows: LoggedBill[];
  recent: LoggedBill[];
  /** The business behind this device/phone, if onboarded — the CSV export
   *  letterhead comes from here. */
  business: BusinessRecord | null;
}

const categoryOf = (b: DraftRecord) => b.extraction?.category_hint?.value ?? "misc";
const vendorOf = (b: DraftRecord) => b.extraction?.vendor.value ?? null;

/**
 * Analytics over the demo user's logged bills, scoped by cascading filters
 * (month → category → vendor). The options lists come from the level above the
 * active filter, so the selects narrow naturally; unknown filter values are
 * dropped rather than returning an empty view.
 */
export async function dashboardData(
  config: AppConfig,
  filters: DashboardFilters = {},
  bindings?: CloudBindings,
  userPhone: string = DEMO_PHONE,
): Promise<DashboardData> {
  const deps = demoDeps(config, undefined, bindings);
  const [bills, business] = await Promise.all([
    deps.drafts.listLogged(userPhone),
    resolveBusiness(deps, userPhone),
  ]);

  const months = [...new Set(bills.map((b) => b.confirmedAt?.toISOString().slice(0, 7)))]
    .filter((m): m is string => m !== undefined)
    .sort()
    .reverse();
  const month = filters.month && months.includes(filters.month) ? filters.month : null;
  const byMonth = month
    ? bills.filter((b) => b.confirmedAt?.toISOString().slice(0, 7) === month)
    : bills;

  const categoryOptions = [...new Set(byMonth.map(categoryOf))].sort();
  const category = filters.category && categoryOptions.includes(filters.category) ? filters.category : null;
  const byCategory = category ? byMonth.filter((b) => categoryOf(b) === category) : byMonth;

  const vendorOptions = [...new Set(byCategory.map(vendorOf))]
    .filter((v): v is string => v !== null)
    .sort();
  const vendor = filters.vendor && vendorOptions.includes(filters.vendor) ? filters.vendor : null;
  const scoped = vendor ? byCategory.filter((b) => vendorOf(b) === vendor) : byCategory;

  let amount = 0;
  let gst = 0;
  let autoLogged = 0;
  const cats = new Map<string, { count: number; amount: number }>();
  const vendors = new Map<string, { count: number; amount: number }>();

  for (const b of scoped) {
    const a = b.extraction?.amount.value ?? null;
    const g = b.extraction?.gst.value ?? null;
    const vendorName = vendorOf(b);
    if (a !== null) {
      amount += a;
      const cat = categoryOf(b);
      const c = cats.get(cat) ?? { count: 0, amount: 0 };
      c.count += 1;
      c.amount += a;
      cats.set(cat, c);
      if (vendorName !== null) {
        const v = vendors.get(vendorName) ?? { count: 0, amount: 0 };
        v.count += 1;
        v.amount += a;
        vendors.set(vendorName, v);
      }
    }
    if (g !== null) gst += g;
    if (b.autoLogged) autoLogged += 1;
  }

  const byAmount = <T extends { amount: number }>(xs: T[]): T[] =>
    [...xs].sort((x, y) => y.amount - x.amount);

  // The same merge the webapp/demo extraction uses — seed + vendors learned
  // from logged bills, so the dashboard shows how the list grows.
  const knownVendors = mergeKnownVendors(bills.map((b) => b.extraction?.vendor.value ?? null));

  return {
    persistence: bindings?.db ? "d1" : "in-memory",
    knownVendors,
    totals: {
      count: scoped.length,
      amount,
      gst,
      autoLogged,
      manual: scoped.length - autoLogged,
    },
    categories: byAmount(
      [...cats.entries()].map(([category, c]) => ({ category, count: c.count, amount: c.amount })),
    ),
    vendors: byAmount(
      [...vendors.entries()].map(([vendor, v]) => ({ vendor, count: v.count, amount: v.amount })),
    ).slice(0, 8),
    days: month ? monthDays(month, scoped) : last7Days(scoped),
    months,
    categoryOptions,
    vendorOptions,
    filters: { month, category, vendor },
    rows: scoped.map(toLoggedBill),
    recent: scoped.slice(0, 20).map(toLoggedBill),
    business,
  };
}

/** Last 7 days, zero-filled — the default all-time view. */
function last7Days(bills: DraftRecord[]): DayStat[] {
  const days: DayStat[] = [];
  for (let i = 6; i >= 0; i--) {
    const key = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    days.push({ date: key, count: 0, amount: 0 });
  }
  return fillDays(days, bills);
}

/** Every day of the selected month, zero-filled. */
function monthDays(month: string, bills: DraftRecord[]): DayStat[] {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const dayCount = new Date(y, m, 0).getDate(); // day 0 of month m+1 = last day of month m
  const days: DayStat[] = [];
  for (let d = 1; d <= dayCount; d++) {
    days.push({ date: `${month}-${String(d).padStart(2, "0")}`, count: 0, amount: 0 });
  }
  return fillDays(days, bills);
}

function fillDays(days: DayStat[], bills: DraftRecord[]): DayStat[] {
  for (const b of bills) {
    if (!b.confirmedAt) continue;
    const key = b.confirmedAt.toISOString().slice(0, 10);
    const day = days.find((d) => d.date === key);
    if (!day) continue;
    day.count += 1;
    const a = b.extraction?.amount.value ?? null;
    if (a !== null) day.amount += a;
  }
  return days;
}

function toLoggedBill(b: DraftRecord): LoggedBill {
  return {
    id: b.id,
    confirmedAt: (b.confirmedAt ?? b.createdAt).toISOString(),
    date: b.extraction?.date.value ?? null,
    vendor: b.extraction?.vendor.value ?? null,
    vendorResolvedTo: b.extraction?.vendor_resolved_to?.value ?? null,
    category: categoryOf(b),
    amount: b.extraction?.amount.value ?? null,
    gst: b.extraction?.gst.value ?? null,
    gstBasis: b.extraction?.gst_basis ?? null,
    invoiceNumber: b.extraction?.invoice_number.value ?? null,
    abn: b.extraction?.abn.value ?? null,
    autoLogged: b.autoLogged ?? false,
    gateLevel: b.gateLevel,
  };
}

/**
 * RFC-4180-style CSV for Excel/accounting tools: UTF-8 BOM (so Excel reads the
 * encoding and the currency symbols), CRLF line endings, fields containing
 * commas/quotes/newlines quoted with doubled quotes. Amounts are fixed to 2dp
 * so spreadsheet apps import them as numbers. When a business is onboarded,
 * a letterhead block (name/ABN/GST number/address/phone) is prepended above
 * the bill table — this is the "header for my sheets" the company-details
 * panel on the settings page exists to feed.
 */
export function billsToCsv(business: BusinessRecord | null, bills: LoggedBill[]): string {
  const header = [
    "Logged",
    "Bill date",
    "Vendor",
    "Vendor resolved to",
    "Category",
    "Amount",
    "GST",
    "GST basis",
    "Invoice",
    "ABN",
    "Source",
    "Gate",
  ];
  const body = bills.map((b) => [
    b.confirmedAt.slice(0, 10),
    b.date ?? "",
    b.vendor ?? "",
    b.vendorResolvedTo ?? "",
    b.category,
    b.amount === null ? "" : b.amount.toFixed(2),
    b.gst === null ? "" : b.gst.toFixed(2),
    b.gstBasis ?? "",
    b.invoiceNumber ?? "",
    b.abn ?? "",
    b.autoLogged ? "auto" : "manual",
    b.gateLevel ?? "",
  ]);
  const line = (row: string[]) => row.map(csvCell).join(",");
  const lead = business ? [...letterheadRows(business), []] : [];
  return "\uFEFF" + [...lead, header, ...body].map(line).join("\r\n") + "\r\n";
}

/** Letterhead rows above the bill table \u2014 one label:value per line, blank
 *  entries omitted so an unfilled company profile doesn't clutter the sheet. */
function letterheadRows(business: BusinessRecord): string[][] {
  const rows: string[][] = [[business.name || "Business"]];
  if (business.abn) rows.push([`ABN: ${business.abn}`]);
  if (business.gstNumber) rows.push([`GST number: ${business.gstNumber}`]);
  if (business.address) rows.push([`Address: ${business.address}`]);
  if (business.phone) rows.push([`Phone: ${business.phone}`]);
  rows.push([`Exported: ${new Date().toISOString().slice(0, 10)}`]);
  return rows;
}

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, "\"\"")}"` : v;
}

/** Download filename from the active filters — e.g. bills-2026-08-utilities.csv. */
export function exportFileName(filters: DashboardFilters): string {
  const parts = ["bills"];
  const clean = (s: string) => s.replace(/[^A-Za-z0-9-]+/g, "-").toLowerCase();
  if (filters.month) parts.push(filters.month);
  if (filters.category) parts.push(clean(filters.category));
  if (filters.vendor) parts.push(clean(filters.vendor));
  return parts.join("-") + ".csv";
}

const DASHBOARD_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>BillSnap — dashboard</title>
${PREMIUM_FONTS}
<style>
${BASE_STYLES}
${PREMIUM_STYLES}
  main { max-width: 1080px; margin: 0 auto; padding: 28px 20px 40px; }
  .eyebrow { margin-bottom: 18px; }
  .known-vendors { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 14px; min-height: 24px; }
  .known-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-faint); font-weight: 700; margin-right: 2px; }
  .toolbar { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: center; margin-bottom: 16px; }
  .toolbar-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .filters { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .filters label { font-size: 12px; color: var(--text-faint); display: inline-flex; align-items: center; gap: 6px; }
  /* --- KPI bento: "Total spend" is the featured tile, spanning two columns.
     5 columns (not 4) so the 4 cards — 1 + 2 + 1 + 1 — fill exactly one row
     instead of the last card wrapping with 3 empty columns beside it. --- */
  .kpi-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin-bottom: 18px; }
  .kpi-card {
    background: var(--surface); border: 1px solid var(--border-soft); border-radius: var(--radius-lg);
    padding: 16px 18px; display: flex; flex-direction: column; gap: 10px;
  }
  .kpi-card:nth-child(2) { grid-column: span 2; }
  .kpi-card .kpi-icon {
    display: flex; align-items: center; justify-content: center; width: 30px; height: 30px;
    border-radius: var(--radius-sm); background: var(--accent-soft); color: var(--accent-text);
    border: 1px solid var(--accent-border);
  }
  .kpi-card .kpi-icon .icon { width: 15px; height: 15px; }
  .kpi-card .label { font-size: 11.5px; color: var(--text-faint); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
  .kpi-card .value { font-family: var(--font-display); font-size: 27px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .kpi-card:nth-child(2) .value { font-family: var(--font-numeral); font-size: 32px; font-weight: 700; letter-spacing: -0.01em; }
  .kpi-card .sub { font-size: 11.5px; color: var(--text-faint); }
  @media (max-width: 900px) { .kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .kpi-card:nth-child(2) { grid-column: span 2; } }
  @media (max-width: 480px) { .kpi-grid { grid-template-columns: 1fr; } .kpi-card:nth-child(2) { grid-column: span 1; } .kpi-card:nth-child(2) .value { font-size: 27px; } }
  /* --- bento split: category takes more room than the vendor list --- */
  .cols { display: grid; grid-template-columns: 3fr 2fr; gap: 14px; margin-top: 4px; }
  @media (max-width: 720px) { .cols { grid-template-columns: 1fr; } }
  .bar-row { display: grid; grid-template-columns: 110px 1fr 76px; align-items: center; gap: 10px; margin-bottom: 9px; font-size: 12.5px; }
  .bar-row .name { text-align: right; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-track { background: var(--surface-3); border-radius: 4px; height: 8px; overflow: hidden; }
  .bar-fill { background: var(--accent); height: 100%; border-radius: 4px; }
  .bar-row .amt { text-align: right; color: var(--text-faint); font-variant-numeric: tabular-nums; }
  .days-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; margin-top: 4px; }
  .days { display: flex; gap: 6px; align-items: flex-end; height: 120px; }
  .day { flex: 1; min-width: 20px; display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .day .bar { width: 100%; background: var(--accent); border-radius: 4px 4px 0 0; min-height: 2px; }
  .day .date { font-size: 10px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
  .day .count { font-size: 11px; color: var(--text); font-variant-numeric: tabular-nums; }
  .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 4px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--border-soft); white-space: nowrap; }
  th { color: var(--text-faint); font-weight: 700; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; }
  tbody tr:hover td { background: var(--surface-2); }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .hint { margin-top: 16px; }

  /* --- mobile: stack the toolbar, widen tap targets, keep everything in-frame --- */
  @media (max-width: 720px) {
    main { padding: 14px 12px; }
    .toolbar { flex-direction: column; align-items: stretch; gap: 10px; }
    .toolbar-actions .btn { flex: 1 1 auto; justify-content: center; }
    .filters { flex-direction: column; align-items: stretch; gap: 8px; }
    .filters label { width: 100%; }
    .filters select { flex: 1; min-width: 0; }
    .btn, select { min-height: 40px; }
  }
  @media (max-width: 420px) {
    .bar-row { grid-template-columns: 72px 1fr 56px; gap: 6px; font-size: 11.5px; }
    th, td { padding: 8px; font-size: 11.5px; }
  }
</style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-brand">
      <span class="brand-mark">${iconBarChart}</span>
      <div><div class="brand-title">BillSnap</div><div class="brand-sub">Dashboard</div></div>
    </div>
    <nav class="topbar-nav">
      <a id="bills-link" class="nav-link" href="/dev/dashboard/bills">${iconReceipt} Bills</a>
      <a id="settings-link" class="nav-link" href="/dev/dashboard/settings">${iconSettings} Settings</a>
      <a class="nav-link" href="/">${iconHome} Landing</a>
    </nav>
    <div class="topbar-status"><span id="badge" class="status-badge"></span></div>
  </header>
  <main>
    <span class="eyebrow" data-reveal><span class="dot"></span>Live analytics</span>
    <div id="known" class="known-vendors"></div>
    <div class="toolbar" data-reveal>
      <div class="toolbar-actions">
        <button id="refresh" class="btn btn-ghost">${iconRefresh}<span>Refresh</span></button>
        <button id="export" class="btn btn-primary"><span class="icon-chip">${iconDownload}</span><span>Export CSV</span></button>
      </div>
      <div id="filters" class="filters">
        <label>Month <select id="f-month"></select></label>
        <label>Category <select id="f-category"></select></label>
        <label>Vendor <select id="f-vendor"></select></label>
      </div>
    </div>
    <div id="cards" class="kpi-grid" data-reveal></div>
    <div class="cols" data-reveal>
      <section class="panel"><div class="panel-inner"><h2>By category</h2><div id="cats"></div></div></section>
      <section class="panel"><div class="panel-inner"><h2>Top vendors</h2><div id="vendors"></div></div></section>
    </div>
    <section class="panel" style="margin-top:14px;" data-reveal><div class="panel-inner"><h2 id="days-title">Last 7 days</h2><div class="days-scroll"><div id="days"></div></div></div></section>
    <section class="panel" style="margin-top:14px;" data-reveal><div class="panel-inner"><h2>Recent bills</h2><div id="recent"></div></div></section>
    <p id="hint" class="hint">Bills confirmed in the <a href="/dev/demo">demo console</a> appear here automatically. Persistence is in-memory until local D1 is configured (<code>npm run dev:full</code>).</p>
  </main>
<script>
  const $ = (id) => document.getElementById(id);
  function money(n) { return n === null ? "—" : "$" + n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function chip(text, variant) {
    const cls = "chip" + (variant ? " chip-" + variant : "");
    return '<span class="' + cls + '">' + esc(text) + "</span>";
  }
  function bars(list, total) {
    if (!list.length) return '<div class="empty">No bills yet — send a photo in the demo console.</div>';
    return list.map((x) => {
      const pct = total > 0 ? Math.max(3, Math.round((x.amount / total) * 100)) : 0;
      return '<div class="bar-row"><span class="name" title="' + esc(x.category || x.vendor) + '">' + esc(x.category || x.vendor) + "</span>" +
        '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
        '<span class="amt">' + money(x.amount) + " · " + x.count + "</span></div>";
    }).join("");
  }
  function days(ds, monthView) {
    const max = Math.max(1, ...ds.map((d) => d.count));
    const label = (d) => monthView ? d.date.slice(8) : d.date.slice(5);
    return '<div class="days">' + ds.map((d) =>
      '<div class="day"><div class="bar" style="height:' + Math.max(4, (d.count / max) * 100) + '%"></div>' +
      '<span class="count">' + (d.count || "") + '</span><span class="date">' + label(d) + "</span></div>"
    ).join("") + "</div>";
  }
  function table(bills) {
    if (!bills.length) return '<div class="empty">Nothing logged yet.</div>';
    return '<div class="table-scroll"><table><thead><tr><th>Logged</th><th>Bill date</th><th>Vendor</th><th>Category</th>' +
      '<th class="num">Amount</th><th class="num">GST</th><th>Invoice</th><th>ABN</th><th>Source</th></tr></thead><tbody>' +
      bills.map((b) => {
        const when = new Date(b.confirmedAt).toISOString().slice(0, 10);
        const tag = b.autoLogged ? chip("auto", "success") : chip("manual");
    const resolved = b.vendorResolvedTo
      ? " " + '<span title="canonicalised from a mangled OCR reading to a known merchant">' + chip("resolved") + "</span>"
      : "";
    return "<tr><td>" + when + "</td><td>" + esc(b.date || "—") + "</td><td>" + esc(b.vendor || "—") + resolved + "</td><td>" +
      esc(b.category) + '</td><td class="num">' + money(b.amount) + '</td><td class="num">' + money(b.gst) +
      "</td><td>" + esc(b.invoiceNumber || "—") + "</td><td>" + esc(b.abn || "—") + "</td><td>" + tag + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }
  function render(d) {
    $("badge").innerHTML = chip(d.persistence === "d1" ? "D1 + R2" : "in-memory") +
      chip(d.totals.count + " logged") +
      (d.filters.month ? chip(d.filters.month, "accent") : "");
    const known = (d.knownVendors || []).filter((v) => !/^(telstra|origin energy|bunnings|caltex|homebase|rajesh|reliance hypermart limited|hdfc bank|gujarat freight tools)$/i.test(v));
    $("known").innerHTML = known.length
      ? '<span class="known-label">Learned vendors</span>' + known.map((v) => chip(v, "accent")).join("")
      : "";
    $("hint").innerHTML = d.persistence === "d1"
      ? 'Bills confirmed in the <a href="/dev/demo">demo console</a> are written to the local D1 store — they survive page reloads.'
      : 'Bills confirmed in the <a href="/dev/demo">demo console</a> appear here automatically. Persistence is in-memory — start <code>npm run dev:full</code> (local D1 + R2) and demo entries will survive reloads.';
    $("cards").innerHTML = [
      ['${iconReceipt}', "Bills logged", d.totals.count, ""],
      ['${iconBarChart}', "Total spend", money(d.totals.amount), ""],
      ['${iconTag}', "Total GST", money(d.totals.gst), ""],
      ['${iconCheckCircle}', "Auto-logged", d.totals.autoLogged + " of " + d.totals.count, d.totals.autoLogged ? "24 h undo window" : ""],
    ].map((c) => '<div class="kpi-card"><span class="kpi-icon">' + c[0] + '</span><div><div class="label">' + c[1] + '</div><div class="value">' + c[2] + '</div><div class="sub">' + c[3] + "</div></div></div>").join("");
    $("cats").innerHTML = bars(d.categories, d.totals.amount);
    $("vendors").innerHTML = bars(d.vendors, d.totals.amount);
    $("days-title").textContent = d.filters.month
      ? new Date(Number(d.filters.month.slice(0, 4)), Number(d.filters.month.slice(5, 7)) - 1, 1)
          .toLocaleString("en-AU", { month: "long", year: "numeric" }) + " — daily"
      : "Last 7 days";
    $("days").innerHTML = days(d.days, d.filters.month !== null);
    $("recent").innerHTML = table(d.recent);
  }
  function fillSelect(id, label, values, current) {
    const el = $(id);
    el.innerHTML = '<option value="">' + label + "</option>" + values.map((v) =>
      '<option value="' + esc(v) + '"' + (v === current ? " selected" : "") + ">" + esc(v) + "</option>"
    ).join("");
  }
  function populate(d) {
    fillSelect("f-month", "All months", d.months, d.filters.month);
    fillSelect("f-category", "All categories", d.categoryOptions, d.filters.category);
    fillSelect("f-vendor", "All vendors", d.vendorOptions, d.filters.vendor);
  }
  function currentParams() {
    const p = new URLSearchParams();
    const m = $("f-month").value, c = $("f-category").value, v = $("f-vendor").value;
    if (m) p.set("month", m);
    if (c) p.set("category", c);
    if (v) p.set("vendor", v);
    // Carry the device scope from the page URL (the webapp links here with
    // ?device=) so the data fetch sees the same user the page was opened for.
    const dev = new URLSearchParams(location.search).get("device");
    if (dev) p.set("device", dev);
    return p;
  }
  // Carry the same device scope into Settings so it shows this business, not the demo one.
  (function () {
    const dev = new URLSearchParams(location.search).get("device");
    if (dev) {
      $("settings-link").href = "/dev/dashboard/settings?device=" + encodeURIComponent(dev);
      $("bills-link").href = "/dev/dashboard/bills?device=" + encodeURIComponent(dev);
    }
  })();
  async function refresh() {
    const q = currentParams().toString();
    const res = await fetch("/dev/dashboard/data" + (q ? "?" + q : ""));
    if (res.ok) { const d = await res.json(); render(d); populate(d); }
  }
  ["f-month", "f-category", "f-vendor"].forEach((id) => { $(id).onchange = refresh; });
  $("refresh").onclick = refresh;
  $("export").onclick = () => {
    const q = currentParams().toString();
    const a = document.createElement("a");
    a.href = "/dev/dashboard/export.csv" + (q ? "?" + q : "");
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  refresh();
  setInterval(refresh, 2000);
</script>
<script>${PREMIUM_REVEAL_SCRIPT}</script>
</body>
</html>`;

export function renderDashboardPage(): string {
  return DASHBOARD_PAGE;
}

export interface DashboardSettingsData {
  business: BusinessRecord | null;
  regularVendors: RegularVendor[];
  members: MembershipRecord[];
}

/** Fetches everything the settings page shows for the business behind
 *  `device` (default the demo phone): the business record, its regular
 *  vendors (episodic memory, §extraction/vendor-categories), and its team. */
export async function dashboardSettingsData(
  config: AppConfig,
  bindings?: CloudBindings,
  userPhone: string = DEMO_PHONE,
): Promise<DashboardSettingsData> {
  const deps = demoDeps(config, undefined, bindings);
  const business = await resolveBusiness(deps, userPhone);
  if (!business) return { business: null, regularVendors: [], members: [] };
  const [regularVendors, members] = await Promise.all([
    deps.transactions.getRegularVendors(business.id),
    deps.businesses.listMembers(business.id),
  ]);
  return { business, regularVendors, members };
}

/** Persists the settings page's company-details form. Returns false (no-op)
 *  when the device/phone has no business yet — nothing to save. */
export async function saveDashboardSettings(
  config: AppConfig,
  bindings: CloudBindings | undefined,
  userPhone: string = DEMO_PHONE,
  patch: BusinessPatch,
): Promise<boolean> {
  const deps = demoDeps(config, undefined, bindings);
  const business = await resolveBusiness(deps, userPhone);
  if (!business) return false;
  await deps.businesses.updateBusiness(business.id, patch);
  return true;
}

function dashboardAuditStore(bindings?: CloudBindings) {
  return bindings?.db ? createD1AuditLogStore(bindings.db) : getSharedMemoryStack().audit;
}

export interface DashboardBillsData {
  business: BusinessRecord | null;
  bills: LoggedBill[];
  auditLog: AuditEntry[];
}

/** Bills table + audit trail data for the admin bills page (§dev/dashboard
 *  bills). Up to 500 most recent logged/paid bills — a soft cap, no real
 *  pagination yet, same as the 100-row default used elsewhere in this
 *  file — and the 50 most recent audit entries for the resolved business. */
export async function dashboardBillsData(
  config: AppConfig,
  bindings?: CloudBindings,
  userPhone: string = DEMO_PHONE,
): Promise<DashboardBillsData> {
  const deps = demoDeps(config, undefined, bindings);
  const business = await resolveBusiness(deps, userPhone);
  if (!business) return { business: null, bills: [], auditLog: [] };
  const [logged, auditLog] = await Promise.all([
    deps.drafts.listLogged(userPhone, 500),
    dashboardAuditStore(bindings).listRecent(business.id, 50),
  ]);
  return { business, bills: logged.map(toLoggedBill), auditLog };
}

export interface DashboardBillData {
  business: BusinessRecord | null;
  bill: LoggedBill | null;
}

/** Single logged bill for the admin edit form's prefill — see
 *  saveDashboardBillEdit's doc comment for the tenant-check rationale.
 *  `bill: null` with a non-null `business` means the id doesn't exist, isn't
 *  logged/paid, or belongs to another device — the route treats that as 404. */
export async function dashboardBillData(
  config: AppConfig,
  bindings: CloudBindings | undefined,
  userPhone: string = DEMO_PHONE,
  id: string,
): Promise<DashboardBillData> {
  const deps = demoDeps(config, undefined, bindings);
  const business = await resolveBusiness(deps, userPhone);
  if (!business) return { business: null, bill: null };
  const record = await deps.drafts.getLogged(id);
  if (!record || record.userPhone !== userPhone) return { business, bill: null };
  return { business, bill: toLoggedBill(record) };
}

const EDITABLE_BILL_FIELDS = ["vendor", "category", "amount", "gst", "date", "dueDate", "invoiceNumber", "abn"] as const;
type EditableBillField = (typeof EDITABLE_BILL_FIELDS)[number];

function extractionField(e: DraftRecord["extraction"], key: EditableBillField): unknown {
  if (!e) return null;
  switch (key) {
    case "vendor":
      return e.vendor.value;
    case "category":
      return e.category_hint.value;
    case "amount":
      return e.amount.value;
    case "gst":
      return e.gst.value;
    case "date":
      return e.date.value;
    case "dueDate":
      return e.due_date.value;
    case "invoiceNumber":
      return e.invoice_number.value;
    case "abn":
      return e.abn.value;
  }
}

/**
 * Applies an admin correction to a logged bill (§dev/dashboard bills table)
 * and records an audit entry for whichever fields actually changed — a
 * no-op patch (resubmitting the same values) logs nothing. The tenant check
 * is by `userPhone` (matches every other dashboard data function in this
 * file — device/phone-scoped, not business_id-scoped) rather than a
 * business_id column on the transaction, so a bill from another device
 * can't be edited/deleted through this device's dashboard even though the
 * dashboard itself is a single shared-password admin surface.
 */
export async function saveDashboardBillEdit(
  config: AppConfig,
  bindings: CloudBindings | undefined,
  userPhone: string = DEMO_PHONE,
  id: string,
  patch: LoggedBillPatch,
): Promise<"ok" | "not-found"> {
  const deps = demoDeps(config, undefined, bindings);
  const business = await resolveBusiness(deps, userPhone);
  if (!business) return "not-found";
  const before = await deps.drafts.getLogged(id);
  if (!before || before.userPhone !== userPhone) return "not-found";

  // Snapshot the pre-edit values by primitive, not by reference: the
  // in-memory store's updateLogged mutates the SAME DraftRecord object
  // `before` points at (unlike D1, where each read is an independent row),
  // so comparing before.extraction against after.extraction post-update
  // would silently diff a value against itself.
  const beforeValues = new Map(EDITABLE_BILL_FIELDS.map((key) => [key, extractionField(before.extraction, key)]));

  const after = await deps.drafts.updateLogged(id, patch);
  if (!after) return "not-found";

  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of EDITABLE_BILL_FIELDS) {
    if (!(key in patch)) continue;
    const from = beforeValues.get(key);
    const to = extractionField(after.extraction, key);
    if (from !== to) changes[key] = { from, to };
  }
  if (Object.keys(changes).length > 0) {
    await dashboardAuditStore(bindings).record(business.id, id, "edit", changes);
  }
  return "ok";
}

/** Soft-deletes a logged bill (reuses the same §7.4 status transition the
 *  webapp's own undo uses) and snapshots its fields into the audit trail —
 *  see saveDashboardBillEdit's doc comment for the tenant-check rationale. */
export async function deleteDashboardBill(
  config: AppConfig,
  bindings: CloudBindings | undefined,
  userPhone: string = DEMO_PHONE,
  id: string,
): Promise<"ok" | "not-found"> {
  const deps = demoDeps(config, undefined, bindings);
  const business = await resolveBusiness(deps, userPhone);
  if (!business) return "not-found";
  const bill = await deps.drafts.getLogged(id);
  if (!bill || bill.userPhone !== userPhone) return "not-found";

  await deps.drafts.softDeleteLogged(id);
  const snapshot: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of EDITABLE_BILL_FIELDS) {
    const value = extractionField(bill.extraction, key);
    if (value !== null) snapshot[key] = { from: value, to: null };
  }
  await dashboardAuditStore(bindings).record(business.id, id, "delete", snapshot);
  return "ok";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function withDevice(path: string, device?: string): string {
  return device ? `${path}?device=${encodeURIComponent(device)}` : path;
}

/**
 * Settings page — company profile (the letterhead used on the CSV export),
 * regular vendors, team, spending categories, and a data-export shortcut.
 * Only the company-details form is wired to a save endpoint (POST back to
 * this same route); the rest are read-only summaries derived from bills.
 */
export function renderDashboardSettingsPage(data: DashboardSettingsData, device?: string, saved?: boolean): string {
  const { business, regularVendors, members } = data;
  const field = (v: string | null) => (v ? escapeHtml(v) : "");
  const gstChecked = business?.gstRegistered ? " checked" : "";
  const autoSaveChecked = business?.autoSave ? " checked" : "";
  const dashboardHref = withDevice("/dev/dashboard", device);
  const exportHref = withDevice("/dev/dashboard/export.csv", device);

  const vendorRows = regularVendors.length
    ? regularVendors
        .map((v) => {
          const categoryChip =
            v.category === "mixed"
              ? `<span class="chip chip-warn">Mixed</span>`
              : `<span class="chip chip-accent">${escapeHtml(v.category)}</span>`;
          return `<tr><td>${escapeHtml(v.vendor)}</td><td class="num">${v.billCount}</td><td>${categoryChip}</td></tr>`;
        })
        .join("")
    : "";

  const memberRows = members.length
    ? members
        .map((m) => {
          const roleChip =
            m.role === "owner"
              ? `<span class="chip chip-accent">Owner</span>`
              : `<span class="chip">Staff</span>`;
          return `<tr><td>${escapeHtml(m.userPhone)}</td><td>${roleChip}</td><td>${m.createdAt.toISOString().slice(0, 10)}</td></tr>`;
        })
        .join("")
    : "";

  const categoryChips = CATEGORIES.map((c) => `<span class="chip">${escapeHtml(c)}</span>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>BillSnap — settings</title>
${PREMIUM_FONTS}
<style>
${BASE_STYLES}
${PREMIUM_STYLES}
  main { max-width: 720px; margin: 0 auto; padding: 28px 20px 40px; }
  .panel + .panel, section.panel ~ section.panel { margin-top: 14px; }
  .field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
  .field label { font-size: 12.5px; font-weight: 600; color: var(--text-dim); }
  .field .text-input { width: 100%; }
  .field-check { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
  .field-check input { width: 16px; height: 16px; accent-color: var(--accent-solid); }
  .field-check label { font-size: 13px; color: var(--text); }
  .field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 560px) { .field-row { grid-template-columns: 1fr; } }
  .chip-row { display: flex; flex-wrap: wrap; gap: 6px; }
  .hint { margin-top: 14px; }
  .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 4px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--border-soft); white-space: nowrap; }
  th { color: var(--text-faint); font-weight: 700; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; }
  tbody tr:hover td { background: var(--surface-2); }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-brand">
      <span class="brand-mark">${iconSettings}</span>
      <div><div class="brand-title">BillSnap</div><div class="brand-sub">Settings</div></div>
    </div>
    <nav class="topbar-nav">
      <a class="nav-link" href="${dashboardHref}">${iconBarChart} Dashboard</a>
      <a class="nav-link" href="${withDevice("/dev/dashboard/bills", device)}">${iconReceipt} Bills</a>
      <a class="nav-link" href="/">${iconHome} Landing</a>
    </nav>
  </header>
  <main>
    <span class="eyebrow" data-reveal><span class="dot"></span>Company details</span>
    <section class="panel" data-reveal>
      <div class="panel-inner">
        <h2>Basic information</h2>
        ${
          business
            ? `${saved ? `<div class="notice notice-success" data-reveal><span class="notice-icon">${iconCheckCircle}</span><span>Saved.</span></div>` : ""}
        <form method="post" action="${withDevice("/dev/dashboard/settings", device)}">
          ${device ? `<input type="hidden" name="device" value="${escapeHtml(device)}" />` : ""}
          <div class="field"><label for="s-name">Company name</label><input id="s-name" name="name" class="text-input" type="text" value="${field(business.name)}" /></div>
        <div class="field-row">
          <div class="field"><label for="s-abn">ABN</label><input id="s-abn" name="abn" class="text-input" type="text" placeholder="Not set" value="${field(business.abn)}" /></div>
          <div class="field"><label for="s-gst-number">GST number</label><input id="s-gst-number" name="gstNumber" class="text-input" type="text" placeholder="Not set" value="${field(business.gstNumber)}" /></div>
        </div>
        <div class="field"><label for="s-address">Address</label><input id="s-address" name="address" class="text-input" type="text" placeholder="Not set" value="${field(business.address)}" /></div>
        <div class="field-row">
          <div class="field"><label for="s-phone">Phone number</label><input id="s-phone" name="phone" class="text-input" type="text" placeholder="Not set" value="${field(business.phone)}" /></div>
          <div class="field"><label for="s-timezone">Timezone</label><input id="s-timezone" name="timezone" class="text-input" type="text" value="${field(business.timezone)}" /></div>
        </div>
        <div class="field-check"><input id="s-gst" name="gstRegistered" type="checkbox"${gstChecked} /><label for="s-gst">GST registered</label></div>
        <div class="field-check"><input id="s-autosave" name="autoSave" type="checkbox"${autoSaveChecked} /><label for="s-autosave">Auto-save high-confidence bills</label></div>
        <button class="btn btn-primary" type="submit">Save changes</button>
        </form>
        <p class="hint">Used as the letterhead on your CSV export.</p>`
            : `<div class="empty">No business found for this device yet — send a bill first.</div>`
        }
      </div>
    </section>
    ${
      business
        ? `<section class="panel" data-reveal>
      <div class="panel-inner">
        <h2>Regular vendors</h2>
        ${
          vendorRows
            ? `<div class="table-scroll"><table><thead><tr><th>Vendor</th><th>Bills logged</th><th>Category</th></tr></thead><tbody>${vendorRows}</tbody></table></div>`
            : `<div class="empty">No regular vendors yet — repeat vendors appear here after 2+ bills.</div>`
        }
      </div>
    </section>
    <section class="panel" data-reveal>
      <div class="panel-inner">
        <h2>Team members</h2>
        ${
          memberRows
            ? `<div class="table-scroll"><table><thead><tr><th>Phone</th><th>Role</th><th>Joined</th></tr></thead><tbody>${memberRows}</tbody></table></div>`
            : `<div class="empty">No team members found.</div>`
        }
      </div>
    </section>
    <section class="panel" data-reveal>
      <div class="panel-inner">
        <h2>Spending categories</h2>
        <div class="chip-row">${categoryChips}</div>
      </div>
    </section>
    <section class="panel" data-reveal>
      <div class="panel-inner">
        <h2>Data export</h2>
        <a class="btn btn-ghost" href="${exportHref}"><span class="icon-chip">${iconDownload}</span><span>Export all bills (CSV)</span></a>
      </div>
    </section>`
        : ""
    }
    ${business ? `<p class="hint">Regular vendors, team, and spending categories are generated automatically from your logged bills.</p>` : ""}
  </main>
<script>${PREMIUM_REVEAL_SCRIPT}</script>
</body>
</html>`;
}

function formatMoney(n: number | null): string {
  return n === null ? "—" : "$" + n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatAuditChanges(changes: Record<string, { from: unknown; to: unknown }>): string {
  const fmt = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : escapeHtml(String(v)));
  return Object.entries(changes)
    .map(([field, { from, to }]) => `${escapeHtml(field)}: ${fmt(from)} → ${fmt(to)}`)
    .join(", ");
}

/**
 * Admin bills table — every logged bill with edit/delete, plus the audit
 * trail those actions write to (§dev/dashboard/bills). Gated the same way
 * as every other /dev/dashboard/* route: the shared dashboard password —
 * see saveDashboardBillEdit's doc comment for why that's sufficient here.
 */
export function renderDashboardBillsPage(
  data: DashboardBillsData,
  device?: string,
  flash?: "saved" | "deleted",
): string {
  const { business, bills, auditLog } = data;
  const dashboardHref = withDevice("/dev/dashboard", device);
  const settingsHref = withDevice("/dev/dashboard/settings", device);

  const billRows = bills.length
    ? bills
        .map((b) => {
          const editHref = withDevice(`/dev/dashboard/bills/${encodeURIComponent(b.id)}/edit`, device);
          const deleteAction = withDevice(`/dev/dashboard/bills/${encodeURIComponent(b.id)}/delete`, device);
          return `<tr>
          <td>${escapeHtml(b.date ?? b.confirmedAt.slice(0, 10))}</td>
          <td>${escapeHtml(b.vendor ?? "—")}</td>
          <td><span class="chip chip-accent">${escapeHtml(b.category)}</span></td>
          <td class="num">${formatMoney(b.amount)}</td>
          <td class="num">${formatMoney(b.gst)}</td>
          <td>${escapeHtml(b.invoiceNumber ?? "—")}</td>
          <td class="row-actions">
            <a class="btn btn-ghost btn-icon" href="${editHref}" aria-label="Edit bill" title="Edit">${iconPencil}</a>
            <form method="post" action="${deleteAction}" onsubmit="return confirm('Delete this bill? This cannot be undone.');">
              ${device ? `<input type="hidden" name="device" value="${escapeHtml(device)}" />` : ""}
              <button class="btn btn-danger btn-icon" type="submit" aria-label="Delete bill" title="Delete">${iconTrash}</button>
            </form>
          </td>
        </tr>`;
        })
        .join("")
    : "";

  const auditRows = auditLog.length
    ? auditLog
        .map((a) => {
          const bill = bills.find((b) => b.id === a.transactionId);
          const label = bill
            ? `${escapeHtml(bill.vendor ?? "—")} · ${formatMoney(bill.amount)}`
            : escapeHtml(a.transactionId);
          const actionChip =
            a.action === "delete"
              ? `<span class="chip chip-warn">Deleted</span>`
              : `<span class="chip chip-accent">Edited</span>`;
          return `<tr>
          <td>${escapeHtml(a.createdAt.toISOString().slice(0, 16).replace("T", " "))}</td>
          <td>${actionChip}</td>
          <td>${label}</td>
          <td>${formatAuditChanges(a.changes)}</td>
          <td>${escapeHtml(a.changedBy)}</td>
        </tr>`;
        })
        .join("")
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>BillSnap — bills</title>
${PREMIUM_FONTS}
<style>
${BASE_STYLES}
${PREMIUM_STYLES}
  main { max-width: 960px; margin: 0 auto; padding: 28px 20px 40px; }
  .panel + .panel, section.panel ~ section.panel { margin-top: 14px; }
  .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 4px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--border-soft); white-space: nowrap; }
  th { color: var(--text-faint); font-weight: 700; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; }
  tbody tr:hover td { background: var(--surface-2); }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.row-actions { display: flex; gap: 6px; align-items: center; }
  td.row-actions form { display: contents; }
  .btn-danger { background: var(--danger-soft); color: var(--danger); border-color: var(--danger-border); }
  .btn-danger:hover { background: var(--danger-border); }
</style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-brand">
      <span class="brand-mark">${iconReceipt}</span>
      <div><div class="brand-title">BillSnap</div><div class="brand-sub">Bills</div></div>
    </div>
    <nav class="topbar-nav">
      <a class="nav-link" href="${dashboardHref}">${iconBarChart} Dashboard</a>
      <a class="nav-link" href="${settingsHref}">${iconSettings} Settings</a>
      <a class="nav-link" href="/">${iconHome} Landing</a>
    </nav>
  </header>
  <main>
    <span class="eyebrow" data-reveal><span class="dot"></span>Bill management</span>
    ${
      flash === "saved"
        ? `<div class="notice notice-success" data-reveal><span class="notice-icon">${iconCheckCircle}</span><span>Bill updated.</span></div>`
        : flash === "deleted"
          ? `<div class="notice notice-success" data-reveal><span class="notice-icon">${iconCheckCircle}</span><span>Bill deleted.</span></div>`
          : ""
    }
    <section class="panel" data-reveal>
      <div class="panel-inner">
        <h2>All bills</h2>
        ${
          business
            ? billRows
              ? `<div class="table-scroll"><table><thead><tr><th>Date</th><th>Vendor</th><th>Category</th><th>Amount</th><th>GST</th><th>Invoice</th><th></th></tr></thead><tbody>${billRows}</tbody></table></div>`
              : `<div class="empty">No bills logged yet.</div>`
            : `<div class="empty">No business found for this device yet — send a bill first.</div>`
        }
      </div>
    </section>
    ${
      business
        ? `<section class="panel" data-reveal>
      <div class="panel-inner">
        <h2>Audit trail</h2>
        ${
          auditRows
            ? `<div class="table-scroll"><table><thead><tr><th>When</th><th>Action</th><th>Bill</th><th>Changes</th><th>By</th></tr></thead><tbody>${auditRows}</tbody></table></div>`
            : `<div class="empty">No edits or deletions yet.</div>`
        }
      </div>
    </section>`
        : ""
    }
  </main>
<script>${PREMIUM_REVEAL_SCRIPT}</script>
</body>
</html>`;
}

/** Admin edit form for a single logged bill — prefilled, POSTs back to
 *  /dev/dashboard/bills/:id/edit. vendorResolvedTo (system-computed) and
 *  dueDate (not shown anywhere else in the app — CSV export, settings, etc.
 *  all omit it) are deliberately not exposed here. */
export function renderDashboardBillEditPage(bill: LoggedBill, device?: string, error?: string): string {
  const billsHref = withDevice("/dev/dashboard/bills", device);
  const field = (v: string | null) => (v ? escapeHtml(v) : "");
  const categoryOptions = CATEGORIES.map(
    (c) => `<option value="${c}"${c === bill.category ? " selected" : ""}>${escapeHtml(c)}</option>`,
  ).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>BillSnap — edit bill</title>
${PREMIUM_FONTS}
<style>
${BASE_STYLES}
${PREMIUM_STYLES}
  main { max-width: 560px; margin: 0 auto; padding: 28px 20px 40px; }
  .field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
  .field label { font-size: 12.5px; font-weight: 600; color: var(--text-dim); }
  .field .text-input, .field select { width: 100%; }
  .field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 560px) { .field-row { grid-template-columns: 1fr; } }
  .form-actions { display: flex; gap: 10px; margin-top: 6px; }
  .error-notice { color: var(--danger); font-size: 13px; margin: 0 0 16px; }
</style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-brand">
      <span class="brand-mark">${iconPencil}</span>
      <div><div class="brand-title">BillSnap</div><div class="brand-sub">Edit bill</div></div>
    </div>
    <nav class="topbar-nav">
      <a class="nav-link" href="${billsHref}">${iconReceipt} Bills</a>
    </nav>
  </header>
  <main>
    <span class="eyebrow" data-reveal><span class="dot"></span>Admin correction</span>
    <section class="panel" data-reveal>
      <div class="panel-inner">
        <h2>Edit bill</h2>
        ${error ? `<p class="error-notice">${escapeHtml(error)}</p>` : ""}
        <form method="post" action="${withDevice(`/dev/dashboard/bills/${encodeURIComponent(bill.id)}/edit`, device)}">
          ${device ? `<input type="hidden" name="device" value="${escapeHtml(device)}" />` : ""}
          <div class="field"><label for="b-vendor">Vendor</label><input id="b-vendor" name="vendor" class="text-input" type="text" value="${field(bill.vendor)}" /></div>
          <div class="field-row">
            <div class="field"><label for="b-category">Category</label><select id="b-category" name="category">${categoryOptions}</select></div>
            <div class="field"><label for="b-date">Bill date</label><input id="b-date" name="date" class="text-input" type="date" value="${field(bill.date)}" /></div>
          </div>
          <div class="field-row">
            <div class="field"><label for="b-amount">Amount</label><input id="b-amount" name="amount" class="text-input" type="number" step="0.01" value="${bill.amount ?? ""}" /></div>
            <div class="field"><label for="b-gst">GST</label><input id="b-gst" name="gst" class="text-input" type="number" step="0.01" value="${bill.gst ?? ""}" /></div>
          </div>
          <div class="field-row">
            <div class="field"><label for="b-invoice">Invoice number</label><input id="b-invoice" name="invoiceNumber" class="text-input" type="text" placeholder="Not set" value="${field(bill.invoiceNumber)}" /></div>
            <div class="field"><label for="b-abn">ABN</label><input id="b-abn" name="abn" class="text-input" type="text" placeholder="Not set" value="${field(bill.abn)}" /></div>
          </div>
          <div class="form-actions">
            <button class="btn btn-primary" type="submit">Save changes</button>
            <a class="btn btn-ghost" href="${billsHref}">Cancel</a>
          </div>
        </form>
      </div>
    </section>
  </main>
<script>${PREMIUM_REVEAL_SCRIPT}</script>
</body>
</html>`;
}
