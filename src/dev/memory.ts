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
  OnboardedUser,
  SetupStep,
} from "../db/businesses";
import type {
  ConfirmOptions,
  CreateDraftInput,
  DraftRecord,
  DraftStore,
  FlowPatch,
} from "../db/drafts";
import type { UserRecord, UserStore } from "../db/users";
import type { BillStorage, UploadBillOptions, UploadedBill } from "../storage/bills";
import type { BillExtraction } from "../types";

export interface MemoryStack {
  users: UserStore;
  businesses: BusinessStore;
  drafts: DraftStore;
  storage: BillStorage;
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

  async findDuplicate(userPhone: string, extraction: BillExtraction, within: Date): Promise<DraftRecord | null> {
    const candidate = toCandidate(extraction);
    return (
      this.drafts.find(
        (d) =>
          d.userPhone === userPhone &&
          d.status === "logged" &&
          d.confirmedAt !== undefined &&
          d.confirmedAt >= within &&
          d.extraction !== undefined &&
          matches(toCandidate(d.extraction), candidate),
      ) ?? null
    );
  }

  async softDeleteLogged(id: string): Promise<void> {
    const draft = this.drafts.find((d) => d.id === id);
    if (draft) draft.status = "deleted";
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

function toCandidate(e: BillExtraction): { invoiceNumber: string | null; vendor: string | null; amount: number | null } {
  return { invoiceNumber: e.invoice_number.value, vendor: e.vendor.value, amount: e.amount.value };
}

function matches(
  prev: { invoiceNumber: string | null; vendor: string | null; amount: number | null },
  candidate: { invoiceNumber: string | null; vendor: string | null; amount: number | null },
): boolean {
  if (candidate.invoiceNumber !== null && prev.invoiceNumber === candidate.invoiceNumber) return true;
  return (
    candidate.vendor !== null &&
    candidate.amount !== null &&
    prev.vendor === candidate.vendor &&
    prev.amount === candidate.amount
  );
}
