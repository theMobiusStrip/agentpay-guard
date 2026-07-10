import {
  PENDING_STATUSES,
  type ReservationStatus,
} from "../types.js";
import { Mutex } from "./mutex.js";
import type {
  AtomicStore,
  Reservation,
  ReserveRequest,
  ReserveResult,
} from "./types.js";

/**
 * In-memory atomic store. Single-process only (atomicity domain, §2 / store/types).
 *
 * Accounting model (the subtle part G1 proves):
 *  - PENDING reservations (reserved/signed/submitted/unknown) occupy the cap
 *    regardless of window age — they do NOT slide out of the rolling window.
 *    This is what defeats the "withhold settlement until the window slides, then
 *    sign a fresh batch" ~2x double-spend.
 *  - SETTLED spend is attributed at settlement time and counts only while
 *    settledAt is within [now - windowMs, now] — legitimate cumulative spend
 *    ages out of the window normally.
 *  - EXPIRED / RELEASED reservations never count.
 *
 * `tryReserve` first releases anything provably dead, then does an all-or-nothing
 * check-and-insert inside the mutex, so two concurrent callers cannot both see
 * headroom and both reserve.
 */
export class InMemoryAtomicStore implements AtomicStore {
  private readonly mutex = new Mutex();
  private readonly reservations = new Map<string, Reservation>();
  private readonly dedup = new Map<string, number>(); // dedupKey -> expiresAt (ms)
  private seq = 0;

  /** Pure: expire provably-dead reservations. Caller holds the mutex. */
  private releaseExpiredLocked(now: number): number {
    let n = 0;
    for (const r of this.reservations.values()) {
      if (
        (PENDING_STATUSES as readonly ReservationStatus[]).includes(r.status) &&
        now >= r.safeReleaseAt
      ) {
        r.status = "expired";
        n++;
      }
    }
    return n;
  }

  /**
   * Committed spend for a key. Caller holds the mutex.
   * pending (any age) + settled within [now-windowMs, now].
   */
  private committedLocked(
    principalId: string,
    mandateId: string | null,
    now: number,
    windowMs: number,
  ): bigint {
    let total = 0n;
    const windowStart = now - windowMs;
    for (const r of this.reservations.values()) {
      if (r.principalId !== principalId) continue;
      if (mandateId !== null && r.mandateId !== mandateId) continue;
      if (
        (PENDING_STATUSES as readonly ReservationStatus[]).includes(r.status)
      ) {
        total += r.amount;
      } else if (
        r.status === "settled" &&
        r.settledAt !== undefined &&
        r.settledAt > windowStart
        // No `settledAt <= now` upper bound: counting a settle that appears
        // future-dated (e.g. after a backward clock correction within the skew
        // bound) is strictly conservative and never undercounts the cap.
      ) {
        total += r.amount;
      }
    }
    return total;
  }

  private countPendingForPayeeLocked(
    principalId: string,
    payTo: string,
  ): number {
    let n = 0;
    for (const r of this.reservations.values()) {
      if (r.principalId !== principalId) continue;
      if (r.payTo !== payTo) continue;
      if ((PENDING_STATUSES as readonly ReservationStatus[]).includes(r.status))
        n++;
    }
    return n;
  }

  async tryReserve(req: ReserveRequest): Promise<ReserveResult> {
    return this.mutex.runExclusive(() => {
      this.releaseExpiredLocked(req.now);

      if (req.perPayeeReservationLimit !== undefined) {
        const pendingForPayee = this.countPendingForPayeeLocked(
          req.principalId,
          req.payTo,
        );
        if (pendingForPayee >= req.perPayeeReservationLimit) {
          const committed = this.committedLocked(
            req.principalId,
            req.mandateId,
            req.now,
            req.windowMs,
          );
          return {
            ok: false as const,
            reason: "per_payee_limit" as const,
            committed,
            cap: req.cap,
          };
        }
      }

      const committedMandate = this.committedLocked(
        req.principalId,
        req.mandateId,
        req.now,
        req.windowMs,
      );
      if (committedMandate + req.amount > req.cap) {
        return {
          ok: false as const,
          reason: "cap_exceeded" as const,
          committed: committedMandate,
          cap: req.cap,
        };
      }

      if (req.aggregateCap !== undefined) {
        const committedPrincipal = this.committedLocked(
          req.principalId,
          null,
          req.now,
          req.windowMs,
        );
        if (committedPrincipal + req.amount > req.aggregateCap) {
          return {
            ok: false as const,
            reason: "aggregate_cap_exceeded" as const,
            committed: committedPrincipal,
            cap: req.aggregateCap,
          };
        }
      }

      const id = `r${++this.seq}`;
      this.reservations.set(id, {
        id,
        principalId: req.principalId,
        mandateId: req.mandateId,
        amount: req.amount,
        status: "reserved",
        payTo: req.payTo,
        reservedAt: req.now,
        safeReleaseAt: req.safeReleaseAt,
      });
      return {
        ok: true as const,
        reservationId: id,
        committed: committedMandate + req.amount,
      };
    });
  }

  async transition(
    reservationId: string,
    from: ReservationStatus,
    to: ReservationStatus,
    opts?: { settledAt?: number; safeReleaseAt?: number },
  ): Promise<boolean> {
    if (to === "settled" && opts?.settledAt === undefined) {
      // Contract violation: settlement MUST be attributed at settlement time.
      // Backdating to reservedAt reopens the window-slide undercount.
      throw new Error("transition to 'settled' requires opts.settledAt");
    }
    return this.mutex.runExclusive(() => {
      const r = this.reservations.get(reservationId);
      if (!r || r.status !== from) return false;
      r.status = to;
      if (to === "settled" && opts?.settledAt !== undefined) {
        r.settledAt = opts.settledAt;
      }
      // safeReleaseAt only ever extends (covers a signed validBefore beyond the
      // originally-priced horizon); never shrink it.
      if (opts?.safeReleaseAt !== undefined && opts.safeReleaseAt > r.safeReleaseAt) {
        r.safeReleaseAt = opts.safeReleaseAt;
      }
      return true;
    });
  }

  async putIfAbsent(
    dedupKey: string,
    ttlMs: number,
    now: number,
  ): Promise<boolean> {
    return this.mutex.runExclusive(() => {
      const existing = this.dedup.get(dedupKey);
      if (existing !== undefined && existing > now) return false;
      this.dedup.set(dedupKey, now + ttlMs);
      return true;
    });
  }

  async removeDedup(dedupKey: string): Promise<void> {
    await this.mutex.runExclusive(() => {
      this.dedup.delete(dedupKey);
    });
  }

  async releaseExpired(now: number): Promise<number> {
    return this.mutex.runExclusive(() => this.releaseExpiredLocked(now));
  }

  async get(reservationId: string): Promise<Reservation | undefined> {
    const r = this.reservations.get(reservationId);
    return r ? { ...r } : undefined;
  }

  async committedAmount(
    principalId: string,
    mandateId: string,
    now: number,
    windowMs: number,
  ): Promise<bigint> {
    return this.mutex.runExclusive(() =>
      this.committedLocked(principalId, mandateId, now, windowMs),
    );
  }

  /** Total settled amount across the whole store (test helper for G1). */
  async totalSettled(): Promise<bigint> {
    return this.mutex.runExclusive(() => {
      let total = 0n;
      for (const r of this.reservations.values()) {
        if (r.status === "settled") total += r.amount;
      }
      return total;
    });
  }
}
