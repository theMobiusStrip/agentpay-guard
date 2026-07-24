import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { safeReleaseAtMs } from "../src/clock.js";
import type { AtomicStore } from "../src/store/types.js";
import { reserveReq } from "./helpers.js";

export interface StoreHarness {
  store: AtomicStore;
  close?: () => Promise<void> | void;
}

export type StoreFactory = () => Promise<StoreHarness> | StoreHarness;

/**
 * Shared custody-store contract. Every shipped store runs these exact cases.
 */
export function runAtomicStoreContract(
  label: string,
  create: StoreFactory,
): void {
  describe(label, () => {
    let harness: StoreHarness;
    let store: AtomicStore;

    beforeEach(async () => {
      harness = await create();
      store = harness.store;
    });

    afterEach(async () => {
      await harness.close?.();
    });

    it("serializes concurrent reserve calls at the cap", async () => {
      const cap = 100n;
      const results = await Promise.all(
        Array.from({ length: 50 }, () =>
          store.tryReserve(
            reserveReq({ amount: 10n, now: 1_000, cap }),
          ),
        ),
      );

      expect(results.filter((r) => r.ok)).toHaveLength(10);
      expect(
        await store.committedAmount(
          "principal-1",
          "mandate-1",
          1_000,
          60_000,
        ),
      ).toBe(cap);
    });

    it("counts pending reservations at any window age", async () => {
      const first = await store.tryReserve(
        reserveReq({
          amount: 100n,
          now: 0,
          cap: 100n,
          windowMs: 1_000,
          safeReleaseAt: safeReleaseAtMs(3_600, 2_000, 5_000),
        }),
      );
      expect(first.ok).toBe(true);

      const second = await store.tryReserve(
        reserveReq({
          amount: 100n,
          now: 5_000,
          cap: 100n,
          windowMs: 1_000,
        }),
      );
      expect(second).toMatchObject({ ok: false, reason: "cap_exceeded" });
    });

    it("ages settled spend out of its rolling window", async () => {
      const first = await store.tryReserve(
        reserveReq({
          amount: 100n,
          now: 0,
          cap: 100n,
          windowMs: 1_000,
        }),
      );
      if (!first.ok) throw new Error("reserve failed");
      await store.transition(first.reservationId, "reserved", "signed");
      await store.transition(first.reservationId, "signed", "settled", {
        settledAt: 0,
      });

      expect(
        await store.tryReserve(
          reserveReq({
            amount: 100n,
            now: 500,
            cap: 100n,
            windowMs: 1_000,
          }),
        ),
      ).toMatchObject({ ok: false });
      expect(
        await store.tryReserve(
          reserveReq({
            amount: 100n,
            now: 1_500,
            cap: 100n,
            windowMs: 1_000,
          }),
        ),
      ).toMatchObject({ ok: true });
    });

    it("releases reserved state at safeReleaseAt", async () => {
      const safeReleaseAt = safeReleaseAtMs(10, 2_000, 5_000);
      const reservation = await store.tryReserve(
        reserveReq({ amount: 50n, now: 0, safeReleaseAt }),
      );
      if (!reservation.ok) throw new Error("reserve failed");

      expect(await store.releaseExpired(safeReleaseAt - 1, 60_000)).toBe(0);
      expect(
        (await store.get(reservation.reservationId))?.status,
      ).toBe("reserved");
      expect(await store.releaseExpired(safeReleaseAt, 60_000)).toBe(1);
      expect(
        (await store.get(reservation.reservationId))?.status,
      ).toBe("expired");
    });

    it("holds signed state through recoveryReleaseAt", async () => {
      const reservation = await store.tryReserve(
        reserveReq({
          amount: 50n,
          now: 0,
          windowMs: 1_000,
          safeReleaseAt: 10_000,
          recoveryReleaseAt: 11_000,
        }),
      );
      if (!reservation.ok) throw new Error("reserve failed");
      await store.transition(
        reservation.reservationId,
        "reserved",
        "signed",
      );

      expect(await store.releaseExpired(10_000, 1_000)).toBe(0);
      expect(await store.releaseExpired(10_999, 1_000)).toBe(0);
      expect(await store.releaseExpired(11_000, 1_000)).toBe(1);
    });

    it("recovers live process-local states as unknown", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        const reservation = await store.tryReserve(
          reserveReq({
            amount: 1n,
            now: 0,
            mandateId: `m-${i}`,
            windowMs: 1_000,
            safeReleaseAt: 10_000,
            recoveryReleaseAt: 20_000,
          }),
        );
        if (!reservation.ok) throw new Error("reserve failed");
        ids.push(reservation.reservationId);
      }
      const signedId = ids[1];
      const submittedId = ids[2];
      const unknownId = ids[3];
      if (
        signedId === undefined ||
        submittedId === undefined ||
        unknownId === undefined
      ) {
        throw new Error("recovery reservations missing");
      }
      await store.transition(signedId, "reserved", "signed");
      await store.transition(submittedId, "reserved", "signed");
      await store.transition(submittedId, "signed", "submitted");
      await store.transition(unknownId, "reserved", "signed");
      await store.transition(unknownId, "signed", "unknown");

      expect(await store.recoverAfterRestart(5_000, 1_000)).toEqual({
        markedUnknown: 3,
        expired: 0,
      });
      for (const id of ids) {
        expect((await store.get(id))?.status).toBe("unknown");
      }
    });

    it("expires recovered state only at recoveryReleaseAt", async () => {
      const reservation = await store.tryReserve(
        reserveReq({
          amount: 1n,
          now: 0,
          windowMs: 1_000,
          safeReleaseAt: 10_000,
          recoveryReleaseAt: 11_000,
        }),
      );
      if (!reservation.ok) throw new Error("reserve failed");

      expect(await store.recoverAfterRestart(10_999, 1_000)).toEqual({
        markedUnknown: 1,
        expired: 0,
      });
      expect(await store.recoverAfterRestart(11_000, 1_000)).toEqual({
        markedUnknown: 0,
        expired: 1,
      });
    });

    it("extends crash-unknown deadline before window-expansion expiry", async () => {
      const reservation = await store.tryReserve(
        reserveReq({
          amount: 100n,
          now: 0,
          cap: 100n,
          windowMs: 5_000,
          safeReleaseAt: 10_000,
          recoveryReleaseAt: 15_000,
        }),
      );
      if (!reservation.ok) throw new Error("reserve failed");
      await store.transition(
        reservation.reservationId,
        "reserved",
        "signed",
      );

      expect(
        await store.recoverAfterRestart(16_000, 100_000),
      ).toEqual({
        markedUnknown: 1,
        expired: 0,
      });
      expect(await store.get(reservation.reservationId)).toMatchObject({
        status: "unknown",
        windowMs: 5_000,
        recoveryReleaseAt: 110_000,
      });
      expect(
        await store.tryReserve(
          reserveReq({
            amount: 1n,
            now: 16_000,
            cap: 100n,
            windowMs: 100_000,
          }),
        ),
      ).toMatchObject({ ok: false, reason: "cap_exceeded" });
    });

    it("cannot expire another principal before its window expansion", async () => {
      const original = await store.tryReserve(
        reserveReq({
          principalId: "principal-b",
          amount: 100n,
          now: 0,
          cap: 100n,
          windowMs: 5_000,
          safeReleaseAt: 10_000,
          recoveryReleaseAt: 15_000,
        }),
      );
      if (!original.ok) throw new Error("reserve failed");
      await store.transition(
        original.reservationId,
        "reserved",
        "signed",
      );
      await store.transition(
        original.reservationId,
        "signed",
        "unknown",
      );

      expect(
        await store.tryReserve(
          reserveReq({
            principalId: "principal-a",
            amount: 1n,
            now: 16_000,
            cap: 100n,
            windowMs: 100_000,
          }),
        ),
      ).toMatchObject({ ok: true });
      expect(await store.get(original.reservationId)).toMatchObject({
        status: "unknown",
        recoveryReleaseAt: 15_000,
      });
      expect(
        await store.tryReserve(
          reserveReq({
            principalId: "principal-b",
            amount: 100n,
            now: 16_000,
            cap: 100n,
            windowMs: 100_000,
          }),
        ),
      ).toMatchObject({ ok: false, reason: "cap_exceeded" });
      expect(await store.get(original.reservationId)).toMatchObject({
        status: "unknown",
        recoveryReleaseAt: 110_000,
      });
    });

    it("extends both deadlines with signed validBefore", async () => {
      const reservation = await store.tryReserve(
        reserveReq({
          amount: 1n,
          now: 0,
          windowMs: 2_000,
          safeReleaseAt: 10_000,
          recoveryReleaseAt: 12_000,
        }),
      );
      if (!reservation.ok) throw new Error("reserve failed");

      await store.transition(
        reservation.reservationId,
        "reserved",
        "signed",
        { safeReleaseAt: 15_000 },
      );
      expect(await store.get(reservation.reservationId)).toMatchObject({
        safeReleaseAt: 15_000,
        recoveryReleaseAt: 17_000,
      });
    });

    it("keeps each settled row's original longer window", async () => {
      const reservation = await store.tryReserve(
        reserveReq({
          amount: 100n,
          now: 0,
          windowMs: 5_000,
          safeReleaseAt: 10_000,
          recoveryReleaseAt: 15_000,
        }),
      );
      if (!reservation.ok) throw new Error("reserve failed");
      await store.transition(
        reservation.reservationId,
        "reserved",
        "signed",
      );
      await store.transition(
        reservation.reservationId,
        "signed",
        "settled",
        { settledAt: 0 },
      );

      expect(
        await store.committedAmount(
          "principal-1",
          "mandate-1",
          3_000,
          1_000,
        ),
      ).toBe(100n);
      expect(
        await store.committedAmount(
          "principal-1",
          "mandate-1",
          5_001,
          1_000,
        ),
      ).toBe(0n);
    });

    it("applies window expansion immediately", async () => {
      const reservation = await store.tryReserve(
        reserveReq({
          amount: 100n,
          now: 0,
          windowMs: 1_000,
        }),
      );
      if (!reservation.ok) throw new Error("reserve failed");
      await store.transition(
        reservation.reservationId,
        "reserved",
        "signed",
      );
      await store.transition(
        reservation.reservationId,
        "signed",
        "settled",
        { settledAt: 0 },
      );

      expect(
        await store.committedAmount(
          "principal-1",
          "mandate-1",
          3_000,
          5_000,
        ),
      ).toBe(100n);
    });

    it("releases pre-sign aborts immediately", async () => {
      const reservation = await store.tryReserve(
        reserveReq({ amount: 100n, now: 0, cap: 100n }),
      );
      if (!reservation.ok) throw new Error("reserve failed");
      await store.transition(
        reservation.reservationId,
        "reserved",
        "released",
      );
      expect(
        await store.tryReserve(
          reserveReq({ amount: 100n, now: 10, cap: 100n }),
        ),
      ).toMatchObject({ ok: true });
    });

    it("enforces principal aggregate cap across mandates", async () => {
      expect(
        await store.tryReserve(
          reserveReq({
            amount: 100n,
            now: 0,
            mandateId: "m-a",
            cap: 100n,
            aggregateCap: 150n,
          }),
        ),
      ).toMatchObject({ ok: true });
      expect(
        await store.tryReserve(
          reserveReq({
            amount: 100n,
            now: 0,
            mandateId: "m-b",
            cap: 100n,
            aggregateCap: 150n,
          }),
        ),
      ).toMatchObject({
        ok: false,
        reason: "aggregate_cap_exceeded",
      });
    });

    it("enforces per-payee pending limit", async () => {
      const request = {
        amount: 1n,
        now: 0,
        cap: 1_000_000n,
        payTo: "0xsquat",
        perPayeeReservationLimit: 2,
      } as const;
      expect(
        await store.tryReserve(reserveReq(request)),
      ).toMatchObject({ ok: true });
      expect(
        await store.tryReserve(reserveReq(request)),
      ).toMatchObject({ ok: true });
      expect(
        await store.tryReserve(reserveReq(request)),
      ).toMatchObject({ ok: false, reason: "per_payee_limit" });
    });

    it("keeps dedup key until TTL and supports explicit removal", async () => {
      expect(await store.putIfAbsent("k", 1_000, 0)).toBe(true);
      expect(await store.putIfAbsent("k", 1_000, 500)).toBe(false);
      expect(await store.putIfAbsent("k", 1_000, 1_000)).toBe(true);
      await store.removeDedup("k");
      expect(await store.putIfAbsent("k", 1_000, 1_100)).toBe(true);
    });

    it("allows exactly one competing CAS transition", async () => {
      const reservation = await store.tryReserve(
        reserveReq({ amount: 1n, now: 0 }),
      );
      if (!reservation.ok) throw new Error("reserve failed");
      const results = await Promise.all([
        store.transition(
          reservation.reservationId,
          "reserved",
          "released",
        ),
        store.transition(
          reservation.reservationId,
          "reserved",
          "signed",
        ),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("rejects duplicate signed authorization identity", async () => {
      const first = await store.tryReserve(
        reserveReq({ amount: 1n, now: 0, mandateId: "auth-a" }),
      );
      const second = await store.tryReserve(
        reserveReq({ amount: 1n, now: 0, mandateId: "auth-b" }),
      );
      if (!first.ok || !second.ok) throw new Error("reserve failed");
      const authorization = {
        network: "eip155:84532",
        asset: "0xAsset",
        from: "0xPayer",
        nonce: "0xNonce",
        validBefore: 30,
      };
      await store.transition(
        first.reservationId,
        "reserved",
        "signed",
        { authorization },
      );
      await expect(
        store.transition(
          second.reservationId,
          "reserved",
          "signed",
          {
            authorization: {
              ...authorization,
              asset: authorization.asset.toLowerCase(),
              from: authorization.from.toLowerCase(),
              nonce: authorization.nonce.toLowerCase(),
            },
          },
        ),
      ).rejects.toThrow(/duplicate|unique/i);
      expect((await store.get(second.reservationId))?.status).toBe(
        "reserved",
      );
    });

    it("counts future-dated settlement conservatively", async () => {
      const reservation = await store.tryReserve(
        reserveReq({ amount: 100n, now: 0 }),
      );
      if (!reservation.ok) throw new Error("reserve failed");
      await store.transition(
        reservation.reservationId,
        "reserved",
        "signed",
      );
      await store.transition(
        reservation.reservationId,
        "signed",
        "settled",
        { settledAt: 100_000 },
      );
      expect(
        await store.committedAmount(
          "principal-1",
          "mandate-1",
          96_000,
          60_000,
        ),
      ).toBe(100n);
    });
  });
}
