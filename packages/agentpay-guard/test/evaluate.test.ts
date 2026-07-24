import { describe, expect, it } from "vitest";
import { evaluatePayment } from "../src/evaluate.js";
import { InMemoryAtomicStore } from "../src/store/memory.js";
import type { ResolvedPayment, VerifiedMandate } from "../src/types.js";
import { BASE_SEPOLIA, USDC, testPolicy } from "./helpers.js";

function payment(o: Partial<ResolvedPayment> = {}): ResolvedPayment {
  return {
    scheme: "exact",
    network: BASE_SEPOLIA,
    asset: USDC,
    payTo: "0xmerchant",
    value: 100_000n,
    maxTimeoutSeconds: 20,
    resourceUrl: "https://api.example.com/thing",
    ...o,
  };
}

const deps = (store = new InMemoryAtomicStore(), policy = testPolicy()) => ({
  policy,
  store,
  principalId: "p1",
});

describe("evaluate: MVP envelope fails closed", () => {
  it("blocks unknown scheme", async () => {
    const d = await evaluatePayment(
      { payment: payment({ scheme: "upto" }), dedup: {}, now: 1000 },
      deps(),
    );
    expect(d.decision).toBe("block");
    expect(d.reason).toBe("envelope_scheme");
  });

  it("blocks unknown network", async () => {
    const d = await evaluatePayment(
      { payment: payment({ network: "eip155:8453" }), dedup: {}, now: 1000 },
      deps(),
    );
    expect(d.reason).toBe("envelope_network");
  });

  it("blocks unknown asset", async () => {
    const d = await evaluatePayment(
      { payment: payment({ asset: "0xdeadbeef" }), dedup: {}, now: 1000 },
      deps(),
    );
    expect(d.reason).toBe("envelope_asset");
  });

  it("blocks unresolved payTo", async () => {
    const d = await evaluatePayment(
      { payment: payment({ payTo: "" }), dedup: {}, now: 1000 },
      deps(),
    );
    expect(d.reason).toBe("envelope_unresolved_fields");
  });
});

describe("evaluate: per-payment ceiling", () => {
  it.each([
    ["negative bigint", -1n],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["string", "100000"],
  ])("blocks invalid runtime policy value: %s", async (_label, invalid) => {
    const store = new InMemoryAtomicStore();
    const policy = testPolicy({
      maxPaymentAmount: invalid as bigint,
    });
    const d = await evaluatePayment(
      { payment: payment(), dedup: {}, now: 1000 },
      deps(store, policy),
    );
    expect(d).toMatchObject({
      decision: "block",
      reason: "policy_invalid",
      message: "maxPaymentAmount must be a non-negative bigint",
    });
    await expect(
      store.committedAmount("p1", "__no_mandate__", 1000, policy.windowMs),
    ).resolves.toBe(0n);
  });

  it("blocks above the limit before reservation or dedup state changes", async () => {
    const store = new InMemoryAtomicStore();
    const policy = testPolicy({
      maxPaymentAmount: 100_000n,
      perMandateCap: 1_000_000n,
    });
    const over = await evaluatePayment(
      {
        payment: payment({ value: 100_001n }),
        dedup: { paymentIdentifier: "same-purchase" },
        now: 1000,
      },
      deps(store, policy),
    );
    expect(over).toMatchObject({
      decision: "block",
      reason: "payment_amount_exceeds",
      message: "payment amount 100001 exceeds max 100000",
      matchedRule: "per-payment-max",
    });

    const atLimit = await evaluatePayment(
      {
        payment: payment({ value: 100_000n }),
        dedup: { paymentIdentifier: "same-purchase" },
        now: 1001,
      },
      deps(store, policy),
    );
    expect(atLimit.decision).toBe("allow");
    await expect(
      store.committedAmount("p1", "__no_mandate__", 1001, policy.windowMs),
    ).resolves.toBe(100_000n);
  });

  it("allows the exact limit and treats zero as a valid deny-all ceiling", async () => {
    const atLimit = await evaluatePayment(
      { payment: payment({ value: 100_000n }), dedup: {}, now: 1000 },
      deps(
        new InMemoryAtomicStore(),
        testPolicy({ maxPaymentAmount: 100_000n }),
      ),
    );
    expect(atLimit.decision).toBe("allow");

    const positive = await evaluatePayment(
      { payment: payment({ value: 1n }), dedup: {}, now: 1000 },
      deps(
        new InMemoryAtomicStore(),
        testPolicy({ maxPaymentAmount: 0n }),
      ),
    );
    expect(positive.reason).toBe("payment_amount_exceeds");
  });

  it("applies before a looser mandate limit", async () => {
    const mandate: VerifiedMandate = {
      mandateId: "m1",
      issuer: "did:issuer",
      constraints: { maxAmount: 200_000n },
    };
    const d = await evaluatePayment(
      {
        payment: payment({ value: 150_000n }),
        mandate,
        dedup: {},
        now: 1000,
      },
      deps(
        new InMemoryAtomicStore(),
        testPolicy({
          profile: "mandate-required",
          maxPaymentAmount: 100_000n,
        }),
      ),
    );
    expect(d.reason).toBe("payment_amount_exceeds");
  });

  it("keeps a stricter mandate limit effective", async () => {
    const mandate: VerifiedMandate = {
      mandateId: "m1",
      issuer: "did:issuer",
      constraints: { maxAmount: 100_000n },
    };
    const d = await evaluatePayment(
      {
        payment: payment({ value: 100_001n }),
        mandate,
        dedup: {},
        now: 1000,
      },
      deps(
        new InMemoryAtomicStore(),
        testPolicy({
          profile: "mandate-required",
          maxPaymentAmount: 200_000n,
        }),
      ),
    );
    expect(d.reason).toBe("intent_amount_exceeds");
  });
});

