import { describe, expect, it } from "vitest";
import { installAgentPayGuard, AgentPayGuard } from "../src/guard.js";
import { ManualClock } from "../src/clock.js";
import { InMemoryAtomicStore } from "../src/store/memory.js";
import type { AuditEvent } from "../src/audit.js";
import type { InstallOptions } from "../src/guard.js";
import type { AtomicStore } from "../src/store/types.js";
import type {
  PaymentCreatedContextLike,
  PaymentCreationContextLike,
  X402ClientLike,
  X402PaymentRequirementsLike,
} from "../src/x402-types.js";
import { BASE_SEPOLIA, USDC, testPolicy } from "./helpers.js";

/** Captures the hooks the guard registers so a test can drive them. */
class FakeClient implements X402ClientLike {
  before?: (ctx: PaymentCreationContextLike) => Promise<void | { abort: true; reason: string }>;
  after?: (ctx: PaymentCreatedContextLike) => Promise<void>;
  failure?: (ctx: any) => Promise<any>;
  response?: (ctx: any) => Promise<any>;
  onBeforePaymentCreation(h: any) { this.before = h; return this; }
  onAfterPaymentCreation(h: any) { this.after = h; return this; }
  onPaymentCreationFailure(h: any) { this.failure = h; return this; }
  onPaymentResponse(h: any) { this.response = h; return this; }
}

function requirements(o: Partial<X402PaymentRequirementsLike> = {}): X402PaymentRequirementsLike {
  return {
    scheme: "exact",
    network: BASE_SEPOLIA,
    asset: USDC,
    amount: "100000",
    payTo: "0xMerchant",
    maxTimeoutSeconds: 20,
    ...o,
  };
}

function ctx(req = requirements()): PaymentCreationContextLike {
  return {
    paymentRequired: {
      x402Version: 2,
      resource: { url: "https://api.example.com/thing" },
      accepts: [req],
    },
    selectedRequirements: req,
  };
}

function install(over: Partial<InstallOptions> = {}) {
  const store = new InMemoryAtomicStore();
  const clock = new ManualClock(1_000_000);
  const events: AuditEvent[] = [];
  const client = new FakeClient();
  const guard = installAgentPayGuard(client, {
    policy: testPolicy(),
    store,
    principalId: "p1",
    clock,
    onAudit: (e) => events.push(e),
    ...over,
  });
  return { store, clock, events, client, guard };
}

function wrapStore(
  store: AtomicStore,
  transition: AtomicStore["transition"],
  removeDedup: AtomicStore["removeDedup"] = (key) =>
    store.removeDedup(key),
): AtomicStore {
  return {
    tryReserve: (request) => store.tryReserve(request),
    transition,
    putIfAbsent: (key, ttlMs, now) =>
      store.putIfAbsent(key, ttlMs, now),
    removeDedup,
    releaseExpired: (now, requestedWindowMs) =>
      store.releaseExpired(now, requestedWindowMs),
    recoverAfterRestart: (now, requestedWindowMs) =>
      store.recoverAfterRestart(now, requestedWindowMs),
    get: (id) => store.get(id),
    committedAmount: (principalId, mandateId, now, windowMs) =>
      store.committedAmount(principalId, mandateId, now, windowMs),
  };
}

