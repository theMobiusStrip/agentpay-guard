/**
 * Arm A — the pinned baseline, published here for reproducibility so a reviewer
 * can adjudicate "is this what the docs do?".
 *
 * IMPORTANT sourcing note (fairness): the x402 docs do NOT ship a cumulative
 * spending-limit example. `@x402/core` documents `onBeforePaymentCreation` only
 * as an abort STUB:
 *
 *   // from @x402/core README — the only documented shape:
 *   client.onBeforePaymentCreation(async (ctx) => {
 *     // inspect ctx.selectedRequirements … return { abort: true, reason } to cancel
 *   });
 *
 * So the cumulative counter below is DrainBench's honest MODEL of a real
 * spending-limit built on that hook — not a verbatim doc snippet. The benchmark
 * runs it in two modes and reports BOTH (see the atomicity-conditionality table
 * in the report):
 *
 *  - SYNC  (single-process, in-memory): check+increment with no await between.
 *    Under JS run-to-completion this does NOT overspend — but it cannot back a
 *    multi-worker deployment (the §2 precondition).
 *  - ASYNC (shared store: Redis GET/SET, DB read-then-write, no transaction):
 *    a store round-trip sits between read and write, so concurrent payments each
 *    observe headroom before any commits → overspend. This is the realistic
 *    multi-worker baseline, and the TOCTOU agentpay-guard's atomic
 *    reserve-before-sign fixes.
 *
 * The live arm used by the runner is `buildArmA` in
 * `packages/drainbench/src/arms.ts`; this file is the readable, self-contained
 * reference for the same logic. Same nominal cap + window as arm B.
 */

export interface NativeLimitConfig {
  cap: bigint;
  windowMs: number;
  mode: "sync" | "async";
  now: () => number;
}

/** Returns a hook body equivalent to the arm-A baseline. */
export function nativeSpendingLimitHook(cfg: NativeLimitConfig) {
  const window: { ts: number; amount: bigint }[] = [];
  const wouldExceed = (amount: bigint, now: number): boolean => {
    const current = window
      .filter((w) => w.ts > now - cfg.windowMs)
      .reduce((a, w) => a + w.amount, 0n);
    return current + amount > cfg.cap;
  };
  return async function onBeforePaymentCreation(ctx: {
    selectedRequirements: { amount: string };
  }): Promise<void | { abort: true; reason: string }> {
    const amount = BigInt(ctx.selectedRequirements.amount);
    const now = cfg.now();
    if (cfg.mode === "async") {
      const over = wouldExceed(amount, now);
      await Promise.resolve(); // store round-trip — concurrent calls interleave here
      if (over) return { abort: true, reason: "native spending limit exceeded" };
      window.push({ ts: now, amount });
      return;
    }
    if (wouldExceed(amount, now)) return { abort: true, reason: "native spending limit exceeded" };
    window.push({ ts: now, amount });
    return;
  };
}
