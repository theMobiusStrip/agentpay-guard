/**
 * Claim store for the replay middleware. Claim-with-lease + cached-response
 * (§2 #4): not just claim-before-grant. A duplicate presentation of a
 * claimed-and-granted payment replays the STORED grant; a claimed-but-ungranted
 * payment (server crashed between claim and grant) becomes retryable after lease
 * expiry — otherwise the defense itself manufactures a permanent
 * `paid_without_service`.
 */

/** Opaque cached response replayed to duplicate presentations of a granted key. */
export interface CachedGrant {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export type ClaimOutcome =
  | { outcome: "proceed"; claimToken: number } // first sighting (or reclaimed after lease)
  | { outcome: "replay_cached"; grant: CachedGrant } // already granted -> replay
  | { outcome: "in_progress" }; // concurrently claimed, lease still valid -> reject/hold

export interface ClaimStore {
  /**
   * Atomically claim the key for processing. Idempotent under concurrency and
   * crash: see ClaimOutcome. `claimToken` distinguishes a lease generation so a
   * stale worker cannot grant over a newer claim.
   */
  claim(key: string, leaseMs: number, now: number): Promise<ClaimOutcome>;

  /**
   * Record the grant (cached response) for a claimed key. No-ops if the claim
   * token is stale (a newer claim superseded it). Returns whether it was stored.
   */
  grant(
    key: string,
    claimToken: number,
    grant: CachedGrant,
    now: number,
  ): Promise<boolean>;

  /** Explicitly release a claim (handler failed) so it is retryable at once. */
  release(key: string, claimToken: number): Promise<void>;

  /** Read (tests / reconciliation). */
  peek(key: string): Promise<
    | { status: "claimed"; leaseExpiry: number; claimToken: number }
    | { status: "granted"; grant: CachedGrant }
    | undefined
  >;
}

interface Entry {
  status: "claimed" | "granted";
  leaseExpiry?: number;
  claimToken?: number;
  grant?: CachedGrant;
}

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** In-memory ClaimStore (single-process). A shared store swaps the same contract. */
export class InMemoryClaimStore implements ClaimStore {
  private readonly mutex = new Mutex();
  private readonly entries = new Map<string, Entry>();
  private tokenSeq = 0;

  async claim(key: string, leaseMs: number, now: number): Promise<ClaimOutcome> {
    return this.mutex.runExclusive(() => {
      const e = this.entries.get(key);
      if (e?.status === "granted" && e.grant) {
        return { outcome: "replay_cached" as const, grant: e.grant };
      }
      if (e?.status === "claimed") {
        if (e.leaseExpiry !== undefined && now < e.leaseExpiry) {
          return { outcome: "in_progress" as const };
        }
        // Lease expired: server likely crashed between claim and grant. Reclaim
        // under a fresh token so the payment is retryable, not permanently stuck.
        const claimToken = ++this.tokenSeq;
        this.entries.set(key, { status: "claimed", leaseExpiry: now + leaseMs, claimToken });
        return { outcome: "proceed" as const, claimToken };
      }
      const claimToken = ++this.tokenSeq;
      this.entries.set(key, { status: "claimed", leaseExpiry: now + leaseMs, claimToken });
      return { outcome: "proceed" as const, claimToken };
    });
  }

  async grant(
    key: string,
    claimToken: number,
    grant: CachedGrant,
    _now: number,
  ): Promise<boolean> {
    return this.mutex.runExclusive(() => {
      const e = this.entries.get(key);
      // Only the holder of the current claim token may grant (a newer reclaim
      // after lease expiry supersedes a stale worker).
      if (!e || e.status !== "claimed" || e.claimToken !== claimToken) return false;
      this.entries.set(key, { status: "granted", grant });
      return true;
    });
  }

  async release(key: string, claimToken: number): Promise<void> {
    await this.mutex.runExclusive(() => {
      const e = this.entries.get(key);
      if (e && e.status === "claimed" && e.claimToken === claimToken) {
        this.entries.delete(key);
      }
    });
  }

  async peek(key: string) {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.status === "granted" && e.grant) {
      return { status: "granted" as const, grant: e.grant };
    }
    return {
      status: "claimed" as const,
      leaseExpiry: e.leaseExpiry ?? 0,
      claimToken: e.claimToken ?? 0,
    };
  }
}
