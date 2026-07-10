import { safeReleaseAtMs } from "./clock.js";
import { checkEnvelope, checkResolvedFields } from "./policy/envelope.js";
import { checkIntent } from "./policy/intent.js";
import { deriveDedupKey, type DedupContext } from "./policy/dedup.js";
import type { AtomicStore } from "./store/types.js";
import type {
  GuardDecision,
  Policy,
  ResolvedPayment,
  VerifiedMandate,
} from "./types.js";

export interface EvaluateDeps {
  policy: Policy;
  store: AtomicStore;
  principalId: string;
}

export interface EvaluateInput {
  payment: ResolvedPayment;
  mandate?: VerifiedMandate | undefined;
  dedup: DedupContext;
  /** local-clock ms. */
  now: number;
}

function block(
  reason: GuardDecision["reason"],
  message: string,
  matchedRule?: string,
): GuardDecision {
  return matchedRule === undefined
    ? { decision: "block", reason, message }
    : { decision: "block", reason, message, matchedRule };
}

/**
 * The full fail-closed decision flow. Order matters: cheap envelope checks first,
 * then the validity clamp, then intent, then the atomic reserve, then dedup.
 *
 * Reserve-BEFORE-dedup with release-on-duplicate: we only consume a dedup key
 * once a reservation actually succeeded, and a losing duplicate releases its
 * reservation so the cap is never double-charged.
 */
export async function evaluatePayment(
  input: EvaluateInput,
  deps: EvaluateDeps,
): Promise<GuardDecision> {
  const { payment, mandate, dedup, now } = input;
  const { policy, store, principalId } = deps;

  const envelopeFail = checkEnvelope(payment, policy);
  if (envelopeFail) {
    return block(envelopeFail, `outside MVP envelope: ${envelopeFail}`, "envelope");
  }

  const fieldsFail = checkResolvedFields(payment);
  if (fieldsFail) {
    return block(fieldsFail, "resolved payment fields unavailable at hook", "resolved-fields");
  }

  // validBefore / horizon clamp (§5). At the hook the signed validBefore does not
  // exist yet; we clamp on the server-requested horizon (maxTimeoutSeconds) which
  // the SDK turns into validBefore, and re-confirm the signed value post-signing.
  const windowSeconds = Math.floor(policy.windowMs / 1000);
  const horizonCeiling = Math.min(policy.validBeforeCeilingSeconds, windowSeconds);
  const horizonSeconds = payment.maxTimeoutSeconds ?? policy.validBeforeCeilingSeconds;
  if (payment.maxTimeoutSeconds !== undefined && payment.maxTimeoutSeconds > horizonCeiling) {
    return block(
      "valid_before_too_far",
      `requested validity ${payment.maxTimeoutSeconds}s exceeds ceiling ${horizonCeiling}s`,
      "validbefore-clamp",
    );
  }

  // Static payee allowlist (in addition to the mandate).
  if (
    policy.allowedPayees &&
    policy.allowedPayees.length > 0 &&
    !policy.allowedPayees.map((p) => p.toLowerCase()).includes(payment.payTo.toLowerCase())
  ) {
    return block("payee_not_allowed", `payee ${payment.payTo} not in allowlist`, "payee-allowlist");
  }

  const nowSeconds = Math.floor(now / 1000);
  const intentFail = checkIntent(payment, mandate, policy, nowSeconds);
  if (intentFail) {
    return block(intentFail, `intent constraint failed: ${intentFail}`, "intent");
  }

  const safeReleaseAt = safeReleaseAtMs(
    nowSeconds + horizonSeconds,
    policy.reorgMarginMs,
    policy.maxClockSkewMs,
  );

  const mandateId = mandate?.mandateId ?? dedup.mandateId ?? "__no_mandate__";

  const reserve = await store.tryReserve({
    principalId,
    mandateId,
    amount: payment.value,
    payTo: payment.payTo.toLowerCase(),
    now,
    windowMs: policy.windowMs,
    cap: policy.perMandateCap,
    ...(policy.principalAggregateCap !== undefined
      ? { aggregateCap: policy.principalAggregateCap }
      : {}),
    safeReleaseAt,
    ...(policy.perPayeeReservationLimit !== undefined
      ? { perPayeeReservationLimit: policy.perPayeeReservationLimit }
      : {}),
  });

  if (!reserve.ok) {
    const msg =
      reserve.reason === "cap_exceeded"
        ? `per-mandate cap ${reserve.cap} would be exceeded (committed ${reserve.committed} + ${payment.value})`
        : reserve.reason === "aggregate_cap_exceeded"
          ? `principal aggregate cap ${reserve.cap} would be exceeded (committed ${reserve.committed} + ${payment.value})`
          : `per-payee reservation limit reached for ${payment.payTo}`;
    return block(reserve.reason, msg, "budget");
  }

  // Duplicate-authorization guard, keyed on payer-owned identity (§control #3).
  // Prefix with principalId: dedup state is store-global, so an unscoped key
  // would let one principal's key falsely block (or, via removeDedup, un-guard)
  // another principal sharing the store. TTL includes the skew term so the key
  // never expires before the matching reservation's safeReleaseAt.
  const dedupKey = `${principalId}|${deriveDedupKey(payment, { ...dedup, mandateId })}`;
  const dedupTtl = horizonSeconds * 1000 + policy.reorgMarginMs + policy.maxClockSkewMs;
  const firstSighting = await store.putIfAbsent(dedupKey, dedupTtl, now);
  if (!firstSighting) {
    // A duplicate slipped past the cap; release the reservation we just made so
    // the cap is not held by a purchase we are refusing.
    await store.transition(reserve.reservationId, "reserved", "released");
    return block("duplicate_authorization", `duplicate authorization for ${dedupKey}`, "dedup");
  }

  return {
    decision: "allow",
    reason: "ok",
    message: "authorized",
    matchedRule: "budget+intent",
    reservationId: reserve.reservationId,
    dedupKey,
  };
}
