import { describe, expect, it } from "vitest";
import {
  IdempotencyGuard,
  InMemoryClaimStore,
  deriveClaimKey,
  extractAuthorization,
  tupleKey,
  type PaymentPayloadLike,
} from "../src/index.js";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function payload(over: {
  nonce?: string;
  paymentIdentifier?: string;
  to?: string;
  value?: string;
}): PaymentPayloadLike {
  return {
    accepted: { asset: USDC, network: "eip155:84532" },
    payload: {
      // payment-identifier is client-supplied correlation metadata only.
      paymentIdentifier: over.paymentIdentifier ?? "pid-a",
      authorization: {
        from: "0x1111111111111111111111111111111111111111",
        to: over.to ?? "0x2222222222222222222222222222222222222222",
        value: over.value ?? "100000",
        validAfter: "0",
        validBefore: "9999999999",
        nonce: over.nonce ?? "0x" + "ab".repeat(32),
      },
      signature: "0xsig",
    },
  };
}

describe("replay key derivation", () => {
  it("keys on (token, from, nonce) — not the payment-identifier", () => {
    const a = extractAuthorization(payload({ paymentIdentifier: "pid-1" }));
    const b = extractAuthorization(payload({ paymentIdentifier: "pid-2" }));
    // Same signed authorization, different client-supplied identifier => same key.
    expect(deriveClaimKey(a.auth, a.token)).toBe(deriveClaimKey(b.auth, b.token));
  });

  it("different nonce => different key", () => {
    const a = extractAuthorization(payload({ nonce: "0x" + "11".repeat(32) }));
    const b = extractAuthorization(payload({ nonce: "0x" + "22".repeat(32) }));
    expect(deriveClaimKey(a.auth, a.token)).not.toBe(deriveClaimKey(b.auth, b.token));
  });

  it("EIP-712 digest key binds all fields when domain is known", () => {
    const a = extractAuthorization(payload({}));
    const domain = { name: "USDC", version: "2", chainId: 84532, verifyingContract: USDC };
    const withDomain = deriveClaimKey(a.auth, a.token, domain);
    expect(withDomain.startsWith("digest:")).toBe(true);
    expect(withDomain).not.toBe(tupleKey(a.token, a.auth));
  });
});

describe("IdempotencyGuard: replay is defended", () => {
  it("a replayed authorization under a fresh payment-identifier replays the cached grant", async () => {
    let t = 0;
    const guard = new IdempotencyGuard({ store: new InMemoryClaimStore(), now: () => t });

    // First presentation: proceed, do work, grant.
    const first = await guard.begin(payload({ paymentIdentifier: "pid-1" }));
    expect(first.kind).toBe("proceed");
    if (first.kind !== "proceed") return;
    const grant = { status: 200, headers: { "PAYMENT-RESPONSE": "ok" }, body: { data: 1 } };
    expect(await guard.complete(first.key, first.claimToken, grant)).toBe(true);

    // Replayer varies ONLY the client-supplied identifier — same signed auth.
    t = 1;
    const replay = await guard.begin(payload({ paymentIdentifier: "pid-2-attacker" }));
    expect(replay.kind).toBe("replay");
    if (replay.kind === "replay") expect(replay.grant).toEqual(grant);
    // => exactly ONE grant, not 248.
  });

  it("concurrent duplicate while claimed (lease valid) is rejected as in_progress", async () => {
    let t = 0;
    const guard = new IdempotencyGuard({ store: new InMemoryClaimStore(), leaseMs: 1000, now: () => t });
    const first = await guard.begin(payload({}));
    expect(first.kind).toBe("proceed");
    t = 500; // within lease, first not yet granted
    const concurrent = await guard.begin(payload({ paymentIdentifier: "other" }));
    expect(concurrent.kind).toBe("in_progress");
  });

  it("crash between claim and grant becomes retryable after lease expiry (no permanent paid_without_service)", async () => {
    let t = 0;
    const guard = new IdempotencyGuard({ store: new InMemoryClaimStore(), leaseMs: 1000, now: () => t });
    const first = await guard.begin(payload({}));
    expect(first.kind).toBe("proceed");
    // Server crashes: never calls complete. Lease expires.
    t = 1500;
    const retry = await guard.begin(payload({}));
    expect(retry.kind).toBe("proceed"); // retryable, not stuck
  });

  it("a stale worker cannot grant over a newer reclaim", async () => {
    let t = 0;
    const store = new InMemoryClaimStore();
    const guard = new IdempotencyGuard({ store, leaseMs: 1000, now: () => t });
    const first = await guard.begin(payload({}));
    expect(first.kind).toBe("proceed");
    if (first.kind !== "proceed") return;
    t = 1500; // lease expired
    const second = await guard.begin(payload({}));
    expect(second.kind).toBe("proceed");
    if (second.kind !== "proceed") return;
    // Original (stale) worker tries to grant with its old token: rejected.
    const staleGrant = { status: 200, headers: {}, body: {} };
    expect(await guard.complete(first.key, first.claimToken, staleGrant)).toBe(false);
    // New worker grants fine.
    expect(await guard.complete(second.key, second.claimToken, staleGrant)).toBe(true);
  });

  it("fail() releases the claim so it is immediately retryable", async () => {
    const guard = new IdempotencyGuard({ store: new InMemoryClaimStore(), now: () => 0 });
    const first = await guard.begin(payload({}));
    if (first.kind !== "proceed") throw new Error("expected proceed");
    await guard.fail(first.key, first.claimToken);
    const retry = await guard.begin(payload({}));
    expect(retry.kind).toBe("proceed");
  });

  it("unkeyable payload (missing authorization) fails closed", async () => {
    const guard = new IdempotencyGuard({ store: new InMemoryClaimStore(), now: () => 0 });
    const res = await guard.begin({ accepted: { asset: USDC }, payload: {} });
    expect(res.kind).toBe("unkeyable");
  });
});
