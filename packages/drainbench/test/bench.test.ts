import { describe, expect, it } from "vitest";
import { runFixture } from "../src/runner.js";
import { adversarialFixtures, benignFixtures } from "../src/fixtures.js";
import { reorgScenario } from "../src/simlane.js";
import type { ArmConfig } from "../src/arms.js";

const DEFAULT: ArmConfig = { cap: 1_000_000n, windowMs: 60_000 };

function cfgFor(id: string): ArmConfig {
  const f = adversarialFixtures.find((x) => x.id === id)!;
  const c: ArmConfig = {
    cap: f.cfg?.cap !== undefined ? BigInt(f.cfg.cap) : DEFAULT.cap,
    windowMs: DEFAULT.windowMs,
  };
  if (f.cfg?.perPayeeReservationLimit !== undefined) c.perPayeeReservationLimit = f.cfg.perPayeeReservationLimit;
  return c;
}
const fx = (id: string) => adversarialFixtures.find((x) => x.id === id)!;

describe("DrainBench deltas (deterministic, reproducible)", () => {
  it("retry-storm: native overspends the cap, the guard holds it", async () => {
    const cfg = cfgFor("retry-storm");
    const native = await runFixture(fx("retry-storm"), "native", "budget-only", cfg);
    const guard = await runFixture(fx("retry-storm"), "native+guard", "budget-only", cfg);
    expect(native.metrics.unauthorizedPayerOutflow).toBeGreaterThan(0n); // overspends
    expect(guard.metrics.unauthorizedPayerOutflow).toBe(0n); // atomic: never over cap
    expect(guard.metrics.settledCount).toBeLessThanOrEqual(10);
  });

  it("payTo-tamper: only mandate-required blocks the redirect", async () => {
    const cfg = cfgFor("payto-tamper");
    const budget = await runFixture(fx("payto-tamper"), "native+guard", "budget-only", cfg);
    const mandate = await runFixture(fx("payto-tamper"), "native+guard", "mandate-required", cfg);
    expect(budget.metrics.unauthorizedPayerOutflow).toBeGreaterThan(0n); // documented gap
    expect(mandate.metrics.unauthorizedPayerOutflow).toBe(0n); // intent check blocks
  });

  it("bait-and-switch: mandate-required blocks the over-quote", async () => {
    const cfg = cfgFor("bait-and-switch");
    const mandate = await runFixture(fx("bait-and-switch"), "native+guard", "mandate-required", cfg);
    expect(mandate.metrics.unauthorizedPayerOutflow).toBe(0n);
  });

  it("protocol-replay: middleware collapses many grants to one", async () => {
    const cfg = cfgFor("protocol-replay");
    const native = await runFixture(fx("protocol-replay"), "native", "budget-only", cfg);
    const guard = await runFixture(fx("protocol-replay"), "native+guard", "budget-only", cfg);
    expect(native.metrics.grants).toBe(5);
    expect(native.metrics.unpaidServiceCost).toBeGreaterThan(0n);
    expect(guard.metrics.grants).toBe(1);
    expect(guard.metrics.unpaidServiceCost).toBe(0n);
  });

  it("reservation-squat: per-payee limit bounds the squat", async () => {
    const cfg = cfgFor("reservation-squat");
    const native = await runFixture(fx("reservation-squat"), "native", "budget-only", cfg);
    const guard = await runFixture(fx("reservation-squat"), "native+guard", "budget-only", cfg);
    expect(native.metrics.settledCount).toBe(20); // unbounded
    expect(guard.metrics.settledCount).toBe(3); // bounded to the per-payee limit
  });

  it("over-cap-single: both arms block (sanity)", async () => {
    const cfg = cfgFor("over-cap-single");
    const native = await runFixture(fx("over-cap-single"), "native", "budget-only", cfg);
    const guard = await runFixture(fx("over-cap-single"), "native+guard", "mandate-required", cfg);
    expect(native.metrics.settledCount).toBe(0);
    expect(guard.metrics.settledCount).toBe(0);
  });

  it("benign corpus: zero false blocks (conformance gate)", async () => {
    const benign = benignFixtures();
    expect(benign.length).toBeGreaterThanOrEqual(30);
    for (const f of benign) {
      for (const profile of ["budget-only", "mandate-required"] as const) {
        const r = await runFixture(f, "native+guard", profile, DEFAULT);
        expect(r.metrics.benignFalseBlock, `${f.id} (${profile}) false-blocked`).toBe(0);
      }
    }
  });

  it("determinism: repeated runs of retry-storm match", async () => {
    const cfg = cfgFor("retry-storm");
    const a = await runFixture(fx("retry-storm"), "native", "budget-only", cfg);
    const b = await runFixture(fx("retry-storm"), "native", "budget-only", cfg);
    expect(a.metrics.settledCount).toBe(b.metrics.settledCount);
    expect(a.metrics.unauthorizedPayerOutflow).toBe(b.metrics.unauthorizedPayerOutflow);
  });

  it("simulated-chain reorg: confirmation-depth gating eliminates unpaid service", () => {
    const rows = reorgScenario();
    const naive = rows.find((r) => r.defense.includes("naive"))!;
    const gated = rows.find((r) => r.defense.includes("confirmation-depth"))!;
    expect(naive.unpaidServiceCost).toBeGreaterThan(0n);
    expect(gated.unpaidServiceCost).toBe(0n);
  });

  it("fairness: a SYNC single-process arm-A counter ties the guard (no overspend delta)", async () => {
    const cfg = cfgFor("retry-storm");
    const sync = await runFixture(fx("retry-storm"), "native", "budget-only", cfg, "sync");
    const asyncA = await runFixture(fx("retry-storm"), "native", "budget-only", cfg, "async");
    const guard = await runFixture(fx("retry-storm"), "native+guard", "budget-only", cfg);
    // Sync counter does NOT overspend (JS run-to-completion) — ties the guard.
    expect(sync.metrics.settledCount).toBe(10);
    expect(guard.metrics.settledCount).toBe(10);
    // The delta appears only against an async/shared store.
    expect(asyncA.metrics.settledCount).toBeGreaterThan(10);
  });
});

describe("pinned arm-A baseline module (bench/arm-a/native-hook.ts)", () => {
  it("sync mode holds the cap; async mode overspends under a concurrent burst", async () => {
    const { nativeSpendingLimitHook } = await import("../../../bench/arm-a/native-hook.ts");
    const mk = (mode: "sync" | "async") =>
      nativeSpendingLimitHook({ cap: 100n, windowMs: 60_000, mode, now: () => 1000 });
    const burst = async (mode: "sync" | "async") => {
      const hook = mk(mode);
      const ctx = { selectedRequirements: { amount: "10" } };
      const results = await Promise.all(Array.from({ length: 20 }, () => hook(ctx)));
      return results.filter((r) => !r).length; // allowed (void) count
    };
    expect(await burst("sync")).toBe(10); // exactly cap/amount
    expect(await burst("async")).toBeGreaterThan(10); // overspends
  });
});
