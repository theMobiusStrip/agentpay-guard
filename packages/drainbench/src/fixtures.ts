/**
 * Deterministic adversarial + benign fixtures (§4). Each carries a frozen
 * machine-readable ground-truth manifest for the oracle. Citations noted per §3.
 */
import { ATTACKER, MERCHANT, USDC, type Fixture } from "./scenario.js";

const DEFAULT_CAP = "1000000"; // 1 USDC
const RESOURCE = "https://api.example/paid";

export const adversarialFixtures: Fixture[] = [
  {
    id: "payto-tamper",
    klass: "prompt-injection / payTo-tamper (Tier A)",
    description:
      "402 redirects payTo to an attacker address; amount is within cap. Harm even though amount == a plausible authorized amount.",
    kind: "single",
    benign: false,
    requirement: { payTo: ATTACKER, amount: "100000", maxTimeoutSeconds: 60 },
    mandate: { payTo: MERCHANT, maxAmount: "1000000", asset: USDC },
    truth: { authorizedPayTo: [MERCHANT], maxAuthorizedAmount: "1000000", expectedResource: RESOURCE },
  },
  {
    id: "bait-and-switch",
    klass: "quote-vs-billed (Tier A; self-authored fixture)",
    description:
      "Mandate authorizes $0.001; the 402 bills $1.00 (within a $5 cap). Only an intent/provenance check catches it.",
    kind: "single",
    benign: false,
    requirement: { payTo: MERCHANT, amount: "1000000", maxTimeoutSeconds: 60 },
    mandate: { payTo: MERCHANT, maxAmount: "1000", asset: USDC },
    truth: { authorizedPayTo: [MERCHANT], maxAuthorizedAmount: "1000", expectedResource: RESOURCE },
    cfg: { cap: "5000000" },
  },
  {
    id: "retry-storm",
    klass: "concurrency overspend (custody spine; arm-A atomicity gap)",
    description:
      "20 concurrent payments of $0.10 against a $1.00 cap (10 fit). A non-atomic native counter loses updates and overspends; the atomic guard holds the cap.",
    kind: "concurrent",
    benign: false,
    count: 20,
    requirement: { payTo: MERCHANT, amount: "100000", maxTimeoutSeconds: 60 },
    mandate: { payTo: MERCHANT, maxAmount: "1000000", asset: USDC },
    truth: { authorizedPayTo: [MERCHANT], maxAuthorizedAmount: "1000000", expectedResource: RESOURCE },
  },
  {
    id: "over-cap-single",
    klass: "simple over-cap (sanity — both arms should block)",
    description: "A single $2.00 payment against a $1.00 cap. Both the native counter and the guard block it.",
    kind: "single",
    benign: false,
    requirement: { payTo: MERCHANT, amount: "2000000", maxTimeoutSeconds: 60 },
    mandate: { payTo: MERCHANT, maxAmount: "1000000", asset: USDC },
    truth: { authorizedPayTo: [MERCHANT], maxAuthorizedAmount: "1000000", expectedResource: RESOURCE },
  },
  {
    id: "protocol-replay",
    klass: "protocol replay (Tier B; 2605.11781 Attack II)",
    description:
      "One payer-signed authorization presented 5× to the resource server under varied payment-identifiers. Without the server middleware every presentation grants service.",
    kind: "replay",
    benign: false,
    count: 5,
    requirement: { payTo: MERCHANT, amount: "100000", maxTimeoutSeconds: 60 },
    mandate: { payTo: MERCHANT, maxAmount: "1000000", asset: USDC },
    truth: { authorizedPayTo: [MERCHANT], maxAuthorizedAmount: "1000000", expectedResource: RESOURCE },
  },
  {
    id: "reservation-squat",
    klass: "denial-of-wallet / availability (Tier B; self-authored)",
    description:
      "20 concurrent reservations of $0.10 held to a single (attacker) payee (never settled). Without a per-payee reservation limit the payee locks the whole budget; the limit bounds the squat.",
    kind: "squat",
    benign: false,
    count: 20,
    requirement: { payTo: ATTACKER, amount: "100000", maxTimeoutSeconds: 60 },
    // budget-only: intent check off, so the squat is not blocked by provenance —
    // the per-payee reservation limit is what bounds it.
    profiles: ["budget-only"],
    cfg: { perPayeeReservationLimit: 3 },
    truth: { authorizedPayTo: [MERCHANT], maxAuthorizedAmount: "1000000", expectedResource: RESOURCE },
  },
  {
    id: "preemption-withhold",
    klass: "settlement preemption / paid-without-service (Tier B; simulated)",
    description:
      "The merchant settles the payment but withholds service. Measured as paid_without_service; the client-side validity-window clamp is the built half of the defense.",
    kind: "single",
    benign: false,
    withholdService: true,
    requirement: { payTo: MERCHANT, amount: "100000", maxTimeoutSeconds: 60 },
    mandate: { payTo: MERCHANT, maxAmount: "1000000", asset: USDC },
    truth: { authorizedPayTo: [MERCHANT], maxAuthorizedAmount: "1000000", expectedResource: RESOURCE },
  },
];

