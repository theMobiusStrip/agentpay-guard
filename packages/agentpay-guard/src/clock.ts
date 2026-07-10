/**
 * Clock abstraction (§5). Expiry must be judged against an *authoritative* clock,
 * not a naive local one that may run ahead of chain time. A reservation released
 * early (because the local clock is fast) frees cap while its authorization can
 * still settle — a cap overspend. So callers pass `now` into every store op and
 * the guard derives a conservative expiry bound from it.
 */
export interface Clock {
  /** Best-estimate local wall-clock time, ms since epoch. */
  now(): number;
}

/** Real system clock. */
export const systemClock: Clock = {
  now: () => Date.now(),
};

/**
 * Deterministic clock for tests / the G1 skewed-clock case. `advance` and `set`
 * let a harness drive time without touching the wall clock.
 */
export class ManualClock implements Clock {
  private t: number;
  constructor(startMs = 0) {
    this.t = startMs;
  }
  now(): number {
    return this.t;
  }
  set(ms: number): void {
    this.t = ms;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/**
 * Compute the local-clock time at which a signed authorization is *provably* dead
 * and its reservation is safe to release.
 *
 * We only release when we are certain true time has passed `validBefore + reorgMargin`.
 * If the local clock may be AHEAD of true time by up to `maxClockSkewMs`, then
 * `trueTime >= localNow - maxClockSkewMs`, so we require
 * `localNow >= validBefore + reorgMargin + maxClockSkew` before releasing.
 * This is conservative: it releases LATER under skew, never early.
 *
 * @param validBeforeSeconds EIP-3009 validBefore (unix seconds)
 * @param reorgMarginMs confirmation/reorg margin
 * @param maxClockSkewMs max the local clock may lead true time
 * @returns local-clock ms at/after which release is safe
 */
export function safeReleaseAtMs(
  validBeforeSeconds: number,
  reorgMarginMs: number,
  maxClockSkewMs: number,
): number {
  return validBeforeSeconds * 1000 + reorgMarginMs + maxClockSkewMs;
}
