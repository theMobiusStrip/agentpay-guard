import type { ReservationStatus } from "../types.js";

/**
 * Atomic store contract (§5). "Pluggable store" is undefined at exactly the level
 * G1 tests, so we name the primitives explicitly. Every mutating op takes `now`
 * so the clock is injectable and there is no read/op TOCTOU inside the store.
 *
 * The atomicity domain is a precondition: the bundled in-memory store is
 * single-process. A shared store (Redis/Postgres) is REQUIRED for multi-worker —
 * two workers sharing a principalId with per-process stores each get the full cap.
 * A conforming external store must make `tryReserve` a single atomic critical
 * section (Redis Lua / Postgres serializable tx), not a KV get/put with the check
 * living above the store. G1 runs against every shipped store.
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
   */
  transition(
    reservationId: string,
    from: ReservationStatus,
    to: ReservationStatus,
    opts?: { settledAt?: number; safeReleaseAt?: number },
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
   * Transition every non-terminal, non-settled reservation whose `safeReleaseAt`
   * has passed to `expired`. Returns the count released.
   */
  releaseExpired(now: number): Promise<number>;

  /** Read a reservation (reconciliation / tests). */
  get(reservationId: string): Promise<Reservation | undefined>;

  /**
   * Currently-committed spend for a (principalId, mandateId) at `now`: pending
   * reservations of any age + settled spend with settledAt in [now-window, now].
   * Read-only helper for reconciliation and G1 assertions.
   */
  committedAmount(
    principalId: string,
    mandateId: string,
    now: number,
    windowMs: number,
  ): Promise<bigint>;
}
