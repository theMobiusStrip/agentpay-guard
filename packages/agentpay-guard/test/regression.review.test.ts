import { describe, expect, it } from "vitest";
import { installAgentPayGuard } from "../src/guard.js";
import { evaluatePayment } from "../src/evaluate.js";
import { ManualClock } from "../src/clock.js";
import { InMemoryAtomicStore } from "../src/store/memory.js";
import type { AuditEvent } from "../src/audit.js";
import type {
  PaymentCreatedContextLike,
  PaymentCreationContextLike,
  PaymentResponseContextLike,
  X402ClientLike,
  X402PaymentRequirementsLike,
} from "../src/x402-types.js";
import { BASE_SEPOLIA, USDC, testPolicy } from "./helpers.js";

/** Regression tests for the adversarial correctness review findings. */

class FakeClient implements X402ClientLike {
  before?: (c: PaymentCreationContextLike) => Promise<void | { abort: true; reason: string }>;
  after?: (c: PaymentCreatedContextLike) => Promise<void>;
  failure?: (c: any) => Promise<any>;
  response?: (c: PaymentResponseContextLike) => Promise<any>;
  onBeforePaymentCreation(h: any) { this.before = h; return this; }
  onAfterPaymentCreation(h: any) { this.after = h; return this; }
  onPaymentCreationFailure(h: any) { this.failure = h; return this; }
  onPaymentResponse(h: any) { this.response = h; return this; }
}

function requirements(amount = "100000"): X402PaymentRequirementsLike {
  return { scheme: "exact", network: BASE_SEPOLIA, asset: USDC, amount, payTo: "0xmerchant", maxTimeoutSeconds: 20 };
}
function beforeCtx(): PaymentCreationContextLike {
  const r = requirements();
  return { paymentRequired: { x402Version: 2, resource: { url: "https://x" }, accepts: [r] }, selectedRequirements: r };
}
function afterCtx(nonce: string, validBefore: string, to = "0xmerchant", value = "100000"): PaymentCreatedContextLike {
  return {
    ...beforeCtx(),
    paymentPayload: { x402Version: 2, payload: { authorization: { to, value, validBefore, nonce } } },
  };
}
function responseCtx(nonce: string, success: boolean): PaymentResponseContextLike {
  return {
    paymentPayload: { x402Version: 2, payload: { authorization: { to: "0xmerchant", value: "100000", nonce } } },
    requirements: requirements(),
    settleResponse: { success },
  };
}

function install(clockMs = 1_000_000_000, cap = 1_000_000n, distinctDedup = false) {
  const store = new InMemoryAtomicStore();
  const clock = new ManualClock(clockMs);
  const events: AuditEvent[] = [];
  const client = new FakeClient();
  let n = 0;
  const guard = installAgentPayGuard(client, {
    policy: testPolicy({ perMandateCap: cap }),
    store,
    principalId: "p1",
    clock,
    onAudit: (e) => events.push(e),
    // Model distinct logical purchases (distinct payer-set payment-identifiers)
    // that share identical requirements — the concurrent-fungible case.
    ...(distinctDedup ? { resolveDedupContext: () => ({ paymentIdentifier: `pid-${n++}` }) } : {}),
  });
  return { store, clock, events, client, guard };
}

describe("Finding 1: nonce correlation survives concurrent-identical reordering", () => {
  it("onResponse(A) firing before after(B) settles the correct reservations (no drop/overspend)", async () => {
    const { client, store } = install(1_000_000_000, 1_000_000n, true);
    const vb = String(1_000_000 + 20);
    // Interleaving A from the review: before A, before B, after A, RESPONSE A, after B, response B.
    await client.before(beforeCtx());
    await client.before(beforeCtx());
    await client.after(afterCtx("0xaaa", vb));
    await client.response(responseCtx("0xaaa", true)); // A settles before B even signs
    await client.after(afterCtx("0xbbb", vb));
    await client.response(responseCtx("0xbbb", true));

    const settled = await store.totalSettled();
    expect(settled).toBe(200_000n); // both settled, nothing dropped
    const committed = await store.committedAmount("p1", "__no_mandate__", 1_000_000, 60_000);
    expect(committed).toBe(200_000n);
  });

  it("onFailure never releases a signed authorization's hold (Finding 1 interleaving B/C)", async () => {
    const { client, store } = install(1_000_000_000, 1_000_000n, true);
    const vb = String(1_000_000 + 20);
    // A signs (goes to nonce map, leaves the reserved queue).
    await client.before(beforeCtx());
    await client.after(afterCtx("0xaaa", vb));
    // B reserves, then B's creation fails pre-sign.
    await client.before(beforeCtx());
    await client.failure({ ...beforeCtx(), error: new Error("signer down") });

    // A must still hold cap (signed); only B released.
    const committed = await store.committedAmount("p1", "__no_mandate__", 1_000_000, 60_000);
    expect(committed).toBe(100_000n); // exactly A, B gone
  });

  it("a missing/never-firing response hook does not let a later failure release a live signed hold", async () => {
    const { client, store } = install(1_000_000_000, 1_000_000n, true);
    const vb = String(1_000_000 + 20);
    await client.before(beforeCtx());
    await client.after(afterCtx("0xaaa", vb)); // A signed, in nonce map (not pending)
    await client.before(beforeCtx()); // B reserved
    await client.failure({ ...beforeCtx(), error: new Error("B failed") }); // releases B, not A
    const committed = await store.committedAmount("p1", "__no_mandate__", 1_000_000, 60_000);
    expect(committed).toBe(100_000n);
  });
});

