import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { D1Like } from "../src/db/d1";
import type {
  BusinessPatch,
  BusinessRecord,
  BusinessStore,
  MembershipRecord,
  OnboardedUser,
  SetupStep,
} from "../src/db/businesses";
import type {
  ConfirmOptions,
  CreateDraftInput,
  DraftRecord,
  DraftStore,
  FlowPatch,
  LoggedBillPatch,
} from "../src/db/drafts";
import type { TransactionStore } from "../src/db/transactions";
import type { UserRecord, UserStore } from "../src/db/users";
import type { RegularVendor, VendorCategorySuggestion } from "../src/extraction/vendor-categories";
import type { BillStorage, UploadBillOptions, UploadedBill } from "../src/storage/bills";

/** Recording BillStorage double: serves deterministic paths/URLs, can be made to fail. */
export class FakeBillStorage implements BillStorage {
  uploaded: Array<{ businessId: string; bytes: Uint8Array; mimeType: string; mediaId: string }> = [];
  fail = false;

  constructor(private readonly baseUrl = "https://cdn.test") {}

  async uploadBill(
    businessId: string,
    bytes: Uint8Array,
    mimeType: string,
    opts: UploadBillOptions,
  ): Promise<UploadedBill> {
    if (this.fail) throw new Error("storage unavailable");
    this.uploaded.push({ businessId, bytes, mimeType, mediaId: opts.mediaId });
    const ext = mimeType === "image/jpeg" ? "jpg" : "bin";
    const path = `${businessId}/2026/08/${opts.mediaId}.${ext}`;
    return { path, url: `${this.baseUrl}/bills/${path}` };
  }
}

/**
 * A node:sqlite-backed D1 shim (§5.5). Runs every REAL migration file under
 * migrations/ (numbered, applied in order — same convention `wrangler d1
 * migrations apply` follows) against an in-memory SQLite database and
 * implements the narrow D1Like surface the stores use — so store tests,
 * the demo/dashboard paths, and the smoke test exercise the real schema and
 * SQL semantics (foreign keys, partial unique index idempotency, RETURNING)
 * with zero Docker / no Cloudflare account.
 */
export function createTestD1(): D1Like {
  const db = new DatabaseSync(":memory:");
  const migrationsDir = resolve(process.cwd(), "migrations");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    db.exec(readFileSync(resolve(migrationsDir, file), "utf8"));
  }
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      let bound: SQLInputValue[] = [];
      return {
        bind(...values: SQLInputValue[]) {
          bound = values;
          return this as unknown as ReturnType<D1Like["prepare"]>;
        },
        all<T = unknown>() {
          return Promise.resolve({ results: stmt.all(...bound) as T[] });
        },
        first<T = unknown>() {
          const row = stmt.get(...bound);
          return Promise.resolve((row === undefined ? null : row) as T | null);
        },
        run() {
          const res = stmt.run(...bound);
          return Promise.resolve({ meta: { changes: Number(res.changes) } });
        },
      };
    },
    exec(sql: string) {
      db.exec(sql);
      return Promise.resolve();
    },
  };
}

export class FakeUserStore implements UserStore {
  private readonly users: UserRecord[];

  constructor(users: UserRecord[] = []) {
    this.users = users;
  }

  async findUser(phoneNumber: string): Promise<UserRecord | null> {
    return this.users.find((u) => u.phoneNumber === phoneNumber) ?? null;
  }

  /** Test helper: register a user (used by FakeBusinessStore.onboard). */
  add(user: UserRecord): void {
    if (!this.users.some((u) => u.phoneNumber === user.phoneNumber)) {
      this.users.push(user);
    }
  }
}

export class FakeBusinessStore implements BusinessStore {
  private readonly businesses = new Map<string, BusinessRecord>();
  private readonly steps = new Map<string, SetupStep>();
  private readonly memberships = new Map<string, MembershipRecord[]>();
  private seq = 0;

  constructor(private readonly users: FakeUserStore) {}

  async onboard(phoneNumber: string): Promise<OnboardedUser> {
    const existing = await this.users.findUser(phoneNumber);
    if (existing?.businessId) {
      const business = await this.findBusiness(existing.businessId);
      if (business) return { user: existing, business };
    }
    const id = `biz-${++this.seq}`;
    const business: BusinessRecord = {
      id,
      name: "My Business",
      abn: null,
      gstNumber: null,
      timezone: "Australia/Sydney",
      gstRegistered: true,
      autoSave: true,
      address: null,
      phone: null,
      createdAt: new Date(),
    };
    this.businesses.set(id, business);
    const user: UserRecord = { phoneNumber, businessId: id, createdAt: new Date() };
    this.users.add(user);
    this.addMember(id, { userPhone: phoneNumber, role: "owner", createdAt: new Date() });
    return { user, business };
  }

