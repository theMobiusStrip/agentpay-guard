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
