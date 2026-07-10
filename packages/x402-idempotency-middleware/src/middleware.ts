import {
  deriveClaimKey,
  type Eip3009Authorization,
  type Eip712Domain,
} from "./key.js";
import type { CachedGrant, ClaimStore } from "./store.js";

/** Minimal shape of an x402 v2 payment payload we read (exact EVM scheme). */
export interface PaymentPayloadLike {
  accepted?: {
    asset?: string;
    network?: string; // CAIP-2, e.g. "eip155:84532"
  };
  payload: Record<string, unknown>;
}

export interface ExtractedAuthorization {
  auth: Eip3009Authorization;
  token: string;
  domain?: Eip712Domain;
}

/**
 * Pull the payer-signed EIP-3009 authorization + token out of an x402 v2 exact
 * payload. Returns undefined if the shape is unrecognized (caller then fails
 * closed rather than granting on an unkeyable payment).
 */
export function extractAuthorization(
  payload: PaymentPayloadLike,
  domainNameVersion?: { name: string; version: string },
): ExtractedAuthorization | undefined {
  const rawAuth = (payload.payload["authorization"] ?? payload.payload["auth"]) as
    | Record<string, unknown>
    | undefined;
  if (!rawAuth || typeof rawAuth !== "object") return undefined;
  const s = (k: string): string | undefined =>
    typeof rawAuth[k] === "string" || typeof rawAuth[k] === "number"
      ? String(rawAuth[k])
      : undefined;
  const from = s("from");
  const to = s("to");
  const value = s("value");
  const validAfter = s("validAfter");
  const validBefore = s("validBefore");
  const nonce = s("nonce");
  if (!from || !to || value === undefined || !nonce) return undefined;
  const token = payload.accepted?.asset;
  if (!token) return undefined;

  const auth: Eip3009Authorization = {
    from,
    to,
    value,
    validAfter: validAfter ?? "0",
    validBefore: validBefore ?? "0",
    nonce,
  };

  const chainId = parseChainId(payload.accepted?.network);
  const out: ExtractedAuthorization = { auth, token };
  if (chainId !== undefined && domainNameVersion) {
    out.domain = {
      name: domainNameVersion.name,
      version: domainNameVersion.version,
      chainId,
      verifyingContract: token,
    };
  }
  return out;
}

function parseChainId(network?: string): number | undefined {
  if (!network) return undefined;
  const m = /^eip155:(\d+)$/.exec(network);
  return m ? Number(m[1]) : undefined;
}

export type BeginResult =
  | { kind: "proceed"; key: string; claimToken: number }
  | { kind: "replay"; key: string; grant: CachedGrant }
  | { kind: "in_progress"; key: string }
  | { kind: "unkeyable" };

export interface IdempotencyGuardOptions {
  store: ClaimStore;
  /** Lease duration: how long a claim is held before it is retryable. */
  leaseMs?: number;
  now?: () => number;
  /** EIP-712 domain name/version to compute the strong digest key (optional). */
  domainNameVersion?: { name: string; version: string };
}

/**
 * Framework-agnostic replay defense. The resource server calls `begin` before
 * verify/settle/grant; on a `proceed` it does the work and calls `complete`
 * (which caches the response); on failure it calls `fail`. A replayed
 * authorization returns `replay` with the cached grant instead of a second grant.
 */
export class IdempotencyGuard {
  private readonly store: ClaimStore;
  private readonly leaseMs: number;
  private readonly now: () => number;
  private readonly domainNameVersion: { name: string; version: string } | undefined;

  constructor(opts: IdempotencyGuardOptions) {
    this.store = opts.store;
    this.leaseMs = opts.leaseMs ?? 30_000;
    this.now = opts.now ?? Date.now;
    this.domainNameVersion = opts.domainNameVersion;
  }

  private keyFor(payload: PaymentPayloadLike): { key: string } | undefined {
    const extracted = extractAuthorization(payload, this.domainNameVersion);
    if (!extracted) return undefined;
    try {
      // Malformed numeric/hex fields (e.g. a JS-number value that stringifies to
      // "1e+21", or a non-32-byte nonce) make the EIP-712 hasher throw. Treat any
      // such failure as unkeyable (fail-closed) rather than letting begin() reject.
      const key = deriveClaimKey(extracted.auth, extracted.token, extracted.domain);
      return { key };
    } catch {
      return undefined;
    }
  }

  async begin(payload: PaymentPayloadLike): Promise<BeginResult> {
    const keyed = this.keyFor(payload);
    if (!keyed) return { kind: "unkeyable" };
    const outcome = await this.store.claim(keyed.key, this.leaseMs, this.now());
    if (outcome.outcome === "replay_cached") {
      return { kind: "replay", key: keyed.key, grant: outcome.grant };
    }
    if (outcome.outcome === "in_progress") {
      return { kind: "in_progress", key: keyed.key };
    }
    return { kind: "proceed", key: keyed.key, claimToken: outcome.claimToken };
  }

  async complete(key: string, claimToken: number, grant: CachedGrant): Promise<boolean> {
    return this.store.grant(key, claimToken, grant, this.now());
  }

  async fail(key: string, claimToken: number): Promise<void> {
    return this.store.release(key, claimToken);
  }
}