describe("guard: hook wiring + fail-closed", () => {
  it("allows an in-envelope payment (returns void)", async () => {
    const { client } = install();
    const res = await client.before(ctx());
    expect(res).toBeUndefined();
  });

  it("aborts an out-of-envelope payment with a reason", async () => {
    const { client } = install();
    const res = await client.before(ctx(requirements({ scheme: "upto" })));
    expect(res).toEqual({ abort: true, reason: expect.stringContaining("envelope_scheme") });
  });

  it("aborts above the standalone per-payment ceiling", async () => {
    const { client, store } = install({
      policy: testPolicy({ maxPaymentAmount: 99_999n }),
    });
    const res = await client.before(ctx());
    expect(res).toEqual({
      abort: true,
      reason: expect.stringContaining("payment_amount_exceeds"),
    });
    await expect(
      store.committedAmount("p1", "__no_mandate__", 1_000_000, 60_000),
    ).resolves.toBe(0n);
  });

  it("fail-CLOSED: a throwing mandateVerifier aborts (never falls through to allow)", async () => {
    const { client } = install({
      policy: testPolicy({ profile: "mandate-required" }),
      mandateVerifier: () => {
        throw new Error("verifier boom");
      },
    });
    const res = await client.before(ctx());
    expect(res).toMatchObject({ abort: true });
    expect((res as { reason: string }).reason).toContain("internal error");
  });

  it("reservation created on allow is visible in the store", async () => {
    const { client, store } = install();
    await client.before(ctx());
    const committed = await store.committedAmount("p1", "__no_mandate__", 1_000_000, 60_000);
    expect(committed).toBe(100_000n);
  });
});

describe("guard: TOCTOU (onAfterPaymentCreation)", () => {
  function createdCtx(signedTo: string, signedValue: string): PaymentCreatedContextLike {
    return {
      ...ctx(),
      paymentPayload: {
        x402Version: 2,
        payload: {
          authorization: { to: signedTo, value: signedValue, validBefore: "0" },
        },
      },
    };
  }

  it("matching signed payload transitions reserved -> signed", async () => {
    const { client, events } = install();
    await client.before(ctx());
    await client.after(createdCtx("0xmerchant", "100000"));
    expect(events.some((e) => e.kind === "signed")).toBe(true);
  });

  it("persists signed authorization reference without payload/signature", async () => {
    const { client, events, store } = install();
    const nonce = `0x${"ab".repeat(32)}`;
    await client.before(ctx());
    await client.after({
      ...ctx(),
      paymentPayload: {
        x402Version: 2,
        payload: {
          authorization: {
            from: "0xPayer",
            to: "0xmerchant",
            value: "100000",
            validBefore: "1021",
            nonce,
          },
          signature: "must-not-enter-store",
        },
      },
    });
    const reservationId = events.find(
      (event) => event.kind === "signed",
    )?.reservationId;
    if (reservationId === undefined) {
      throw new Error("signed reservation missing");
    }
    expect((await store.get(reservationId))?.authorization).toEqual({
      network: BASE_SEPOLIA,
      asset: USDC,
      from: "0xpayer",
      nonce,
      validBefore: 1021,
    });
  });

  it("diverged signed payTo throws to abort the payment", async () => {
    const { client, events } = install();
    await client.before(ctx());
    await expect(client.after(createdCtx("0xattacker", "100000"))).rejects.toThrow(/diverged/);
    expect(events.some((e) => e.kind === "toctou_mismatch")).toBe(true);
  });

  it("diverged signed value throws to abort the payment", async () => {
    const { client } = install();
    await client.before(ctx());
    await expect(client.after(createdCtx("0xmerchant", "999999"))).rejects.toThrow();
  });
});

