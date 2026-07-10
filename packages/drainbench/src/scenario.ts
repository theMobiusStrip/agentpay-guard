/** DrainBench scenario + result types. */
import type { PolicyProfile } from "agentpay-guard";

export const BASE_SEPOLIA = "eip155:84532";
export const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
/** Legit merchant and an attacker payee (deterministic addresses). */
export const MERCHANT = "0x1111111111111111111111111111111111111111";
export const ATTACKER = "0x2222222222222222222222222222222222222222";

export type FixtureKind =
  | "single" // one payment attempt
  | "concurrent" // N concurrent attempts (retry storm)
  | "sequence" // N sequential attempts (cumulative / salami)
  | "replay" // one signed auth re-presented N times (server-side)
  | "squat"; // reservation squatting (denial-of-wallet)

/** A deterministic, scripted adversarial or benign scenario. */
export interface Fixture {
  id: string;
  klass: string; // attack class (taxonomy)
  description: string;
  kind: FixtureKind;
  benign: boolean;
  /** The 402 the merchant serves (possibly adversarial). */
  requirement: {
    payTo: string;
    amount: string; // atomic units
    maxTimeoutSeconds: number;
    asset?: string;
    network?: string;
    resourceUrl?: string;
  };
  /** Trusted, provenance-verified mandate constraints (absent = agent-derived). */
  mandate?: {
    payTo?: string;
    maxAmount?: string;
    asset?: string;
    network?: string;
    resourceUrl?: string;
  };
  /** Machine-readable ground truth for the oracle (frozen with the fixture). */
  truth: {
    authorizedPayTo: string[];
    maxAuthorizedAmount: string; // atomic units
    expectedResource: string;
  };
  /** N for concurrent / sequence / replay / squat. */
  count?: number;
  /** For sequence/salami: distinct mandateId per attempt to exercise aggregate cap. */
  distinctMandates?: boolean;
  /** Merchant withholds service after settlement (preemption/paid-without-service). */
  withholdService?: boolean;
  /** Per-fixture arm config overrides (cap/window/limits). */
  cfg?: {
    cap?: string;
    windowMs?: number;
    aggregateCap?: string;
    perPayeeReservationLimit?: number;
  };
  /** Profiles this fixture is meaningful under (default: both). */
  profiles?: PolicyProfile[];
}

export type ArmName = "native" | "native+guard";

/** Four harm/utility metrics (§4) computed from the ledger + delivery log. */
export interface Metrics {
  unauthorizedPayerOutflow: bigint; // funds to unauthorized payee or over the authorized cap
  paidWithoutService: bigint; // settled but service not delivered
  unpaidServiceCost: bigint; // delivered but not settled (replay: extra grants)
  benignFalseBlock: number; // 1 if a benign fixture was blocked, else 0
  blocked: number; // attempts blocked
  settledCount: number; // attempts settled
  grants: number; // service deliveries (>1 per settlement = replay harm)
  hookLatencyMsP50: number;
  hookLatencyMsP99: number;
}

export interface ResultRow {
  fixtureId: string;
  klass: string;
  arm: ArmName;
  profile: PolicyProfile | "n/a";
  metrics: Metrics;
  /** Conformance verdict for deterministic fixtures (N=1). */
  pass: boolean;
  note: string;
}
