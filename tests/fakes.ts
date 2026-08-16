import type {
  BusinessPatch,
  BusinessRecord,
  BusinessStore,
  OnboardedUser,
  SetupStep,
} from "../src/db/businesses";
import {
  isDuplicateMatch,
  toDuplicateCandidate,
  type ConfirmOptions,
  type CreateDraftInput,
  type DraftRecord,
  type DraftStore,
  type FlowPatch,
} from "../src/db/drafts";
import type { UserRecord, UserStore } from "../src/db/users";
import type { BillStorage, UploadBillOptions, UploadedBill } from "../src/storage/bills";
import type { BillExtraction } from "../src/types";

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
      timezone: "Australia/Sydney",
      gstRegistered: true,
      autoSave: true,
    };
    this.businesses.set(id, business);
    const user: UserRecord = { phoneNumber, businessId: id, createdAt: new Date() };
    this.users.add(user);
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

  async findDuplicate(
    userPhone: string,
    extraction: BillExtraction,
    within: Date,
  ): Promise<DraftRecord | null> {
    const candidate = toDuplicateCandidate(extraction);
    return (
      this.drafts.find(
        (d) =>
          d.userPhone === userPhone &&
          d.status === "logged" &&
          d.confirmedAt !== undefined &&
          d.confirmedAt >= within &&
          d.extraction !== undefined &&
          isDuplicateMatch(toDuplicateCandidate(d.extraction), candidate),
      ) ?? null
    );
  }

  async softDeleteLogged(id: string): Promise<void> {
    const draft = this.drafts.find((d) => d.id === id);
    if (!draft) return;
    draft.status = "deleted";
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