describe("Finding 2: safeReleaseAt covers the actually-signed validBefore", () => {
  it("rejects a signed validBefore beyond the priced horizon (TOCTOU)", async () => {
    const { client } = install(1_000_000_000);
    const reservedAtS = Math.floor(1_000_000_000 / 1000); // 1_000_000
    const tooFar = String(reservedAtS + 20 + 5); // horizon 20, +5 over the +1 tolerance
    await client.before(beforeCtx());
    await expect(client.after(afterCtx("0xaaa", tooFar))).rejects.toThrow(/diverged/);
  });

  it("extends safeReleaseAt to the signed validBefore so reconcile cannot release early", async () => {
    const { client, store, clock } = install(1_000_000_000);
    const reservedAtS = Math.floor(1_000_000_000 / 1000);
    // Signing latency: signed validBefore is 1s later than the hook-time horizon.
    const signedVb = reservedAtS + 20 + 1; // within the +1 tolerance, but beyond priced safeReleaseAt
    await client.before(beforeCtx());
    await client.after(afterCtx("0xaaa", String(signedVb)));
    // Reservation's safeReleaseAt must now cover signedVb (+margin+skew).
    // Find the reservation via committed (it is signed/pending) then inspect.
    const res = await store.get("r1");
    expect(res?.safeReleaseAt).toBe(signedVb * 1000 + 2_000 + 5_000);
    // reconcile just before that time must NOT release it.
    clock.set(signedVb * 1000 + 2_000 + 5_000 - 1);
    const released = await store.releaseExpired(clock.now());
    expect(released).toBe(0);
  });
});

describe("Finding 3: settled transition requires settledAt (no backdating)", () => {
  it("throws when transitioning to settled without settledAt", async () => {
    const store = new InMemoryAtomicStore();
    const r = await store.tryReserve({
      principalId: "p", mandateId: "m", amount: 1n, payTo: "0x", now: 0,
      windowMs: 1000, cap: 10n, safeReleaseAt: 1_000_000,
    });
    if (!r.ok) throw new Error("reserve failed");
    await store.transition(r.reservationId, "reserved", "signed");
    await expect(store.transition(r.reservationId, "signed", "settled")).rejects.toThrow(/settledAt/);
  });
});

describe("Finding 4: future-dated settle still counts after a backward clock correction", () => {
  it("counts a settle whose settledAt is ahead of the query now", async () => {
    const store = new InMemoryAtomicStore();
    const r = await store.tryReserve({
      principalId: "p", mandateId: "m", amount: 100n, payTo: "0x", now: 0,
      windowMs: 60_000, cap: 1000n, safeReleaseAt: 10_000_000,
    });
    if (!r.ok) throw new Error("reserve failed");
    await store.transition(r.reservationId, "reserved", "signed");
    await store.transition(r.reservationId, "signed", "settled", { settledAt: 100_000 });
    // Clock steps back to 96_000 (< settledAt). The settle must still count.
    const committed = await store.committedAmount("p", "m", 96_000, 60_000);
    expect(committed).toBe(100n);
  });
});

