import type { Policy, ReasonCode, ResolvedPayment } from "../types.js";

/**
 * MVP envelope check (§2): the one vertical slice we enforce. Anything outside
 * the allowlisted scheme / network / asset fails closed — never allow.
 *
 * @returns a blocking ReasonCode, or null if the payment is inside the envelope.
 */
export function checkEnvelope(
  payment: ResolvedPayment,
  policy: Policy,
): ReasonCode | null {
  if (!policy.envelope.schemes.includes(payment.scheme)) {
    return "envelope_scheme";
  }
  if (!policy.envelope.networks.includes(payment.network)) {
    return "envelope_network";
  }
  if (!policy.envelope.assets.includes(payment.asset.toLowerCase())) {
    return "envelope_asset";
  }
  return null;
}

/**
 * Confirm the resolved fields the guard needs are actually present. If the hook
 * could not surface `payTo` / `value`, we cannot reason about the payment and
 * must fail closed rather than reserve against unknowns.
 */
export function checkResolvedFields(
  payment: ResolvedPayment,
): ReasonCode | null {
  if (!payment.payTo || payment.payTo.trim() === "") {
    return "envelope_unresolved_fields";
  }
  if (payment.value < 0n) {
    return "envelope_unresolved_fields";
  }
  return null;
}