describe("guard: lifecycle transitions", () => {
  it("pre-sign failure releases the reservation and un-consumes the dedup key", async () => {
    const { client, store, events } = install({
      resolveDedupContext: () => ({ paymentIdentifier: "pid-1" }),
    });
    await client.before(ctx());
    await client.failure({ ...ctx(), error: new Error("network down") });
    expect(events.some((e) => e.kind === "released")).toBe(true);
    // Cap freed:
    const committed = await store.committedAmount("p1", "__no_mandate__", 1_000_000, 60_000);
    expect(committed).toBe(0n);
    // Retry with the same payment-identifier is NOT falsely blocked as duplicate:
    const retry = await client.before(ctx());
    expect(retry).toBeUndefined();
  });

  it("pre-sign release CAS failure latches new payments closed", async () => {
    const backing = new InMemoryAtomicStore();
    const broken = wrapStore(
      backing,
      async (id, from, to, opts) =>
        to === "released"
          ? false
          : backing.transition(id, from, to, opts),
    );
    const { client, guard } = install({
      store: broken,
      resolveDedupContext: () => ({ paymentIdentifier: "pid-cas" }),
    });
    await client.before(ctx());
    await expect(
      client.failure({ ...ctx(), error: new Error("signer down") }),
    ).rejects.toThrow(/lifecycle failure/);
    expect(guard.isHealthy()).toBe(false);
    await expect(client.before(ctx())).resolves.toMatchObject({
      abort: true,
      reason: expect.stringContaining("unhealthy"),
    });
  });

  it("pre-sign release store throw latches new payments closed", async () => {
    const backing = new InMemoryAtomicStore();
    const broken = wrapStore(
      backing,
      async (id, from, to, opts) => {
        if (to === "released") throw new Error("database unavailable");
        return backing.transition(id, from, to, opts);
      },
    );
    const { client, guard } = install({ store: broken });
    await client.before(ctx());
    await expect(
      client.failure({ ...ctx(), error: new Error("signer down") }),
    ).rejects.toThrow(/lifecycle failure/);
    expect(guard.isHealthy()).toBe(false);
  });

  it("pre-sign dedup removal throw latches new payments closed", async () => {
    const backing = new InMemoryAtomicStore();
    const broken = wrapStore(
      backing,
      (id, from, to, opts) =>
        backing.transition(id, from, to, opts),
      async () => {
        throw new Error("dedup database unavailable");
      },
    );
    const { client, guard } = install({
      store: broken,
      resolveDedupContext: () => ({ paymentIdentifier: "pid-remove" }),
    });
    await client.before(ctx());
    await expect(
      client.failure({ ...ctx(), error: new Error("signer down") }),
    ).rejects.toThrow(/lifecycle failure/);
    expect(guard.isHealthy()).toBe(false);
  });

  it("duplicate reservation release failure latches new payments closed", async () => {
    const backing = new InMemoryAtomicStore();
    const broken = wrapStore(
      backing,
      async (id, from, to, opts) =>
        to === "released"
          ? false
          : backing.transition(id, from, to, opts),
    );
    const { client, guard } = install({
      store: broken,
      resolveDedupContext: () => ({ paymentIdentifier: "pid-duplicate" }),
    });
    await client.before(ctx());
    await expect(client.before(ctx())).resolves.toMatchObject({
      abort: true,
      reason: expect.stringContaining("internal error"),
    });
    expect(guard.isHealthy()).toBe(false);
  });

  it("successful settle transitions to settled and keeps counting in-window", async () => {
    const { client, store, events } = install();
    const nonce = "0x" + "cd".repeat(32);
    await client.before(ctx());
    await client.after({
      ...ctx(),
      paymentPayload: { x402Version: 2, payload: { authorization: { to: "0xmerchant", value: "100000", validBefore: "0", nonce } } },
    });
    await client.response({
      paymentPayload: { x402Version: 2, payload: { authorization: { to: "0xmerchant", value: "100000", nonce } } },
      requirements: requirements(),
      settleResponse: { success: true, transaction: "0xabc" },
    });
    // The reservation actually reached `settled` (not just `signed`).
    expect(events.some((e) => e.kind === "settled")).toBe(true);
    const committed = await store.committedAmount("p1", "__no_mandate__", 1_000_000, 60_000);
    expect(committed).toBe(100_000n);
  });

  it("signed-state CAS failure throws and latches fail-closed", async () => {
    const backing = new InMemoryAtomicStore();
    const broken = wrapStore(
      backing,
      async (id, from, to, opts) =>
        to === "signed"
          ? false
          : backing.transition(id, from, to, opts),
    );
    const { client, guard } = install({ store: broken });
    await client.before(ctx());
    await expect(
      client.after({
        ...ctx(),
        paymentPayload: {
          x402Version: 2,
          payload: {
            authorization: {
              to: "0xmerchant",
              value: "100000",
              validBefore: "0",
            },
          },
        },
      }),
    ).rejects.toThrow(/lifecycle failure/);
    expect(guard.isHealthy()).toBe(false);
    await expect(client.before(ctx())).resolves.toMatchObject({
      abort: true,
      reason: expect.stringContaining("unhealthy"),
    });
  });

  it("post-response store error latches new payments closed", async () => {
    const backing = new InMemoryAtomicStore();
    const broken = wrapStore(
      backing,
      async (id, from, to, opts) => {
        if (to === "settled") throw new Error("database unavailable");
        return backing.transition(id, from, to, opts);
      },
    );
    const { client, guard } = install({ store: broken });
    const nonce = `0x${"ef".repeat(32)}`;
    await client.before(ctx());
    await client.after({
      ...ctx(),
      paymentPayload: {
        x402Version: 2,
        payload: {
          authorization: {
            from: "0xpayer",
            to: "0xmerchant",
            value: "100000",
            validBefore: "0",
            nonce,
          },
        },
      },
    });
    await expect(
      client.response({
        paymentPayload: {
          x402Version: 2,
          payload: { authorization: { nonce } },
        },
        requirements: requirements(),
        settleResponse: { success: true },
      }),
    ).rejects.toThrow(/lifecycle failure/);
    expect(guard.isHealthy()).toBe(false);
    await expect(client.before(ctx())).resolves.toMatchObject({
      abort: true,
    });
  });
});