describe("evaluate: validBefore clamp", () => {
  it("blocks when requested validity exceeds the ceiling", async () => {
    const policy = testPolicy({ validBeforeCeilingSeconds: 30 });
    const d = await evaluatePayment(
      { payment: payment({ maxTimeoutSeconds: 120 }), dedup: {}, now: 1000 },
      deps(new InMemoryAtomicStore(), policy),
    );
    expect(d.decision).toBe("block");
    expect(d.reason).toBe("valid_before_too_far");
  });
});

describe("evaluate: intent constraint (profiles)", () => {
  const mandate: VerifiedMandate = {
    mandateId: "m1",
    issuer: "did:issuer",
    constraints: { payTo: "0xmerchant", maxAmount: 200_000n, asset: USDC, network: BASE_SEPOLIA },
  };

  it("budget-only ignores mandate (intent check off)", async () => {
    const d = await evaluatePayment(
      { payment: payment({ payTo: "0xattacker" }), dedup: {}, now: 1000 },
      deps(new InMemoryAtomicStore(), testPolicy({ profile: "budget-only" })),
    );
    expect(d.decision).toBe("allow");
  });

  it("mandate-required blocks a missing mandate", async () => {
    const d = await evaluatePayment(
      { payment: payment(), dedup: {}, now: 1000 },
      deps(new InMemoryAtomicStore(), testPolicy({ profile: "mandate-required" })),
    );
    expect(d.reason).toBe("mandate_missing");
  });

  it("mandate-required blocks payTo mismatch (redirected funds)", async () => {
    const d = await evaluatePayment(
      { payment: payment({ payTo: "0xattacker" }), mandate, dedup: {}, now: 1000 },
      deps(new InMemoryAtomicStore(), testPolicy({ profile: "mandate-required" })),
    );
    expect(d.reason).toBe("intent_payto_mismatch");
  });

  it("mandate-required blocks amount over the mandate max", async () => {
    const d = await evaluatePayment(
      { payment: payment({ value: 500_000n }), mandate, dedup: {}, now: 1000 },
      deps(new InMemoryAtomicStore(), testPolicy({ profile: "mandate-required" })),
    );
    expect(d.reason).toBe("intent_amount_exceeds");
  });

  it("mandate-required allows a matching payment", async () => {
    const d = await evaluatePayment(
      { payment: payment(), mandate, dedup: {}, now: 1000 },
      deps(new InMemoryAtomicStore(), testPolicy({ profile: "mandate-required" })),
    );
    expect(d.decision).toBe("allow");
  });

  it("mandate-required blocks an expired mandate", async () => {
    const expired: VerifiedMandate = {
      ...mandate,
      constraints: { ...mandate.constraints, expiry: 1 },
    };
    const d = await evaluatePayment(
      { payment: payment(), mandate: expired, dedup: {}, now: 10_000_000 },
      deps(new InMemoryAtomicStore(), testPolicy({ profile: "mandate-required" })),
    );
    expect(d.reason).toBe("mandate_expired");
  });
});

