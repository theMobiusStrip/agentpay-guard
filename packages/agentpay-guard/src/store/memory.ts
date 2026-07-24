import { randomUUID } from "node:crypto";
import {
  PENDING_STATUSES,
  type ReservationStatus,
} from "../types.js";
import { Mutex } from "./mutex.js";
import type {
  AtomicStore,
  Reservation,
  RecoveryResult,
  ReserveRequest,
  ReserveResult,
  TransitionOptions,
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

  /** Pure: expire provably-dead reservations. Caller holds the mutex. */
  private releaseExpiredLocked(
    now: number,
    principalId?: string,
  ): number {
    let n = 0;
    for (const r of this.reservations.values()) {
      if (principalId !== undefined && r.principalId !== principalId) continue;
      const deadline =
        r.status === "reserved"
          ? r.safeReleaseAt
          : r.status === "signed" ||
              r.status === "submitted" ||
              r.status === "unknown"
            ? r.recoveryReleaseAt
            : undefined;
      if (deadline !== undefined && now >= deadline) {
        r.status = "expired";
        n++;
      }
    }
    return n;
  }

  /**
   * Grow uncertain-state recovery deadlines before checking expiry. Scope may
   * narrow a request-path expansion to one principal; restart/reconcile applies
   * the active window to every row in the store.
   */
  private extendRecoveryLocked(
    requestedWindowMs: number,
    principalId?: string,
  ): void {
    for (const r of this.reservations.values()) {
      if (principalId !== undefined && r.principalId !== principalId) continue;
      if (
        r.status !== "signed" &&
        r.status !== "submitted" &&
        r.status !== "unknown"
      ) {
        continue;
      }
      r.recoveryReleaseAt = Math.max(
        r.recoveryReleaseAt,
        r.safeReleaseAt + Math.max(r.windowMs, requestedWindowMs),
      );
    }
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
    for (const r of this.reservations.values()) {
      if (r.principalId !== principalId) continue;
      if (mandateId !== null && r.mandateId !== mandateId) continue;
      if (
        PENDING_STATUSES.includes(r.status)
      ) {
        total += r.amount;
      } else if (
        r.status === "settled" &&
        r.settledAt !== undefined &&
        r.settledAt > now - Math.max(r.windowMs, windowMs)
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
      if (PENDING_STATUSES.includes(r.status))
        n++;
    }
    return n;
  }

  private authorizationExistsLocked(
    authorization: NonNullable<Reservation["authorization"]>,
    exceptId?: string,
  ): boolean {
    const asset = authorization.asset.toLowerCase();
    const from = authorization.from.toLowerCase();
    const nonce = authorization.nonce.toLowerCase();
    for (const reservation of this.reservations.values()) {
      if (reservation.id === exceptId) continue;
      const existing = reservation.authorization;
      if (
        existing !== undefined &&
        existing.asset.toLowerCase() === asset &&
        existing.from.toLowerCase() === from &&
        existing.nonce.toLowerCase() === nonce
      ) {
        return true;
      }
    }
    return false;
  }

  async tryReserve(req: ReserveRequest): Promise<ReserveResult> {
    if (req.recoveryReleaseAt < req.safeReleaseAt + req.windowMs) {
      throw new Error(
        "recoveryReleaseAt must cover safeReleaseAt plus windowMs",
      );
    }
    return this.mutex.runExclusive(() => {
      this.extendRecoveryLocked(req.windowMs, req.principalId);
      this.releaseExpiredLocked(req.now, req.principalId);
      if (
        req.authorization !== undefined &&
        this.authorizationExistsLocked(req.authorization)
      ) {
        throw new Error("duplicate signed authorization reference");
      }

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

      const id = randomUUID();
      this.reservations.set(id, {
        id,
        principalId: req.principalId,
        mandateId: req.mandateId,
        amount: req.amount,
        status: "reserved",
        payTo: req.payTo,
        reservedAt: req.now,
        safeReleaseAt: req.safeReleaseAt,
        recoveryReleaseAt: req.recoveryReleaseAt,
        windowMs: req.windowMs,
        ...(req.authorization !== undefined
          ? { authorization: { ...req.authorization } }
          : {}),
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
    opts?: TransitionOptions,
  ): Promise<boolean> {
    if (to === "settled" && opts?.settledAt === undefined) {
      // Contract violation: settlement MUST be attributed at settlement time.
      // Backdating to reservedAt reopens the window-slide undercount.
      throw new Error("transition to 'settled' requires opts.settledAt");
    }
    if (opts?.authorization !== undefined && to !== "signed") {
      throw new Error(
        "authorization reference requires transition to 'signed'",
      );
    }
    return this.mutex.runExclusive(() => {
      const r = this.reservations.get(reservationId);
      if (!r || r.status !== from) return false;
      if (
        opts?.authorization !== undefined &&
        this.authorizationExistsLocked(
          opts.authorization,
          reservationId,
        )
      ) {
        throw new Error("duplicate signed authorization reference");
      }
      r.status = to;
      if (to === "settled" && opts?.settledAt !== undefined) {
        r.settledAt = opts.settledAt;
      }
      // safeReleaseAt only ever extends (covers a signed validBefore beyond the
      // originally-priced horizon); never shrink it.
      if (opts?.safeReleaseAt !== undefined && opts.safeReleaseAt > r.safeReleaseAt) {
        r.safeReleaseAt = opts.safeReleaseAt;
        r.recoveryReleaseAt = Math.max(
          r.recoveryReleaseAt,
          opts.safeReleaseAt + r.windowMs,
        );
      }
      if (opts?.authorization !== undefined) {
        r.authorization = { ...opts.authorization };
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

  async releaseExpired(
    now: number,
    requestedWindowMs: number,
  ): Promise<number> {
    return this.mutex.runExclusive(() => {
      this.extendRecoveryLocked(requestedWindowMs);
      return this.releaseExpiredLocked(now);
    });
  }

  async recoverAfterRestart(
    now: number,
    requestedWindowMs: number,
  ): Promise<RecoveryResult> {
    return this.mutex.runExclusive(() => {
      let markedUnknown = 0;
      for (const r of this.reservations.values()) {
        if (
          r.status === "reserved" ||
          r.status === "signed" ||
          r.status === "submitted"
        ) {
          r.status = "unknown";
          markedUnknown++;
        }
      }
      this.extendRecoveryLocked(requestedWindowMs);
      let expired = 0;
      for (const r of this.reservations.values()) {
        if (r.status === "unknown" && now >= r.recoveryReleaseAt) {
          r.status = "expired";
          expired++;
        }
      }
      return { markedUnknown, expired };
    });
  }

  async get(reservationId: string): Promise<Reservation | undefined> {
    const r = this.reservations.get(reservationId);
    return r
      ? {
          ...r,
          ...(r.authorization !== undefined
            ? { authorization: { ...r.authorization } }
            : {}),
        }
      : undefined;
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