  async findBusiness(businessId: string): Promise<BusinessRecord | null> {
    return this.businesses.get(businessId) ?? null;
  }

  async updateBusiness(businessId: string, patch: BusinessPatch): Promise<BusinessRecord> {
    const business = this.businesses.get(businessId);
    if (!business) throw new Error(`business ${businessId} not found`);
    Object.assign(business, patch);
    return business;
  }

  /** Test helper: register an existing business (e.g. for a pre-seeded user). */
  addBusiness(business: BusinessRecord): void {
    this.businesses.set(business.id, business);
  }

  async getSetupStep(phoneNumber: string): Promise<SetupStep | null> {
    return this.steps.get(phoneNumber) ?? null;
  }

  async setSetupStep(phoneNumber: string, step: SetupStep | null): Promise<void> {
    if (step === null) this.steps.delete(phoneNumber);
    else this.steps.set(phoneNumber, step);
  }

  async listMembers(businessId: string): Promise<MembershipRecord[]> {
    return this.memberships.get(businessId) ?? [];
  }

  /** Test helper: register a membership row (owner rows are added by onboard()). */
  addMember(businessId: string, member: MembershipRecord): void {
    const list = this.memberships.get(businessId) ?? [];
    list.push(member);
    this.memberships.set(businessId, list);
  }