describe("Finding 6: concurrent fungible signing does not free a signed payment's dedup key", () => {
  // Two DISTINCT purchases (distinct payer ids) share one requirements signature
  // and run concurrently. A FIFO pop in after()/onFailure can attribute a
  // pre-sign failure to the WRONG entry. Freeing the popped entry's dedup key
  // could then un-guard a DIFFERENT payment that actually SIGNED. Under
  // contention we must retain keys (fail toward over-block), never free.
  function installPids(pids: string[]) {
    const store = new InMemoryAtomicStore();
    const clock = new ManualClock(1_000_000_000);
    const client = new FakeClient();
    let i = 0;
    installAgentPayGuard(client, {
      policy: testPolicy({ perMandateCap: 1_000_000n }),
      store,
      principalId: "p1",
      clock,
      resolveDedupContext: () => ({ paymentIdentifier: pids[i++] }),
    });
    return { store, client };
  }

  it("retains the SIGNED payment's key when a concurrent sibling fails pre-sign", async () => {
    // Order: before P1(pidA), before P2(pidB) [contended], after P2 signs
    // [pops P1's entry, FIFO], onFailure P1 [pops P2's entry, has pidB].
    // Buggy code freed pidB — but P2 SIGNED, so its key must stay consumed.
    const { store, client } = installPids(["pidA", "pidB", "pidB"]);
    const vb = String(1_000_000 + 20);
    await client.before(beforeCtx()); // P1 -> pidA
    await client.before(beforeCtx()); // P2 -> pidB (contended)
    await client.after(afterCtx("0xbbb", vb)); // a sig signs (pops P1's fungible entry)
    await client.failure({ ...beforeCtx(), error: new Error("P1 signer down") });

    // Exactly one signed hold remains (cap-neutral under fungible mis-attribution).
    const committed = await store.committedAmount("p1", "__no_mandate__", 1_000_000, 60_000);
    expect(committed).toBe(100_000n);

    // pidB must still be consumed: a re-presentation keyed pidB is blocked, i.e.
    // the signed payment's client-side dedup guard was NOT bypassed.
    const rep = await client.before(beforeCtx()); // uses pidB
    expect(rep).toMatchObject({ abort: true });
    expect((rep as { reason: string }).reason).toContain("duplicate");
  });

  it("still frees the key for an uncontended (sequential) pre-sign failure", async () => {
    // No concurrency => the popped entry provably IS the failed payment => free it.
    const { client } = installPids(["pidS", "pidS"]);
    await client.before(beforeCtx()); // reserve pidS
    await client.failure({ ...beforeCtx(), error: new Error("down") });
    const retry = await client.before(beforeCtx()); // pidS again, key was freed
    expect(retry).toBeUndefined();
  });

  it("retains the key even when a TOCTOU-divergent after() drains the queue mid-generation", async () => {
    // Adversarial-review regression: a signature-level contended COUNTER reset when
    // `pending` drained to 0, but a signed sibling's live key remained. A divergent
    // after() that pops the last reserved entry (queue empties) then unshifts it on
    // the TOCTOU throw would recreate a fresh, contended=false generation, letting
    // the following onFailure free the SIGNED purchase's key. The per-entry stamp
    // survives the drain, so the key stays retained.
    const { store, client } = installPids(["p0", "p1", "p1"]);
    const vb = String(1_000_000 + 20);
    await client.before(beforeCtx()); // E0 -> p0
    await client.before(beforeCtx()); // E1 -> p1  (both stamped contended)
    await client.after(afterCtx("0xbbb", vb)); // clean sign pops E0 (FIFO) -> signed
    // Divergent payTo on the last reserved entry: TOCTOU throw pops E1, empties the
    // queue, then unshifts E1 back.
    await expect(client.after(afterCtx("0xaaa", vb, "0xEVIL"))).rejects.toThrow(/diverged/);
    await client.failure({ ...beforeCtx(), error: new Error("aborted after TOCTOU") });

    // One signed hold remains (E0), cap-neutral.
    const committed = await store.committedAmount("p1", "__no_mandate__", 1_000_000, 60_000);
    expect(committed).toBe(100_000n);
    // p1 must still be consumed: the signed purchase's client-side dedup guard was
    // NOT bypassed by the drain-then-unshift.
    const rep = await client.before(beforeCtx()); // uses p1
    expect(rep).toMatchObject({ abort: true });
    expect((rep as { reason: string }).reason).toContain("duplicate");
  });
});

describe("Finding 5: dedup keys are principal-scoped", () => {
  it("two principals buying the same resource do not cross-block", async () => {
    const store = new InMemoryAtomicStore();
    const policy = testPolicy({ profile: "budget-only" });
    const payment = {
      scheme: "exact", network: BASE_SEPOLIA, asset: USDC, payTo: "0xm",
      value: 100_000n, maxTimeoutSeconds: 20, resourceUrl: "https://same",
    } as const;
    const a = await evaluatePayment({ payment, dedup: {}, now: 1000 }, { policy, store, principalId: "A" });
    const b = await evaluatePayment({ payment, dedup: {}, now: 1000 }, { policy, store, principalId: "B" });
    expect(a.decision).toBe("allow");
    expect(b.decision).toBe("allow"); // B not blocked by A's dedup key
  });
});
