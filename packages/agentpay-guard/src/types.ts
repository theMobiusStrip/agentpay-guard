/**
 * Core domain types for agentpay-guard.
 *
 * The MVP envelope (see §2 of the plan) is narrow on purpose: everything outside
 * it fails closed. These types describe the policy config, the decision output,
 * and the resolved payment fields the guard reasons over.
 */

/** CAIP-2 network id, e.g. "eip155:84532" (Base Sepolia). */
export type Caip2Network = `${string}:${string}`;

/**
 * The two pre-registered policy profiles (§2).
 *
 * - `budget-only`  — deployable today with zero mandate infrastructure: budget
 *   cap + duplicate-auth guard active, intent check OFF (not fail-closed-on-absent).
 * - `mandate-required` — full envelope: missing/invalid mandate => block.
 */
export type PolicyProfile = "budget-only" | "mandate-required";

/** Terminal + non-terminal reservation states (§5 state machine). */
export type ReservationStatus =
  | "reserved" // budget held atomically, not yet signed
  | "signed" // authorization signed; payload may have left the process
  | "submitted" // handed to facilitator / broadcast
  | "settled" // TERMINAL: confirmed spend, attributed at settlement time
  | "unknown" // signed but outcome unobserved; holds cap until safeReleaseAt
  | "expired" // TERMINAL: past validBefore(+margin+skew), can never settle
  | "released"; // TERMINAL: pre-sign abort/failure, budget returned immediately

/** Statuses that occupy budget against the cap regardless of window age. */
export const PENDING_STATUSES: readonly ReservationStatus[] = [
  "reserved",
  "signed",
  "submitted",
  "unknown",
];

/** Terminal statuses (no further transitions permitted). */
export const TERMINAL_STATUSES: readonly ReservationStatus[] = [
  "settled",
  "expired",
  "released",
];

/**
 * Declarative policy config. Insufficient by itself — the stateful controls also
 * require `store` + `clock` + `principalId` supplied to installAgentPayGuard.
 */
export interface Policy {
  profile: PolicyProfile;

  /** Rolling window length in milliseconds for cumulative settled spend. */
  windowMs: number;

  /** Per-mandate cumulative cap, atomic token units (e.g. USDC 6-decimals). */
  perMandateCap: bigint;

  /**
   * Optional principal-level aggregate cap across ALL mandates. This is what
   * actually catches salami/cumulative drain spread across mandates — a
   * per-mandate cap alone misses it (§2 control #1).
   */
  principalAggregateCap?: bigint;

  /** MVP envelope allowlist. Anything not listed fails closed. */
  envelope: MvpEnvelope;

  /**
   * `validBefore` ceiling in seconds: reject any authorization whose validBefore
   * exceeds reserve-time + this ceiling (also bounded by windowMs). This is the
   * client-owned half of the preemption defense AND closes the window-slide
   * double-spend (§5). A merchant-suggested timeout must not flow into a signed
   * authorization unchecked.
   */
  validBeforeCeilingSeconds: number;

  /**
   * Reorg / confirmation margin in ms folded into expiry: an authorization is
   * only provably dead at validBefore + this margin (+ clock skew).
   */
  reorgMarginMs: number;

  /** Max the local clock may run AHEAD of true/chain time, in ms (§5 skew). */
  maxClockSkewMs: number;

  /**
   * Optional payee allowlist (checked in addition to the mandate). Empty/omitted
   * means "no static allowlist" (the mandate is the source of truth).
   */
  allowedPayees?: readonly string[];

  /** Per-payee concurrent reservation limit — denial-of-wallet mitigation (§3). */
  perPayeeReservationLimit?: number;
}

/** The one vertical slice we actually enforce; everything else blocks (§2). */
export interface MvpEnvelope {
  schemes: readonly string[]; // e.g. ["exact"]
  networks: readonly Caip2Network[]; // e.g. ["eip155:84532"]
  assets: readonly string[]; // token contract addresses, lowercased
}

/** Resolved, about-to-be-signed payment fields the guard reasons over. */
export interface ResolvedPayment {
  scheme: string;
  network: Caip2Network;
  asset: string; // token contract, lowercased
  payTo: string; // EIP-3009 `to`, lowercased
  value: bigint; // EIP-3009 `value`, atomic units
  /**
   * Server-requested validity horizon, seconds (requirements.maxTimeoutSeconds).
   * Available at the hook pre-signing; the SDK derives the signed `validBefore`
   * (~now + maxTimeoutSeconds) from it, so we clamp on this at the hook and
   * re-confirm the actual `validBefore` in onAfterPaymentCreation.
   */
  maxTimeoutSeconds?: number;
  /** Signed EIP-3009 validBefore (unix seconds); only present post-signing. */
  validBefore?: number;
  validAfter?: number;
  /** Server-declared resource URL (from paymentRequired.resource.url), if any. */
  resourceUrl?: string;
}

/** Trusted, signed mandate/offer (provenance verified by mandateVerifier). */
export interface VerifiedMandate {
  mandateId: string;
  issuer: string;
  /** Canonical fields the mandate authorizes. Absent fields are unconstrained. */
  constraints: {
    payTo?: string;
    maxAmount?: bigint;
    asset?: string;
    network?: Caip2Network;
    resourceUrl?: string;
    /** Expiry, unix seconds. */
    expiry?: number;
  };
}

export type Decision = "allow" | "block" | "escalate";

/** Stable reason codes so metrics/tests can assert on machine-readable causes. */
export type ReasonCode =
  | "ok"
  | "envelope_scheme"
  | "envelope_network"
  | "envelope_asset"
  | "envelope_unresolved_fields"
  | "store_unavailable"
  | "cap_exceeded"
  | "aggregate_cap_exceeded"
  | "per_payee_limit"
  | "valid_before_too_far"
  | "valid_before_missing"
  | "mandate_missing"
  | "mandate_invalid"
  | "mandate_expired"
  | "intent_payto_mismatch"
  | "intent_amount_exceeds"
  | "intent_asset_mismatch"
  | "intent_network_mismatch"
  | "duplicate_authorization"
  | "payee_not_allowed"
  | "escalated"
  | "internal_error";

export interface GuardDecision {
  decision: Decision;
  reason: ReasonCode;
  /** Human-readable detail for the abort `reason` string passed to the SDK. */
  message: string;
  matchedRule?: string;
  /** Present when a reservation was created (decision === "allow"). */
  reservationId?: string;
  /**
   * The dedup key consumed for this decision. Surfaced so the guard can
   * un-consume it if the payment fails before signing (retry correctness).
   */
  dedupKey?: string;
}
