import { hashTypedData, type Hex } from "viem";

/**
 * The payer-signed EIP-3009 authorization identity. Derived from the SIGNED
 * fields the payer owns — NOT the client/merchant-supplied payment-identifier,
 * which is attacker-variable (the replayer is a client and controls it). Keying
 * idempotency on the identifier reproduces the "dedup is theater" hole: a
 * replayer re-presents the same signed authorization under a fresh identifier and
 * collects a second grant (the "Five Attacks" paper reports 248 grants/payment).
 */
export interface Eip3009Authorization {
  from: string;
  to: string;
  value: string; // atomic units, decimal string
  validAfter: string;
  validBefore: string;
  nonce: string; // 32-byte hex; SDK-generated random, unique per authorization
}

export interface Eip712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string; // token contract (the EIP-3009 asset)
}

/**
 * Strong key: the EIP-712 digest of the TransferWithAuthorization typed data.
 * Binds every signed field + the domain (chain, token), so no field can be
 * varied without changing the key. Requires the domain (token/chain).
 */
export function eip712DigestKey(
  auth: Eip3009Authorization,
  domain: Eip712Domain,
): string {
  const digest: Hex = hashTypedData({
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract as Hex,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: auth.from as Hex,
      to: auth.to as Hex,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce as Hex,
    },
  });
  return `digest:${digest}`;
}

/**
 * Fallback key: (token, from, nonce). Attacker-independent because the nonce is
 * part of the payer-signed authorization and is unique per authorization (the
 * SDK mints 32 random bytes per createPaymentPayload — verified). Use when the
 * full domain is not available to compute the digest.
 */
export function tupleKey(token: string, auth: Eip3009Authorization): string {
  return `tuple:${token.toLowerCase()}:${auth.from.toLowerCase()}:${auth.nonce.toLowerCase()}`;
}

/**
 * Derive the claim key, preferring the EIP-712 digest when the domain is known,
 * else the (token, from, nonce) tuple. Never keys on the payment-identifier.
 */
export function deriveClaimKey(
  auth: Eip3009Authorization,
  token: string,
  domain?: Eip712Domain,
): string {
  if (domain) return eip712DigestKey(auth, domain);
  return tupleKey(token, auth);
}
