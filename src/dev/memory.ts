/**
 * In-memory store stack for the /dev/demo browser console (DEV-only, never in
 * production). Used when no D1/R2 bindings are present so the demo works with
 * zero setup; multi-turn state survives because the singleton lives in module
 * scope.
 *
 * Mirrors the real stores' behaviour closely enough for the flows to be driven
 * end to end — idempotency key, draft TTL, status transitions, undo windows.
 */
import type {
  BusinessPatch,
  BusinessRecord,
  BusinessStore,
  MembershipRecord,
  NewCompanyFields,
  OnboardedUser,
  SetupStep,
} from "../db/businesses";
import type { AuditEntry, AuditLogStore } from "../db/audit";
import { DASHBOARD_ADMIN } from "../db/audit";
import type {
  ConfirmOptions,
  CreateDraftInput,
  DraftRecord,
  DraftStore,
  FlowPatch,
  LoggedBillPatch,
} from "../db/drafts";
import type { UserRecord, UserStore } from "../db/users";
import type { BillStorage, UploadBillOptions, UploadedBill } from "../storage/bills";

export interface MemoryStack {
  users: UserStore;
  businesses: BusinessStore;
  drafts: DraftStore;
  storage: BillStorage;
  audit: AuditLogStore;
}

/**
 * Shared dev-store singleton: the webapp (/app), the demo console (/dev/demo),
 * and the dashboard (/dev/dashboard) all read the SAME in-memory store, so
 * bills logged in one surface appear in the others without any infra. Reset
 * with `resetSharedMemoryStack` between tests.
 */
let shared: MemoryStack | null = null;

export function getSharedMemoryStack(): MemoryStack {
  shared ??= createMemoryStack();
  return shared;
}

export function resetSharedMemoryStack(): void {
  shared = null;
}

export function createMemoryStack(): MemoryStack {
  const users = new MemoryUserStore();
  const businesses = new MemoryBusinessStore(users);
  return {
    users,
    businesses,
    drafts: new MemoryDraftStore(),
    storage: new MemoryBillStorage(),
    audit: new MemoryAuditLogStore(),
  };
}

class MemoryUserStore implements UserStore {
  private readonly rows = new Map<string, UserRecord>();

  async findUser(phoneNumber: string): Promise<UserRecord | null> {
    return this.rows.get(phoneNumber) ?? null;
  }

  /** Used by MemoryBusinessStore.onboard. */
  register(user: UserRecord): void {
    this.rows.set(user.phoneNumber, user);
  }
}

class MemoryBusinessStore implements BusinessStore {
  private readonly businesses = new Map<string, BusinessRecord>();
  private readonly steps = new Map<string, SetupStep>();
  private readonly memberships = new Map<string, MembershipRecord[]>();
  private seq = 0;

  constructor(private readonly users: MemoryUserStore) {}

  async onboard(phoneNumber: string): Promise<OnboardedUser> {
    const existing = await this.users.findUser(phoneNumber);
    if (existing?.businessId) {
      const business = this.businesses.get(existing.businessId);
      if (business) return { user: existing, business };
    }
    const business: BusinessRecord = {
      id: `biz-${++this.seq}`,
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
    this.businesses.set(business.id, business);
    const user: UserRecord = { phoneNumber, businessId: business.id, createdAt: new Date() };
    this.users.register(user);
    const members = this.memberships.get(business.id) ?? [];
    members.push({ userPhone: phoneNumber, role: "owner", createdAt: new Date() });
    this.memberships.set(business.id, members);
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

  async listAll(): Promise<BusinessRecord[]> {
    return [...this.businesses.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async assignBusiness(phoneNumber: string, businessId: string): Promise<BusinessRecord | null> {
    const business = this.businesses.get(businessId);
    if (!business) return null;
    const existing = await this.users.findUser(phoneNumber);
    this.users.register({ phoneNumber, businessId, createdAt: existing?.createdAt ?? new Date() });
    const members = this.memberships.get(businessId) ?? [];
    if (!members.some((m) => m.userPhone === phoneNumber)) {
      members.push({ userPhone: phoneNumber, role: "owner", createdAt: new Date() });
      this.memberships.set(businessId, members);
    }
    return business;
  }

  async createCompany(fields: NewCompanyFields): Promise<BusinessRecord> {
    const business: BusinessRecord = {
      id: `biz-${++this.seq}`,
      name: fields.name,
      abn: fields.abn || null,
      gstNumber: fields.gstNumber || null,
      timezone: fields.timezone || "Australia/Sydney",
      gstRegistered: fields.gstRegistered ?? true,
      autoSave: true,
      address: fields.address || null,
      phone: fields.phone || null,
      createdAt: new Date(),
    };
    this.businesses.set(business.id, business);
    return business;
  }
}

class MemoryDraftStore implements DraftStore {
  private readonly drafts: DraftRecord[] = [];
  private seq = 0;

  async createDraft(input: CreateDraftInput): Promise<DraftRecord | null> {
    if (this.drafts.some((d) => d.userPhone === input.userPhone && d.waMessageId === input.waMessageId)) {
      return null;
    }
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
    const draft = this.drafts.find((d) => d.id === id && (d.status === "logged" || d.status === "paid"));
    return draft ?? null;
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
    if (draft) draft.status = "deleted";
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
    const windowEnd = new Date(now.getTime() + nudgeWindowMs);
    return this.drafts.filter(
      (d) =>
        d.status === "draft" &&
        d.flowNudgedAt === undefined &&
        d.flowExpiresAt > now &&
        d.flowExpiresAt <= windowEnd &&
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
}

class MemoryAuditLogStore implements AuditLogStore {
  private readonly entries: AuditEntry[] = [];
  private readonly businessOf = new Map<string, string | null>();
  private seq = 0;

  async record(
    businessId: string | null,
    transactionId: string,
    action: "edit" | "delete",
    changes: Record<string, { from: unknown; to: unknown }>,
  ): Promise<void> {
    this.businessOf.set(transactionId, businessId);
    this.entries.push({
      id: `audit-${++this.seq}`,
      transactionId,
      action,
      changes,
      changedBy: DASHBOARD_ADMIN,
      createdAt: new Date(),
    });
  }

  async listRecent(businessId: string, limit = 50): Promise<AuditEntry[]> {
    // createdAt has millisecond resolution — two admin actions in the same
    // millisecond would tie; array index (insertion order) breaks the tie
    // the same way the D1 store's rowid does, so "newest first" holds.
    return this.entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => this.businessOf.get(entry.transactionId) === businessId)
      .sort((a, b) => b.entry.createdAt.getTime() - a.entry.createdAt.getTime() || b.index - a.index)
      .slice(0, limit)
      .map(({ entry }) => entry);
  }
}

export class MemoryBillStorage implements BillStorage {
  /** Recording — lets the demo tests assert the real uploaded bytes flowed through. */
  uploaded: Array<{ businessId: string; bytes: Uint8Array; mimeType: string; mediaId: string }> = [];

  async uploadBill(
    businessId: string,
    bytes: Uint8Array,
    mimeType: string,
    opts: UploadBillOptions,
  ): Promise<UploadedBill> {
    this.uploaded.push({ businessId, bytes, mimeType, mediaId: opts.mediaId });
    const path = `${businessId}/2026/08/${opts.mediaId}.${mimeType === "image/jpeg" ? "jpg" : "bin"}`;
    return { path, url: `https://demo.local/bills/${path}` };
  }
}

