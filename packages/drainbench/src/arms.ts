/**
 * The two benchmark arms, sharing the same x402 client, signer, and mock merchant
 * so the measured delta is atomicity / provenance / statefulness — not a looser
 * limit or a different chain.
 *
 * Arm A pins the VERBATIM documented spending-limit pattern: a cumulative counter
 * that aborts over a cap, read-then-write and NON-atomic. Arm B installs
 * agentpay-guard with the same nominal cap + window.
 */
import { x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import {
  installAgentPayGuard,
  InMemoryAtomicStore,
  systemClock,
  type AgentPayGuard,
  type Policy,
  type VerifiedMandate,
} from "agentpay-guard";
import { BASE_SEPOLIA, USDC } from "./scenario.js";

// Fixed, well-known test key (NOT a secret) so the payer address is reproducible.
const PAYER_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

export interface ArmConfig {
  cap: bigint;
  windowMs: number;
  aggregateCap?: bigint;
  perPayeeReservationLimit?: number;
}

export function payerAddress(): string {
  return privateKeyToAccount(PAYER_KEY).address.toLowerCase();
}

function makeBaseClient() {
  const account = privateKeyToAccount(PAYER_KEY);
  const client = new x402Client();
  client.register(BASE_SEPOLIA, new ExactEvmScheme(account));
  return { client, account };
}

/**
 * Arm A — a native cumulative spending-limit hook (the baseline). The x402 docs
 * ship only an abort STUB for `onBeforePaymentCreation` (no cumulative-counter
 * example), so this counter is the benchmark's honest MODEL of a real
 * spending-limit, not a verbatim doc snippet.
 *
 * Two modes, both with the same nominal cap + window as arm B:
 * - `"async"` (default): a counter backed by an **async store** (Redis GET/SET,
 *   a DB read-then-write) — read-then-write with a round-trip between them, and
 *   NO transaction. This is the realistic baseline for the multi-worker
 *   deployment the §2 precondition requires. Concurrent payments each observe
 *   headroom before any commits → overspend (the TOCTOU the guard's atomic
 *   reserve-before-sign fixes).
 * - `"sync"`: a purely in-memory synchronous counter (check+increment with no
 *   await between). Under JS single-threaded run-to-completion this does NOT
 *   overspend — but it is single-process-only and cannot back multi-worker.
 *
 * Reporting BOTH is the honest framing: the atomicity delta is **conditional on a
 * shared/async store**; a single-process sync counter ties the guard.
 */
export type ArmAMode = "async" | "sync";

export function buildArmA(cfg: ArmConfig, mode: ArmAMode = "async") {
  const { client } = makeBaseClient();
  const window: { ts: number; amount: bigint }[] = [];
  const check = (amount: bigint, now: number) => {
    const current = window
      .filter((w) => w.ts > now - cfg.windowMs)
      .reduce((a, w) => a + w.amount, 0n);
    return current + amount > cfg.cap;
  };
  client.onBeforePaymentCreation(async (ctx) => {
    const amount = BigInt(ctx.selectedRequirements.amount);
    const now = systemClock.now();
    if (mode === "async") {
      // Read current windowed spend, then an async store round-trip, then decide.
      const over = check(amount, now);
      await Promise.resolve(); // store round-trip — where concurrent calls interleave
      if (over) return { abort: true, reason: "native spending limit exceeded" };
      window.push({ ts: now, amount });
      return;
    }
    // sync: check+increment with no interleaving point.
    if (check(amount, now)) return { abort: true, reason: "native spending limit exceeded" };
    window.push({ ts: now, amount });
    return;
  });
  return { client, guard: undefined as AgentPayGuard | undefined };
}

/**
 * Arm B — native surface + agentpay-guard (atomic reserve-before-sign).
 */
export function buildArmB(
  cfg: ArmConfig,
  profile: Policy["profile"],
  mandateFor: (ctx: unknown) => VerifiedMandate | undefined,
) {
  const { client } = makeBaseClient();
  const policy: Policy = {
    profile,
    windowMs: cfg.windowMs,
    perMandateCap: cfg.cap,
    envelope: { schemes: ["exact"], networks: [BASE_SEPOLIA], assets: [USDC] },
    validBeforeCeilingSeconds: 300,
    reorgMarginMs: 2_000,
    maxClockSkewMs: 5_000,
    ...(cfg.aggregateCap !== undefined ? { principalAggregateCap: cfg.aggregateCap } : {}),
    ...(cfg.perPayeeReservationLimit !== undefined
      ? { perPayeeReservationLimit: cfg.perPayeeReservationLimit }
      : {}),
  };
  const guard = installAgentPayGuard(client, {
    policy,
    store: new InMemoryAtomicStore(),
    principalId: "bench-payer",
    clock: systemClock,
    mandateVerifier: (ctx) => mandateFor(ctx),
    // Model distinct logical purchases so the dedup guard does not collapse a
    // burst of intentionally-distinct payments into one.
    resolveDedupContext: () => ({ paymentIdentifier: `pid-${dedupSeq++}` }),
  });
  return { client, guard };
}

let dedupSeq = 0;
export function resetDedupSeq() {
  dedupSeq = 0;
}