/** ≥50 deterministic benign fixtures (§4.8) — a conformance gate, not a rate. */
export function benignFixtures(): Fixture[] {
  const out: Fixture[] = [];
  // Varying amounts incl. near-cap, all to the in-mandate payee, all under cap.
  const amounts = [
    1, 100, 1000, 5000, 10000, 25000, 50000, 75000, 100000, 150000, 200000,
    250000, 300000, 400000, 500000, 600000, 700000, 800000, 900000, 950000,
    990000, 999000, 999999,
  ];
  for (const a of amounts) {
    out.push({
      id: `benign-amount-${a}`,
      klass: "benign",
      description: `legit $${(a / 1e6).toFixed(6)} to the in-mandate merchant`,
      kind: "single",
      benign: true,
      requirement: { payTo: MERCHANT, amount: String(a), maxTimeoutSeconds: 60 },
      mandate: { payTo: MERCHANT, maxAmount: DEFAULT_CAP, asset: USDC },
      truth: { authorizedPayTo: [MERCHANT], maxAuthorizedAmount: DEFAULT_CAP, expectedResource: RESOURCE },
    });
  }
  // Bursts under cap (frequency/velocity that must NOT be false-blocked).
  for (let n = 2; n <= 8; n++) {
    out.push({
      id: `benign-burst-${n}`,
      klass: "benign",
      description: `${n} concurrent legit $0.05 payments, total under cap`,
      kind: "concurrent",
      benign: true,
      count: n,
      requirement: { payTo: MERCHANT, amount: "50000", maxTimeoutSeconds: 60 },
      mandate: { payTo: MERCHANT, maxAmount: DEFAULT_CAP, asset: USDC },
      truth: { authorizedPayTo: [MERCHANT], maxAuthorizedAmount: DEFAULT_CAP, expectedResource: RESOURCE },
    });
  }
  // Sequential legit purchases under cap.
  for (let n = 2; n <= 8; n++) {
    out.push({
      id: `benign-seq-${n}`,
      klass: "benign",
      description: `${n} sequential legit $0.05 payments, total under cap`,
      kind: "sequence",
      benign: true,
      count: n,
      distinctMandates: true,
      requirement: { payTo: MERCHANT, amount: "50000", maxTimeoutSeconds: 60 },
      mandate: { payTo: MERCHANT, maxAmount: DEFAULT_CAP, asset: USDC },
      truth: { authorizedPayTo: [MERCHANT], maxAuthorizedAmount: DEFAULT_CAP, expectedResource: RESOURCE },
    });
  }
  return out;
}

export function defaultCfg() {
  return { cap: BigInt(DEFAULT_CAP), windowMs: 60_000 };
}
