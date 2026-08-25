import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { runSweep } from "../src/flows/nudge";
import { NUDGE_TEXT } from "../src/messaging/screens";
import { createMockMessenger, type MockMessenger } from "../src/messaging/mock";
import type { DraftRecord, DraftStore } from "../src/db/drafts";
import type { RouteDeps } from "../src/webhook/router";
import { FakeBillStorage, FakeBusinessStore, FakeDraftStore, FakeTransactionStore, FakeUserStore } from "./fakes";

const PHONE = "61412345678";
const CONFIG = loadConfig({});
const NUDGE_WINDOW_MIN = CONFIG.ttl.draftMinutes - CONFIG.ttl.nudgeDelayMinutes; // 4 min

function makeDeps(): { store: FakeDraftStore; send: MockMessenger; deps: RouteDeps } {
  const users = new FakeUserStore([]);
  const businesses = new FakeBusinessStore(users);
  const store = new FakeDraftStore();
  const send = createMockMessenger();
  const deps: RouteDeps = {
    users,
    businesses,
    drafts: store,
    transactions: new FakeTransactionStore(),
    extraction: {
      run: async () => ({ extraction: undefined as never, gate: "low", machineRead: true, source: "none" }),
    },
    send,
    storage: new FakeBillStorage(),
    config: CONFIG,
  };
  return { store, send, deps };
}

async function seedDraft(
  store: DraftStore,
  opts: { flowState?: DraftRecord["flowState"]; expiresInMin?: number; nudged?: boolean } = {},
): Promise<DraftRecord> {
  const created = await store.createDraft({
    userPhone: PHONE,
    waMessageId: "wamid." + Math.random().toString(36).slice(2),
    imageUrls: [],
    flowExpiresAt: new Date(Date.now() + (opts.expiresInMin ?? 3) * 60_000),
  });
  if (!created) throw new Error("draft not created");
  const draft = await store.setFlowState(created.id, {
    flowState: opts.flowState ?? "awaiting_confirm",
  });
  if (opts.nudged) await store.markNudged(draft.id, new Date());
  return draft;
}

describe("runSweep (§5.6/§6.2)", () => {
  it("nudges an awaiting draft once and marks it", async () => {
    const { store, send, deps } = makeDeps();
    await seedDraft(store, { expiresInMin: 3 }); // inside the 4-minute nudge window

    const result = await runSweep(deps);
    expect(result).toEqual({ nudged: 1, expired: 0 });
    expect(send.sent).toHaveLength(1);
    expect(send.sent[0]?.to).toBe(PHONE);
    expect(send.sent[0]?.text).toBe(NUDGE_TEXT);

    const due = await store.findNudgeDue(new Date(), NUDGE_WINDOW_MIN * 60_000);
    expect(due).toHaveLength(0); // the one-nudge cap
  });

  it("never nudges the same draft twice", async () => {
    const { store, send, deps } = makeDeps();
    await seedDraft(store, { expiresInMin: 3 });

    await runSweep(deps);
    const result = await runSweep(deps);
    expect(result.nudged).toBe(0);
    expect(send.sent).toHaveLength(1);
  });

  it("does not nudge a draft outside the nudge window", async () => {
    const { store, send, deps } = makeDeps();
    await seedDraft(store, { expiresInMin: 8 }); // expires in 8 min — window starts at 6 min

    const result = await runSweep(deps);
    expect(result.nudged).toBe(0);
    expect(send.sent).toHaveLength(0);
  });

  it("nudges drafts in an editing state, but not processing drafts", async () => {
    const { store, send, deps } = makeDeps();
    await seedDraft(store, { expiresInMin: 2, flowState: "editing_amount" });
    await seedDraft(store, { expiresInMin: 2, flowState: "processing" });

    const result = await runSweep(deps);
    expect(result.nudged).toBe(1);
    expect(send.sent).toHaveLength(1);
  });

  it("expires drafts past flow_expires_at", async () => {
    const { store, deps } = makeDeps();
    const draft = await seedDraft(store, { expiresInMin: -1 }); // already overdue

    const result = await runSweep(deps);
    expect(result.expired).toBe(1);
    expect(result.nudged).toBe(0);
    expect(await store.findActiveDraft(PHONE)).toBeNull();
    expect(draft.id).toBeTruthy();
  });

  it("expires drafts and nudges the rest in one pass", async () => {
    const { store, send, deps } = makeDeps();
    await seedDraft(store, { expiresInMin: -1 });
    await seedDraft(store, { expiresInMin: 2 });

    const result = await runSweep(deps);
    expect(result).toEqual({ expired: 1, nudged: 1 });
    expect(send.sent).toHaveLength(1);
  });
});