  async listAll(): Promise<BusinessRecord[]> {
    return [...this.businesses.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async assignBusiness(phoneNumber: string, businessId: string): Promise<BusinessRecord | null> {
    const business = this.businesses.get(businessId);
    if (!business) return null;
    const existing = await this.users.findUser(phoneNumber);
    if (existing) {
      Object.assign(existing, { businessId });
    } else {
      this.users.add({ phoneNumber, businessId, createdAt: new Date() });
    }
    const members = this.memberships.get(businessId) ?? [];
    if (!members.some((m) => m.userPhone === phoneNumber)) {
      this.addMember(businessId, { userPhone: phoneNumber, role: "owner", createdAt: new Date() });
    }
    return business;
  }
}

/** Vendor->category history double — empty by default (unseeded tests just
 *  need RouteDeps to type-check); tests exercising the episodic layer seed
 *  `history` directly. */
export class FakeTransactionStore implements TransactionStore {
  history = new Map<string, VendorCategorySuggestion>();
  regularVendors: RegularVendor[] = [];

  async getVendorCategoryHistory(): Promise<Map<string, VendorCategorySuggestion>> {
    return this.history;
  }

  async getRegularVendors(): Promise<RegularVendor[]> {
    return this.regularVendors;
  }
}

export class FakeDraftStore implements DraftStore {
  private drafts: DraftRecord[] = [];
  private seq = 0;

  async createDraft(input: CreateDraftInput): Promise<DraftRecord | null> {
    const existing = this.drafts.some(
      (d) => d.userPhone === input.userPhone && d.waMessageId === input.waMessageId,
    );
    if (existing) return null;
    const draft: DraftRecord = {
      id: `draft-${++this.seq}`,
      userPhone: input.userPhone,
      waMessageId: input.waMessageId,
      imageUrls: input.imageUrls,
      flowExpiresAt: input.flowExpiresAt,
      flowState: "processing",
      status: "draft",
      createdAt: new Date(),
      businessId: null,
      duplicateOfId: null,
    };
    this.drafts.push(draft);
    return draft;
  }

  async findActiveDraft(userPhone: string, now = new Date()): Promise<DraftRecord | null> {
    const active = this.drafts
      .filter((d) => d.userPhone === userPhone && d.status === "draft" && d.flowExpiresAt > now)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return active[0] ?? null;
  }

  async setFlowState(id: string, patch: FlowPatch): Promise<DraftRecord> {
    const draft = this.drafts.find((d) => d.id === id);
    if (!draft) throw new Error(`draft ${id} not found`);
    Object.assign(draft, patch);
    return draft;
  }

  async confirm(id: string, confirmedAt: Date, opts: ConfirmOptions = {}): Promise<DraftRecord | null> {
    const draft = this.drafts.find((d) => d.id === id);
    if (!draft) return null;
    draft.status = "logged";
    draft.flowState = null;
    draft.confirmedAt = confirmedAt;
    draft.autoLogged = opts.autoLogged ?? false;
    return draft;
  }

  async expire(id: string): Promise<void> {
    const draft = this.drafts.find((d) => d.id === id);
    if (!draft) return;
    draft.status = "expired";
    draft.flowState = null;
  }

  async findRecentLogged(userPhone: string, within: Date): Promise<DraftRecord | null> {
    const recent = this.logged(userPhone).filter(
      (d) => d.confirmedAt !== undefined && d.confirmedAt >= within,
    );
    return recent[0] ?? null;
  }

  async listLogged(userPhone: string, limit = 100): Promise<DraftRecord[]> {
    return this.logged(userPhone).slice(0, limit);
  }

  async listLoggedForBusiness(businessId: string, limit = 100): Promise<DraftRecord[]> {
    return this.drafts
      .filter(
        (d) =>
          d.businessId === businessId &&
          (d.status === "logged" || d.status === "paid") &&
          d.confirmedAt !== undefined,
      )
      .sort((a, b) => (b.confirmedAt?.getTime() ?? 0) - (a.confirmedAt?.getTime() ?? 0))
      .slice(0, limit);
  }

  async getLogged(id: string): Promise<DraftRecord | null> {
    return this.drafts.find((d) => d.id === id && (d.status === "logged" || d.status === "paid")) ?? null;
  }

  private logged(userPhone: string): DraftRecord[] {
    return this.drafts
      .filter(
        (d) =>
          d.userPhone === userPhone &&
          (d.status === "logged" || d.status === "paid") &&
          d.confirmedAt !== undefined,
      )
      .sort((a, b) => (b.confirmedAt?.getTime() ?? 0) - (a.confirmedAt?.getTime() ?? 0));
  }

  async findDuplicateForBusiness(
    businessId: string,
    candidate: { amount: number; billDate: string; excludeId?: string },
  ): Promise<DraftRecord | null> {
    const targetCents = Math.round(candidate.amount * 100);
    const matches = this.drafts
      .filter(
        (d) =>
          d.businessId === businessId &&
          (d.status === "logged" || d.status === "paid") &&
          d.id !== candidate.excludeId &&
          d.extraction?.date.value === candidate.billDate &&
          d.extraction.amount.value !== null &&
          Math.round(d.extraction.amount.value * 100) === targetCents,
      )
      .sort((a, b) => (b.confirmedAt?.getTime() ?? 0) - (a.confirmedAt?.getTime() ?? 0));
    return matches[0] ?? null;
  }

  async softDeleteLogged(id: string): Promise<void> {
    const draft = this.drafts.find((d) => d.id === id);
    if (!draft) return;
    draft.status = "deleted";
  }

  async resolveDuplicate(id: string, action: "keep" | "discard"): Promise<DraftRecord | null> {
    if (action === "keep") return this.confirm(id, new Date(), { autoLogged: false });
    await this.expire(id);
    return null;
  }

  async updateLogged(id: string, patch: LoggedBillPatch): Promise<DraftRecord | null> {
    const draft = this.drafts.find((d) => d.id === id && (d.status === "logged" || d.status === "paid"));
    if (!draft || !draft.extraction) return null;
    const field = <T,>(current: { value: T | null; confidence: number }, value: T | null | undefined) =>
      value === undefined ? current : { value, confidence: 1 };
    draft.extraction = {
      ...draft.extraction,
      vendor: field(draft.extraction.vendor, patch.vendor),
      category_hint: field(draft.extraction.category_hint, patch.category),
      amount: field(draft.extraction.amount, patch.amount),
      gst: field(draft.extraction.gst, patch.gst),
      date: field(draft.extraction.date, patch.date),
      due_date: field(draft.extraction.due_date, patch.dueDate),
      invoice_number: field(draft.extraction.invoice_number, patch.invoiceNumber),
      abn: field(draft.extraction.abn, patch.abn),
    };
    return draft;
  }

  async findNudgeDue(now: Date, nudgeWindowMs: number): Promise<DraftRecord[]> {
    const windowStart = new Date(now.getTime() + nudgeWindowMs);
    return this.drafts.filter(
      (d) =>
        d.status === "draft" &&
        d.flowNudgedAt === undefined &&
        d.flowExpiresAt > now &&
        d.flowExpiresAt <= windowStart &&
        d.flowState !== null &&
        (d.flowState === "awaiting_confirm" || d.flowState.startsWith("editing_")),
    );
  }

  async markNudged(id: string, nudgedAt: Date): Promise<void> {
    const draft = this.drafts.find((d) => d.id === id);
    if (draft) draft.flowNudgedAt = nudgedAt;
  }

  async expireDue(now: Date): Promise<number> {
    let count = 0;
    for (const draft of this.drafts) {
      if (draft.status === "draft" && draft.flowExpiresAt <= now) {
        draft.status = "expired";
        draft.flowState = null;
        count++;
      }
    }
    return count;
  }

  /** Test helper: mark a logged transaction as auto-logged (24 h undo window). */
  markAutoLogged(id: string): void {
    const draft = this.drafts.find((d) => d.id === id);
    if (draft) draft.autoLogged = true;
  }
}