describe("evaluate: duplicate-authorization guard", () => {
  it("blocks a second authorization for the same payer-set payment-identifier", async () => {
    const store = new InMemoryAtomicStore();
    const first = await evaluatePayment(
      { payment: payment(), dedup: { paymentIdentifier: "pid-123" }, now: 1000 },
      deps(store),
    );
    expect(first.decision).toBe("allow");
    const second = await evaluatePayment(
      { payment: payment(), dedup: { paymentIdentifier: "pid-123" }, now: 1001 },
      deps(store),
    );
    expect(second.decision).toBe("block");
    expect(second.reason).toBe("duplicate_authorization");
  });

  it("does not double-charge the cap when a duplicate is released", async () => {
    const store = new InMemoryAtomicStore();
    // Cap large enough that the duplicate's reservation succeeds first, so the
    // dedup guard (not the cap) is what blocks it — isolating release-on-dup.
    const policy = testPolicy({ perMandateCap: 1_000_000n });
    await evaluatePayment(
      { payment: payment({ value: 100_000n }), dedup: { paymentIdentifier: "pid-x" }, now: 1000 },
      deps(store, policy),
    );
    // Same purchase again: reserve succeeds, then dedup rejects and releases it.
    const dup = await evaluatePayment(
      { payment: payment({ value: 100_000n }), dedup: { paymentIdentifier: "pid-x" }, now: 1001 },
      deps(store, policy),
    );
    expect(dup.reason).toBe("duplicate_authorization");
    const committed = await store.committedAmount("p1", "__no_mandate__", 1001, policy.windowMs);
    expect(committed).toBe(100_000n); // exactly one charge, not two
  });

  it("falls back to mandate+resource intent when no payment-identifier is set", async () => {
    const store = new InMemoryAtomicStore();
    const mandate: VerifiedMandate = { mandateId: "mm", issuer: "i", constraints: {} };
    const first = await evaluatePayment(
      { payment: payment(), mandate, dedup: {}, now: 1000 },
      deps(store, testPolicy({ profile: "budget-only" })),
    );
    expect(first.decision).toBe("allow");
    // Merchant jitters value by 1 unit: fallback key is intent-derived, so still a dup.
    const jittered = await evaluatePayment(
      { payment: payment({ value: 100_001n }), mandate, dedup: {}, now: 1001 },
      deps(store, testPolicy({ profile: "budget-only" })),
    );
    expect(jittered.reason).toBe("duplicate_authorization");
  });

  it("does NOT collapse distinct purchases when there is no payer id, mandate, or resource", async () => {
    // Regression: the degenerate fallback key was asset-only (constant), so it
    // latched the principal to a single payment and false-blocked every later
    // DISTINCT purchase. With no distinguishing material we now skip client-side
    // dedup entirely (cap is the backstop) instead of over-blocking.
    const store = new InMemoryAtomicStore();
    const policy = testPolicy({ profile: "budget-only", perMandateCap: 10_000_000n });
    const bare = (o: Partial<ResolvedPayment> = {}): ResolvedPayment => ({
      scheme: "exact",
      network: BASE_SEPOLIA,
      asset: USDC,
      payTo: "0xmerchant",
      value: 100_000n,
      maxTimeoutSeconds: 20,
      ...o, // no resourceUrl
    });
    const a = await evaluatePayment({ payment: bare(), dedup: {}, now: 1000 }, deps(store, policy));
    const b = await evaluatePayment({ payment: bare({ payTo: "0xother" }), dedup: {}, now: 1001 }, deps(store, policy));
    const c = await evaluatePayment({ payment: bare(), dedup: {}, now: 1002 }, deps(store, policy));
    expect(a.decision).toBe("allow");
    expect(b.decision).toBe("allow"); // distinct payee, not a false duplicate
    expect(c.decision).toBe("allow"); // repeat of `a` also allowed (dedup skipped)
    // No dedup key surfaced when skipped.
    expect(a.dedupKey).toBeUndefined();
  });

  it("still dedups on a resource url alone (intended anti-jitter tradeoff)", async () => {
    // With a resource url present (but no payer id/mandate), same-(resource,asset)
    // purchases ARE treated as duplicates on purpose. Documented in SECURITY.md;
    // wire a paymentIdentifier/intentId to distinguish distinct same-url buys.
    const store = new InMemoryAtomicStore();
    const policy = testPolicy({ profile: "budget-only", perMandateCap: 10_000_000n });
    const first = await evaluatePayment(
      { payment: payment({ resourceUrl: "https://api/x" }), dedup: {}, now: 1000 },
      deps(store, policy),
    );
    expect(first.decision).toBe("allow");
    const repeat = await evaluatePayment(
      { payment: payment({ resourceUrl: "https://api/x", value: 100_001n }), dedup: {}, now: 1001 },
      deps(store, policy),
    );
    expect(repeat.reason).toBe("duplicate_authorization");
  });
});

describe("evaluate: budget cap", () => {
  it("blocks when the per-mandate cap would be exceeded", async () => {
    const store = new InMemoryAtomicStore();
    const policy = testPolicy({ perMandateCap: 150_000n });
    await evaluatePayment({ payment: payment({ value: 100_000n }), dedup: { paymentIdentifier: "a" }, now: 1000 }, deps(store, policy));
    const over = await evaluatePayment({ payment: payment({ value: 100_000n }), dedup: { paymentIdentifier: "b" }, now: 1000 }, deps(store, policy));
    expect(over.reason).toBe("cap_exceeded");
  });
});
