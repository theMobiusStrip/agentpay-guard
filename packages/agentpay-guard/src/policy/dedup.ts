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
 *  - Degenerate fallback (no payer id, no mandate, no resource) => `undefined`.
 *    With none of those, the fallback key would be asset-only — CONSTANT across
 *    every purchase — so it would latch the whole principal to a single payment
 *    and block all later DISTINCT purchases as false duplicates. Returning
 *    `undefined` disables the client-side duplicate guard for that degenerate
 *    case; the cumulative CAP is the sole backstop for the resulting payer-side
 *    double-pay (a re-sign mints a fresh nonce, which the server middleware — keyed
 *    on `(token, from, nonce)` — does NOT collapse). resourceUrl is merchant-
 *    supplied, so a merchant can influence whether this fallback fires.
 *
 * The cumulative budget cap is the explicit backstop for jittered
 * re-presentation this key cannot catch. When a real mandate OR a resource url
 * IS present, distinct purchases sharing that (mandate, resource, asset) are
 * intentionally treated as duplicates (anti-jitter); wire a payer-owned
 * paymentIdentifier/intentId to distinguish them. See SECURITY.md.
 */
export interface DedupContext {
  /** Client-supplied payment-identifier, if the payer set one. */
  paymentIdentifier?: string;
  /** Client-side logical purchase intent id (e.g. agent task id). */
  intentId?: string;
  /** Provenance-verified mandate id, if any. The no-mandate sentinel/empty
   *  string both count as "no mandate" for dedup identity. */
  mandateId?: string;
}

/**
 * Derive the duplicate-authorization key, or `undefined` when no meaningful
 * payer-owned purchase identity exists (see degenerate-fallback note above).
 */
export function deriveDedupKey(
  payment: ResolvedPayment,
  ctx: DedupContext,
): string | undefined {
  if (ctx.paymentIdentifier && ctx.paymentIdentifier.trim() !== "") {
    return `pid:${ctx.paymentIdentifier}`;
  }
  if (ctx.intentId && ctx.intentId.trim() !== "") {
    return `intent:${ctx.intentId}|asset:${payment.asset.toLowerCase()}`;
  }
  // Client-side purchase intent from mandate + resource. Merchant fields
  // (payTo/value/validity) are deliberately excluded.
  const mandate =
    ctx.mandateId && ctx.mandateId !== "__no_mandate__" ? ctx.mandateId : "";
  const resource = payment.resourceUrl ?? "";
  if (mandate === "" && resource === "") {
    // No distinguishing material: an asset-only key would false-block every
    // distinct purchase. Skip client-side dedup; cap is the backstop.
    return undefined;
  }
  return `mandate:${mandate}|resource:${resource}|asset:${payment.asset.toLowerCase()}`;
}
