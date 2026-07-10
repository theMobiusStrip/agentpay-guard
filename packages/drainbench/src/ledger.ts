/**
 * Deterministic in-memory settlement ledger — stands in for on-chain receipts +
 * server delivery logs so the whole A/B runs offline. Supports snapshot/revert
 * for the simulated-chain lane (reorg/preemption).
 */
export interface Settlement {
  id: string;
  payer: string;
  payTo: string;
  amount: bigint;
  asset: string;
  /** simulated block timestamp (ms). */
  blockTs: number;
  /** authorization identity (EIP-3009 nonce) — for replay accounting. */
  nonce: string;
  reverted?: boolean;
}

export interface Delivery {
  requestId: string;
  nonce: string;
  delivered: boolean;
}

export class Ledger {
  private readonly settlements: Settlement[] = [];
  private readonly deliveries: Delivery[] = [];
  private seq = 0;

  recordSettlement(s: Omit<Settlement, "id">): string {
    const id = `stl-${++this.seq}`;
    this.settlements.push({ ...s, id });
    return id;
  }

  recordDelivery(d: Delivery): void {
    this.deliveries.push(d);
  }

  /** Simulated reorg: mark settlements at/after a block timestamp reverted. */
  revertFrom(blockTs: number): number {
    let n = 0;
    for (const s of this.settlements) {
      if (!s.reverted && s.blockTs >= blockTs) {
        s.reverted = true;
        n++;
      }
    }
    return n;
  }

  activeSettlements(): Settlement[] {
    return this.settlements.filter((s) => !s.reverted);
  }

  allSettlements(): Settlement[] {
    return this.settlements.slice();
  }

  allDeliveries(): Delivery[] {
    return this.deliveries.slice();
  }
}
