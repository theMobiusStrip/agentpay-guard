import type { ReservationStatus } from "../types.js";

/**
 * Atomic store contract (§5). "Pluggable store" is undefined at exactly the level
 * G1 tests, so we name the primitives explicitly. Every mutating op takes `now`
 * so the clock is injectable and there is no read/op TOCTOU inside the store.
 *
 * Atomicity domain is a precondition: memory store is single-process; SQLite
 * adapter is restart-safe for one active proxy process. PostgreSQL is REQUIRED
 * for multi-worker lifecycle ownership. Two per-process stores each get full cap.
 * A conforming external store must make `tryReserve` a single atomic critical
 * section (SQLite immediate / Postgres serializable tx), not a KV get/put with
 * check living above store. G1 runs against every shipped store.
 *
 * The store is a TRUSTED component (in the TCB): fail-closed covers "store
 * unavailable", not a poisoned store.
 */
export interface Reservation {
  id: string;
  principalId: string;
  mandateId: string;
  amount: bigint;
  status: ReservationStatus;
  payTo: string;
  /** local-clock ms when reserved. */
  reservedAt: number;
  /** local-clock ms when settled (set on transition to "settled"). */
  settledAt?: number;
  /** local-clock ms at/after which release is safe if not settled (§clock). */
  safeReleaseAt: number;
  /**
   * local-clock ms at/after which an outcome-unknown authorization can no
   * longer affect this reservation's rolling window.
   */
  recoveryReleaseAt: number;
  /** Original rolling window. Window contraction is not retroactive. */
  windowMs: number;
  /** Payer-signed authorization reference. Never includes signature/payload. */
  authorization?: SignedAuthorizationReference;
}

export interface SignedAuthorizationReference {
  network: string;
  asset: string;
  from: string;
  nonce: string;
  /** EIP-3009 unix timestamp, seconds. */
  validBefore: number;
}

export interface ReserveRequest {
  principalId: string;
  mandateId: string;
  amount: bigint;
  payTo: string;
  /** local-clock ms, injected. */
  now: number;
  /** rolling window length in ms for settled-spend attribution. */
  windowMs: number;
  /** per-mandate cap in atomic units. */
  cap: bigint;
  /** optional principal-level aggregate cap across all mandates. */
  aggregateCap?: bigint;
  /** local-clock ms at/after which this reservation is safe to release. */
  safeReleaseAt: number;
  /**
   * local-clock ms at/after which crash-recovered signed/unknown state may
   * expire. Must cover safeReleaseAt plus the reservation's rolling window.
   */
  recoveryReleaseAt: number;
  /** Optional pre-known signed-authorization reference. */
  authorization?: SignedAuthorizationReference;
  /** optional per-payee concurrent reservation limit (denial-of-wallet, §3). */
  perPayeeReservationLimit?: number;
}

export type ReserveResult =
  | { ok: true; reservationId: string; committed: bigint }
  | {
      ok: false;
      reason: "cap_exceeded" | "aggregate_cap_exceeded" | "per_payee_limit";
      committed: bigint;
      cap: bigint;
    };

export interface TransitionOptions {
  /** Injected local-clock ms for mutation metadata. Never use SQL wall clock. */
  now?: number;
  settledAt?: number;
  safeReleaseAt?: number;
  /**
   * Persist with reserved -> signed in the same atomic transition. Omits
   * signature and raw payment payload.
   */
  authorization?: SignedAuthorizationReference;
}

export interface RecoveryResult {
  markedUnknown: number;
  expired: number;
}

/**
 * Atomic state store. Implementations MUST serialize the read-compute-write of
 * tryReserve so concurrent callers cannot both observe headroom and both reserve.
 */
export interface AtomicStore {
  /**
   * Atomically: release anything provably expired, compute committed spend
   * (pending reservations of any age + settled spend within the window), and if
   * `committed + amount <= cap` (and the aggregate cap, and per-payee limit),
   * insert a reservation in `reserved` state. All-or-nothing.
   */
  tryReserve(req: ReserveRequest): Promise<ReserveResult>;

  /**
   * CAS state transition. Returns false if the reservation is missing or not in
   * `from`.
   *
   * - `settledAt` is REQUIRED when transitioning to "settled" (attribution at
   *   settlement time). Omitting it is a contract violation and throws — never
   *   backdate to reservedAt (that reopens the window-slide undercount).
   * - `safeReleaseAt` (optional) extends the reservation's safe-release time to
   *   cover the actually-signed `validBefore` (only ever extends, never shrinks).
   *   `recoveryReleaseAt` extends with it by the reservation's stored `windowMs`.
   * - `authorization` persists only payer-owned reference fields, atomically with
   *   the signed state. Never persist a signature or raw payment payload.
   */
  transition(
    reservationId: string,
    from: ReservationStatus,
    to: ReservationStatus,
    opts?: TransitionOptions,
  ): Promise<boolean>;

  /**
   * Duplicate-authorization guard primitive. Returns true if the key was
   * inserted (first sighting), false if it already exists within its TTL.
   */
  putIfAbsent(dedupKey: string, ttlMs: number, now: number): Promise<boolean>;

  /**
   * Remove a dedup key. Used to un-consume a key when the payment failed BEFORE
   * signing, so a legitimate retry (the fetch wrapper re-runs hooks on its
   * recovery path) is not falsely blocked as a duplicate.
   */
  removeDedup(dedupKey: string): Promise<void>;

  /**
   * First extend uncertain rows for the active rolling window, then expire
   * `reserved` at `safeReleaseAt` and signed/submitted/unknown at
   * `recoveryReleaseAt`. Window expansion applies before any expiry decision.
   * Returns count released.
   */
  releaseExpired(now: number, requestedWindowMs: number): Promise<number>;

  /**
   * Restart boundary: atomically mark reserved/signed/submitted rows `unknown`,
   * extend every unknown row for the active rolling window, then expire rows
   * whose recovery deadline passed. Extension MUST precede expiry so a longer
   * post-restart window cannot forget possibly-settled spend under the old
   * shorter deadline.
   */
  recoverAfterRestart(
    now: number,
    requestedWindowMs: number,
  ): Promise<RecoveryResult>;

  /** Read a reservation (reconciliation / tests). */
  get(reservationId: string): Promise<Reservation | undefined>;

  /**
   * Currently-committed spend for a (principalId, mandateId) at `now`: pending
   * reservations of any age + settled spend whose per-row attribution window
   * has not passed. Each row uses max(stored windowMs, requested windowMs), so
   * config contraction never forgets old spend early.
   */
  committedAmount(
    principalId: string,
    mandateId: string,
    now: number,
    windowMs: number,
  ): Promise<bigint>;
}
