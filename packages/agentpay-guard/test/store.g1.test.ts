import { describe, expect, it } from "vitest";
import { InMemoryAtomicStore } from "../src/store/memory.js";
import { safeReleaseAtMs } from "../src/clock.js";
import { reserveReq } from "./helpers.js";

/**
 * G1 — the overspend gate (§5, §8). If any of these can overspend, the budget
 * control is not done. Runs against the in-memory store here; an external store
 * must pass the identical suite.
 */
describe("G1: atomic budget cap", () => {
  it("concurrent overspend: N reservations against cap M<N settle <= M", async () => {
    const store = new InMemoryAtomicStore();
    const cap = 100n;
    const each = 10n;
    const N = 50; // fire 50 concurrent, only 10 fit

    const results = await Promise.all(
      Array.from({ length: N }, () =>
        store.tryReserve(reserveReq({ amount: each, now: 1000, cap })),
      ),
    );

    const ok = results.filter((r) => r.ok);
    const committed = await store.committedAmount(
      "principal-1",
      "mandate-1",
      1000,
      60_000,
    );
    expect(ok.length).toBe(10);
    expect(committed).toBe(cap);
    expect(committed).toBeLessThanOrEqual(cap);
  });

  it("window-slide double-spend: pending reservations hold cap regardless of window age", async () => {
    // The v6 fix: a merchant who withholds settlement until the rolling window
    // slides past the reserve timestamps must NOT free the cap for a fresh batch.
    const store = new InMemoryAtomicStore();
    const cap = 100n;
    const windowMs = 1_000;

    // t=0: reserve the whole cap; keep it PENDING (never settle).
    const first = await store.tryReserve(
      reserveReq({
        amount: 100n,
        now: 0,
        cap,
        windowMs,
        // safeReleaseAt far in the future so it does not expire during the test.
        safeReleaseAt: safeReleaseAtMs(3600, 2_000, 5_000),
      }),
    );
    expect(first.ok).toBe(true);

    // t=5000: the window (1s) has slid well past the reservation timestamp.
    // A naive window-only store would now free the cap. Ours must not.
    const second = await store.tryReserve(
      reserveReq({ amount: 100n, now: 5_000, cap, windowMs }),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("cap_exceeded");

    const committed = await store.committedAmount("principal-1", "mandate-1", 5_000, windowMs);
    expect(committed).toBe(100n); // still fully committed by the pending reservation
  });

  it("settled spend ages out of the rolling window (legit cumulative spend)", async () => {
    const store = new InMemoryAtomicStore();
    const cap = 100n;
    const windowMs = 1_000;

    const r = await store.tryReserve(reserveReq({ amount: 100n, now: 0, cap, windowMs }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await store.transition(r.reservationId, "reserved", "signed");
    await store.transition(r.reservationId, "signed", "settled", { settledAt: 0 });

    // Within window: settled spend still counts -> blocked.
    const within = await store.tryReserve(reserveReq({ amount: 100n, now: 500, cap, windowMs }));
    expect(within.ok).toBe(false);

    // After window: settled spend aged out -> allowed.
    const after = await store.tryReserve(reserveReq({ amount: 100n, now: 1_500, cap, windowMs }));
    expect(after.ok).toBe(true);
  });

  it("skewed-clock: reservation is not released early when the local clock runs ahead", async () => {
    // safeReleaseAt folds in maxClockSkew, so a clock ahead by up to the skew
    // bound cannot trigger an early release while the authorization can settle.
    const store = new InMemoryAtomicStore();
    const validBeforeSeconds = 10; // authorization dies at true t=10s (+margin)
    const reorgMarginMs = 2_000;
    const maxClockSkewMs = 5_000;
    const safeReleaseAt = safeReleaseAtMs(validBeforeSeconds, reorgMarginMs, maxClockSkewMs);
    expect(safeReleaseAt).toBe(10_000 + 2_000 + 5_000); // 17_000

    const r = await store.tryReserve(reserveReq({ amount: 50n, now: 0, safeReleaseAt }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Local clock reads 15_000 but may be up to 5_000 ahead of true time
    // (true time ~10_000, authorization still settleable). Must NOT release.
    const releasedEarly = await store.releaseExpired(15_000);
    expect(releasedEarly).toBe(0);
    const res1 = await store.get(r.reservationId);
    expect(res1?.status).toBe("reserved");

    // Past safeReleaseAt: now certainly dead -> released.
    const released = await store.releaseExpired(17_000);
    expect(released).toBe(1);
    const res2 = await store.get(r.reservationId);
    expect(res2?.status).toBe("expired");
  });

  it("released reservation frees the cap immediately (pre-sign abort)", async () => {
    const store = new InMemoryAtomicStore();
    const cap = 100n;
    const r = await store.tryReserve(reserveReq({ amount: 100n, now: 0, cap }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await store.transition(r.reservationId, "reserved", "released");
    const next = await store.tryReserve(reserveReq({ amount: 100n, now: 10, cap }));
    expect(next.ok).toBe(true);
  });

  it("principal-level aggregate cap catches salami drain spread across mandates", async () => {
    const store = new InMemoryAtomicStore();
    const perMandateCap = 100n;
    const aggregateCap = 150n;

    const a = await store.tryReserve(
      reserveReq({ amount: 100n, now: 0, mandateId: "m-a", cap: perMandateCap, aggregateCap }),
    );
    expect(a.ok).toBe(true);
    // Second mandate is within its own cap but breaches the principal aggregate.
    const b = await store.tryReserve(
      reserveReq({ amount: 100n, now: 0, mandateId: "m-b", cap: perMandateCap, aggregateCap }),
    );
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe("aggregate_cap_exceeded");
  });

  it("per-payee reservation limit (denial-of-wallet mitigation)", async () => {
    const store = new InMemoryAtomicStore();
    const opts = { cap: 1_000_000n, perPayeeReservationLimit: 2, payTo: "0xsquat" };
    const r1 = await store.tryReserve(reserveReq({ amount: 1n, now: 0, ...opts }));
    const r2 = await store.tryReserve(reserveReq({ amount: 1n, now: 0, ...opts }));
    const r3 = await store.tryReserve(reserveReq({ amount: 1n, now: 0, ...opts }));
    expect(r1.ok && r2.ok).toBe(true);
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.reason).toBe("per_payee_limit");
  });

  it("putIfAbsent dedup: second identical key within TTL is rejected, honored after TTL", async () => {
    const store = new InMemoryAtomicStore();
    expect(await store.putIfAbsent("k", 1_000, 0)).toBe(true);
    expect(await store.putIfAbsent("k", 1_000, 500)).toBe(false);
    expect(await store.putIfAbsent("k", 1_000, 1_001)).toBe(true); // TTL expired
    await store.removeDedup("k");
    expect(await store.putIfAbsent("k", 1_000, 1_100)).toBe(true); // removed -> reusable
  });
});
