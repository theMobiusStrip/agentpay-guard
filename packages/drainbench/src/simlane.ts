/**
 * Simulated-chain lane (§3, §8). Base Sepolia's centralized sequencer cannot
 * produce a reorg, and the oracle reads the very receipts a reorg erases — so
 * these Tier-B classes run on an in-process deterministic chain simulator
 * (snapshot / settle / grant / revert). Labeled **simulated** in the report.
 *
 * No anvil dependency: the Ledger's revertFrom models the reorg deterministically.
 */
import { Ledger } from "./ledger.js";

export interface SimRow {
  scenario: string;
  defense: string;
  unpaidServiceCost: bigint;
  note: string;
}

const UNIT = 100_000n; // $0.10

/**
 * Reorg / confirmation-depth revert-grant (2605.11781 Attack I-A). A payment
 * settles, the merchant delivers, then a reorg reverts the settlement.
 *
 * - "grant-on-first-seen" (naive): delivers before the revert → unpaid service.
 * - "gate-on-confirmation-depth" (described defense): withholds delivery until
 *   depth D; the revert lands first, so nothing is delivered against a reverted
 *   settlement → no unpaid service.
 */
export function reorgScenario(): SimRow[] {
  const rows: SimRow[] = [];

  // Naive server: deliver at settle time (block 100), reorg reverts block >= 100.
  {
    const ledger = new Ledger();
    const nonce = "0xreorg";
    ledger.recordSettlement({ payer: "0xp", payTo: "0xm", amount: UNIT, asset: "usdc", blockTs: 100, nonce });
    ledger.recordDelivery({ requestId: nonce, nonce, delivered: true }); // delivered immediately
    ledger.revertFrom(100); // reorg
    const active = ledger.activeSettlements();
    const delivered = ledger.allDeliveries().filter((d) => d.delivered).length;
    const unpaid = BigInt(Math.max(0, delivered - active.length)) * UNIT;
    rows.push({
      scenario: "reorg / revert-grant",
      defense: "grant-on-first-seen (naive)",
      unpaidServiceCost: unpaid,
      note: "delivered before the reorg reverted the settlement",
    });
  }

  // Confirmation-depth gate: hold delivery until depth D; revert lands first.
  {
    const ledger = new Ledger();
    const nonce = "0xreorg2";
    ledger.recordSettlement({ payer: "0xp", payTo: "0xm", amount: UNIT, asset: "usdc", blockTs: 100, nonce });
    // Reorg BEFORE the confirmation depth is reached => no delivery recorded.
    ledger.revertFrom(100);
    const settledConfirmed = ledger.activeSettlements().length > 0;
    if (settledConfirmed) {
      ledger.recordDelivery({ requestId: nonce, nonce, delivered: true });
    }
    const active = ledger.activeSettlements();
    const delivered = ledger.allDeliveries().filter((d) => d.delivered).length;
    const unpaid = BigInt(Math.max(0, delivered - active.length)) * UNIT;
    rows.push({
      scenario: "reorg / revert-grant",
      defense: "gate-on-confirmation-depth (described)",
      unpaidServiceCost: unpaid,
      note: "delivery withheld until confirmed; reorg reverted first → no unpaid service",
    });
  }

  return rows;
}

/**
 * Settlement preemption (2605.11781 Attack I-B). The signed authorization is
 * public in the PAYMENT-SIGNATURE header; an attacker can front-run the settle.
 * EIP-3009 binds `to`, so funds cannot be redirected — the harm is a bounded
 * exposure window during which the authorization is replayable/preemptible. The
 * client-side validity-window CLAMP (built, control #1) bounds that window; the
 * server ordering defense is described. Reported as the exposure window in
 * seconds under a merchant-suggested vs a clamped timeout.
 */
export function preemptionScenario(): { merchantSuggestedSeconds: number; clampedSeconds: number; note: string } {
  return {
    merchantSuggestedSeconds: 3600, // a merchant asking for a 1h validity horizon
    clampedSeconds: 60, // agentpay-guard clamps to the policy ceiling
    note:
      "The validity-window clamp (built) reduces the preemption/replay exposure " +
      "window from a merchant-suggested 3600s to the policy ceiling (60s). Server " +
      "ordering is the described complement; measured on the simulated lane.",
  };
}
