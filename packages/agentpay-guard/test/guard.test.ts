import { describe, expect, it } from "vitest";
import { installAgentPayGuard, AgentPayGuard } from "../src/guard.js";
import { ManualClock } from "../src/clock.js";
import { InMemoryAtomicStore } from "../src/store/memory.js";
import type { AuditEvent } from "../src/audit.js";
import type { InstallOptions } from "../src/guard.js";
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
  });
});
