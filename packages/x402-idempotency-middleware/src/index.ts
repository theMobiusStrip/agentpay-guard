/**
 * x402-idempotency-middleware — server-side reference middleware for the replay
 * class the client structurally cannot see.
 *
 * Keys idempotency on the PAYER-SIGNED EIP-3009 authorization (EIP-712 digest or
 * (token, from, nonce)) — never the client-supplied payment-identifier, which the
 * replayer controls. Claim-with-lease + cached-response so a crash between claim
 * and grant is retryable rather than a permanent `paid_without_service`.
 *
 * This ships in the repo alongside the client plugin but is NOT part of it: the
 * client cannot stop an already-emitted authorization from being replayed — that
 * is a resource-server concern.
 */
export {
  IdempotencyGuard,
  extractAuthorization,
  type IdempotencyGuardOptions,
  type BeginResult,
  type PaymentPayloadLike,
  type ExtractedAuthorization,
} from "./middleware.js";

export {
  InMemoryClaimStore,
  type ClaimStore,
  type ClaimOutcome,
  type CachedGrant,
} from "./store.js";

export {
  deriveClaimKey,
  eip712DigestKey,
  tupleKey,
  type Eip3009Authorization,
  type Eip712Domain,
} from "./key.js";