describe("guard: escalate (G3)", () => {
  it("defaults to block (fail-closed) with no handler", async () => {
    const { client } = install({ escalationPolicy: () => true });
    const res = await client.before(ctx());
    expect(res).toMatchObject({ abort: true });
    expect((res as { reason: string }).reason).toContain("escalated");
  });

  it("onEscalate returning allow keeps the reservation", async () => {
    const { client, store } = install({
      escalationPolicy: () => true,
      onEscalate: () => "allow",
    });
    const res = await client.before(ctx());
    expect(res).toBeUndefined();
    const committed = await store.committedAmount("p1", "__no_mandate__", 1_000_000, 60_000);
    expect(committed).toBe(100_000n);
  });

  it("escalate + block releases the reservation (no cap held)", async () => {
    const { client, store } = install({ escalationPolicy: () => true, onEscalate: () => "block" });
    await client.before(ctx());
    const committed = await store.committedAmount("p1", "__no_mandate__", 1_000_000, 60_000);
    expect(committed).toBe(0n);
  });

  it("escalation release CAS failure latches new payments closed", async () => {
    const backing = new InMemoryAtomicStore();
    const broken = wrapStore(
      backing,
      async (id, from, to, opts) =>
        to === "released"
          ? false
          : backing.transition(id, from, to, opts),
    );
    const { client, guard } = install({
      store: broken,
      escalationPolicy: () => true,
      onEscalate: () => "block",
    });
    await expect(client.before(ctx())).resolves.toMatchObject({
      abort: true,
      reason: expect.stringContaining("internal error"),
    });
    expect(guard.isHealthy()).toBe(false);
  });

  it("escalate + block un-consumes the dedup key so a re-attempt is not falsely blocked", async () => {
    // Regression: the escalation-deny path released the reservation but left the
    // dedup key consumed, so a legitimate re-attempt of the same payment was
    // wrongly blocked as `duplicate_authorization` instead of re-escalating.
    const { client, store } = install({
      escalationPolicy: () => true,
      onEscalate: () => "block",
      resolveDedupContext: () => ({ paymentIdentifier: "pid-esc" }),
    });
    const first = await client.before(ctx());
    expect((first as { reason: string }).reason).toContain("escalated");
    const retry = await client.before(ctx());
    // Reaches escalation again (key was freed) rather than short-circuiting on dedup.
    expect((retry as { reason: string }).reason).toContain("escalated");
    expect((retry as { reason: string }).reason).not.toContain("duplicate");
    const committed = await store.committedAmount("p1", "__no_mandate__", 1_000_000, 60_000);
    expect(committed).toBe(0n);
  });
});

describe("guard: exports", () => {
  it("installAgentPayGuard returns an AgentPayGuard handle", () => {
    const { guard } = install();
    expect(guard).toBeInstanceOf(AgentPayGuard);
    expect(typeof guard.reconcile).toBe("function");
    expect(guard.isHealthy()).toBe(true);
  });
});
