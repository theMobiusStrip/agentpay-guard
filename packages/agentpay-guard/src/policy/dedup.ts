import type { ResolvedPayment } from "../types.js";

/**
 * Duplicate-authorization guard key derivation (§2 control #3).
 *
 * Key on the payer-signed authorization identity, NOT merchant-controlled inputs:
 *
 *  - Primary key = the client-supplied `payment-identifier` WHEN the payer sets
 *    it. Fact-check confirms this id is client-supplied (an idempotency key the
 *    payer owns), so a malicious merchant cannot jitter it — this branch genuinely
 *    defends the re-presentation case.
 *  - Fallback (no payer-set id) = client-side purchase intent: mandateId +
 *    resource + asset. We do NOT fall back to the raw (payTo, value, validity)
 *    tuple — that is wholly merchant-controlled, so an adaptive merchant shifts
 *    validBefore or value by one unit and the key changes (dedup theater).
 *
 * The cumulative budget cap is the explicit backstop for jittered
 * re-presentation this key cannot catch.
 */
export interface DedupContext {
  /** Client-supplied payment-identifier, if the payer set one. */
  paymentIdentifier?: string;
  /** Client-side logical purchase intent id (e.g. agent task id). */
  intentId?: string;
  mandateId?: string;
}

export function deriveDedupKey(
  payment: ResolvedPayment,
  ctx: DedupContext,
): string {
  if (ctx.paymentIdentifier && ctx.paymentIdentifier.trim() !== "") {
    return `pid:${ctx.paymentIdentifier}`;
  }
  if (ctx.intentId && ctx.intentId.trim() !== "") {
    return `intent:${ctx.intentId}|asset:${payment.asset.toLowerCase()}`;
  }
  // Client-side purchase intent from mandate + resource. Merchant fields
  // (payTo/value/validity) are deliberately excluded.
  const mandate = ctx.mandateId ?? "";
  const resource = payment.resourceUrl ?? "";
  return `mandate:${mandate}|resource:${resource}|asset:${payment.asset.toLowerCase()}`;
}
