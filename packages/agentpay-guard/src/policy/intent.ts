import type {
  Policy,
  ReasonCode,
  ResolvedPayment,
  VerifiedMandate,
} from "../types.js";

/**
 * Trusted intent / resource-binding check (§2 control #2).
 *
 * Compares the about-to-be-signed fields against a TRUSTED, provenance-verified
 * mandate. Honest naming: this is a trusted intent CONSTRAINT check, not AP2
 * SD-JWT-VC cryptographic binding — the mandate's provenance is what makes it
 * trustworthy, and that is verified upstream by `mandateVerifier`.
 *
 * EIP-3009 only signs { from, to, value, validAfter, validBefore, nonce }; it
 * does NOT sign merchant / resource URL / method. So payTo and value are bound
 * cleanly here; resource-URL binding is only as strong as the separately-signed
 * mandate that carries it.
 *
 * Profile semantics (§2):
 *  - budget-only: intent check is OFF (returns null even with no mandate).
 *  - mandate-required: a missing/expired mandate fails closed.
 *
 * @param nowSeconds unix seconds, for mandate expiry.
 * @returns a blocking ReasonCode, or null when the intent is satisfied / off.
 */
export function checkIntent(
  payment: ResolvedPayment,
  mandate: VerifiedMandate | undefined,
  policy: Policy,
  nowSeconds: number,
): ReasonCode | null {
  if (policy.profile === "budget-only") {
    return null; // intent check off by design (deployable-today profile)
  }

  // mandate-required from here on.
  if (!mandate) {
    return "mandate_missing";
  }
  if (
    mandate.constraints.expiry !== undefined &&
    nowSeconds > mandate.constraints.expiry
  ) {
    return "mandate_expired";
  }

  const c = mandate.constraints;
  if (
    c.payTo !== undefined &&
    c.payTo.toLowerCase() !== payment.payTo.toLowerCase()
  ) {
    return "intent_payto_mismatch";
  }
  if (c.maxAmount !== undefined && payment.value > c.maxAmount) {
    return "intent_amount_exceeds";
  }
  if (
    c.asset !== undefined &&
    c.asset.toLowerCase() !== payment.asset.toLowerCase()
  ) {
    return "intent_asset_mismatch";
  }
  if (c.network !== undefined && c.network !== payment.network) {
    return "intent_network_mismatch";
  }
  return null;
}
