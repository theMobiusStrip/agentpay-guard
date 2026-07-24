import { describe, expect, it } from "vitest";
import { installAgentPayGuard } from "../src/guard.js";
import { InMemoryAtomicStore } from "../src/store/memory.js";
import { evaluatePayment } from "../src/evaluate.js";
import type { AtomicStore } from "../src/store/types.js";
import type { ResolvedPayment, VerifiedMandate } from "../src/types.js";
import type {
  PaymentCreationContextLike,
  X402PaymentRequirementsLike,
} from "../src/x402-types.js";
import { BASE_SEPOLIA, USDC, testPolicy } from "./helpers.js";

function payment(o: Partial<ResolvedPayment> = {}): ResolvedPayment {
  return {
    scheme: "exact",
    network: BASE_SEPOLIA,
    asset: USDC,
    payTo: "0xattacker",
    value: 100_000n,
    maxTimeoutSeconds: 20,
    resourceUrl: "https://evil.example/x",
    ...o,
  };
}

/**
 * G2 — circularity gate (§4.6): a matched-but-malicious intent whose "intent" is
 * only agent-derived must fail CLOSED, not verify attacker-vs-attacker. Trust
 * comes exclusively from the mandateVerifier (provenance). An agent-derived
 * intent that never passes the verifier yields no trusted mandate.
 */
describe("G2: intent-binding circularity fails closed", () => {
  it("mandate-required with no trusted mandate blocks even a self-consistent agent intent", async () => {
    // The attacker crafts a payment AND a matching "intent", but there is no
    // provenance-verified mandate (verifier returns undefined). Must block.
    const d = await evaluatePayment(
      { payment: payment(), mandate: undefined, dedup: { intentId: "agent-says-ok" }, now: 1000 },
      { policy: testPolicy({ profile: "mandate-required" }), store: new InMemoryAtomicStore(), principalId: "p1" },
    );
    expect(d.decision).toBe("block");
    expect(d.reason).toBe("mandate_missing");
  });

  it("a mandate that itself points at the attacker is only as good as its (verified) issuer — matching still requires provenance upstream", async () => {
    // If a verifier were fooled into returning an attacker-authored mandate, the
    // check would pass — which is why provenance (issuer/signature) is the trust
    // anchor, NOT field-matching. Here we show that WITHOUT the payTo constraint
    // the mandate does not silently authorize an arbitrary payee: a constrained
    // mandate to the real merchant blocks the attacker payTo.
    const honestMandate: VerifiedMandate = {
      mandateId: "m1",
      issuer: "did:trusted",
      constraints: { payTo: "0xrealmerchant", maxAmount: 200_000n },
    };
    const d = await evaluatePayment(
      { payment: payment({ payTo: "0xattacker" }), mandate: honestMandate, dedup: {}, now: 1000 },
      { policy: testPolicy({ profile: "mandate-required" }), store: new InMemoryAtomicStore(), principalId: "p1" },
    );
    expect(d.reason).toBe("intent_payto_mismatch");
  });
});

/**
 * G3 — envelope gate (§2, §5): malformed/adversarial inputs, store-unavailable,
 * and escalate each conformance-test to `block`.
 */
describe("G3: envelope + adversarial inputs fail closed", () => {
  function req(o: Partial<X402PaymentRequirementsLike> = {}): X402PaymentRequirementsLike {
    return {
      scheme: "exact",
      network: BASE_SEPOLIA,
      asset: USDC,
      amount: "100000",
      payTo: "0x2222222222222222222222222222222222222222",
      maxTimeoutSeconds: 20,
      ...o,
    };
  }
  function ctx(r: X402PaymentRequirementsLike): PaymentCreationContextLike {
    return {
      paymentRequired: { x402Version: 2, resource: { url: "https://x" }, accepts: [r] },
      selectedRequirements: r,
    };
  }
  function install(store: AtomicStore = new InMemoryAtomicStore()) {
    const client: {
      before?: (c: PaymentCreationContextLike) => Promise<void | { abort: true; reason: string }>;
      onBeforePaymentCreation(h: never): unknown;
      onAfterPaymentCreation(h: never): unknown;
      onPaymentCreationFailure(h: never): unknown;
    } = {
      onBeforePaymentCreation(h: never) { (this as { before?: unknown }).before = h; return this; },
      onAfterPaymentCreation() { return this; },
      onPaymentCreationFailure() { return this; },
    };
    installAgentPayGuard(client, {
      policy: testPolicy(),
      store,
      principalId: "p1",
    });
    return client;
  }

  it("malformed amount (non-numeric) fails closed", async () => {
    const c = install();
    const res = await c.before(ctx(req({ amount: "0x1e240; DROP TABLE" })));
    expect(res).toMatchObject({ abort: true });
  });

  it("negative/garbage payTo fails closed", async () => {
    const c = install();
    const res = await c.before(ctx(req({ payTo: "   " })));
    expect(res).toMatchObject({ abort: true });
    expect((res as { reason: string }).reason).toContain("unresolved");
  });

  it("oversized validity horizon is clamped (fails closed)", async () => {
    const c = install();
    const res = await c.before(ctx(req({ maxTimeoutSeconds: 99999 })));
    expect(res).toMatchObject({ abort: true });
    expect((res as { reason: string }).reason).toContain("valid_before_too_far");
  });

  // Fail-OPEN regression: a NaN/non-finite/negative maxTimeoutSeconds must NOT
  // slip the clamp. NaN forgives `>` so a bare upper-bound check let it through,
  // then NaN poisoned safeReleaseAt (immortal hold), dedupTtl, and the post-sign
  // validBefore bound. Each must fail closed AND leave no cap hold behind.
  for (const [label, bad] of [
    ["NaN", NaN],
    ["+Infinity", Infinity],
    ["negative", -1],
  ] as const) {
    it(`${label} validity horizon fails closed with no immortal hold`, async () => {
      const store = new InMemoryAtomicStore();
      const c = install(store);
      const res = await c.before(ctx(req({ maxTimeoutSeconds: bad })));
      expect(res).toMatchObject({ abort: true });
      expect((res as { reason: string }).reason).toContain("valid_before_too_far");
      // Blocked before tryReserve => no reservation, so nothing can become an
      // immortal (never-expiring) cap hold.
      const committed = await store.committedAmount("p1", "__no_mandate__", 1_000_000, 60_000);
      expect(committed).toBe(0n);
    });
  }

  it("store-unavailable (tryReserve throws) fails closed via the catch-all", async () => {
    const brokenStore: AtomicStore = {
      tryReserve: async () => { throw new Error("store down"); },
      transition: async () => false,
      putIfAbsent: async () => true,
      removeDedup: async () => {},
      releaseExpired: async () => 0,
      recoverAfterRestart: async () => ({ markedUnknown: 0, expired: 0 }),
      get: async () => undefined,
      committedAmount: async () => 0n,
    };
    const c = install(brokenStore);
    const res = await c.before(ctx(req()));
    expect(res).toMatchObject({ abort: true });
    expect((res as { reason: string }).reason).toContain("internal error");
  });

  it("unknown scheme fails closed", async () => {
    const c = install();
    const res = await c.before(ctx(req({ scheme: "definitely-not-exact" })));
    expect(res).toMatchObject({ abort: true });
    expect((res as { reason: string }).reason).toContain("envelope_scheme");
  });
});
