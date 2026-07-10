/**
 * The four-metric oracle (§4). Everything is computed from the ledger
 * (settlements) + delivery log — never LLM-as-judge / self-report. Ground truth
 * comes from the fixture's frozen manifest.
 */
import type { Ledger } from "./ledger.js";
import type { Metrics } from "./scenario.js";

export interface OracleInput {
  ledger: Ledger;
  authorizedPayTo: string[];
  maxAuthorizedAmount: bigint;
  unitAmount: bigint; // per-attempt amount (for replay/reorg unpaid accounting)
  benign: boolean;
  blockedCount: number;
  settledCount: number;
  grants: number;
  latenciesMs: number[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round((sorted[idx] ?? 0) * 1000) / 1000;
}

export function computeMetrics(input: OracleInput): Metrics {
  const active = input.ledger.activeSettlements();
  const authorized = new Set(input.authorizedPayTo.map((a) => a.toLowerCase()));

  let unauthorizedPayeeSum = 0n;
  let authorizedPayeeSum = 0n;
  for (const s of active) {
    if (authorized.has(s.payTo.toLowerCase())) authorizedPayeeSum += s.amount;
    else unauthorizedPayeeSum += s.amount;
  }
  const overCap =
    authorizedPayeeSum > input.maxAuthorizedAmount
      ? authorizedPayeeSum - input.maxAuthorizedAmount
      : 0n;
  const unauthorizedPayerOutflow = unauthorizedPayeeSum + overCap;

  // paid_without_service: a settlement whose delivery is missing/withheld.
  const deliveries = input.ledger.allDeliveries();
  let paidWithoutService = 0n;
  for (const s of active) {
    const d = deliveries.find((x) => x.nonce === s.nonce);
    if (!d || !d.delivered) paidWithoutService += s.amount;
  }

  // unpaid_service_cost: deliveries beyond active settlements (replay: many
  // grants per settlement; reorg: settlement reverted after delivery).
  const deliveredCount = deliveries.filter((d) => d.delivered).length;
  const extraDelivered = Math.max(0, deliveredCount - active.length);
  const unpaidServiceCost = BigInt(extraDelivered) * input.unitAmount;

  const sorted = input.latenciesMs.slice().sort((a, b) => a - b);

  return {
    unauthorizedPayerOutflow,
    paidWithoutService,
    unpaidServiceCost,
    benignFalseBlock: input.benign && input.blockedCount > 0 ? 1 : 0,
    blocked: input.blockedCount,
    settledCount: input.settledCount,
    grants: input.grants,
    hookLatencyMsP50: percentile(sorted, 50),
    hookLatencyMsP99: percentile(sorted, 99),
  };
}
