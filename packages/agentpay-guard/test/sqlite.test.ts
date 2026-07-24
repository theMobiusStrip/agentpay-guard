import { DatabaseSync } from "node:sqlite";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ReservationStatus } from "../src/types.js";
import type {
  AtomicStore,
  ReserveRequest,
  TransitionOptions,
} from "../src/store/types.js";
import {
  runAtomicStoreContract,
  type StoreHarness,
} from "./store-contract.js";
import { reserveReq } from "./helpers.js";
import {
  openSqliteStore,
  type SqliteAtomicStore,
} from "../src/store/sqlite/index.js";

const cleanupDirs = new Set<string>();
const workerChildren = new Set<ChildProcess>();

function tempDatabase(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "agentpay-sqlite-"));
  cleanupDirs.add(dir);
  return { dir, path: join(dir, "state.sqlite") };
}

afterEach(async () => {
  for (const child of workerChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
  workerChildren.clear();
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  cleanupDirs.clear();
});

interface WorkerMessage {
  kind: "ready" | "result" | "error";
  ok?: boolean;
  error?: string;
}

function waitForWorkerMessage(
  child: ChildProcess,
  kind: WorkerMessage["kind"],
): Promise<WorkerMessage> {
  return new Promise<WorkerMessage>((resolveMessage, rejectMessage) => {
    const onMessage = (message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("kind" in message) ||
        (message as { kind?: unknown }).kind !== kind
      ) {
        return;
      }
      cleanup();
      resolveMessage(message as WorkerMessage);
    };
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => {
      cleanup();
      rejectMessage(
        new Error(
          `SQLite worker exited before ${kind}: ${String(code)}/${String(signal)}`,
        ),
      );
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

async function startWorker(path: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      join(import.meta.dirname, "sqlite-worker.ts"),
      path,
    ],
    {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  workerChildren.add(child);
  await waitForWorkerMessage(child, "ready");
  return child;
}

class AlternatingStore implements AtomicStore {
  private nextIndex = 0;

  constructor(private readonly stores: readonly AtomicStore[]) {}

  private next(): AtomicStore {
    const store = this.stores[this.nextIndex % this.stores.length];
    this.nextIndex++;
    if (store === undefined) throw new Error("no SQLite connection");
    return store;
  }

  tryReserve(request: ReserveRequest) {
    return this.next().tryReserve(request);
  }

  transition(
    reservationId: string,
    from: ReservationStatus,
    to: ReservationStatus,
    options?: TransitionOptions,
  ) {
    return this.next().transition(
      reservationId,
      from,
      to,
      options,
    );
  }

  putIfAbsent(key: string, ttlMs: number, now: number) {
    return this.next().putIfAbsent(key, ttlMs, now);
  }

  removeDedup(key: string) {
    return this.next().removeDedup(key);
  }

  releaseExpired(now: number, requestedWindowMs: number) {
    return this.next().releaseExpired(now, requestedWindowMs);
  }

  recoverAfterRestart(now: number, requestedWindowMs: number) {
    return this.next().recoverAfterRestart(now, requestedWindowMs);
  }

  get(reservationId: string) {
    return this.next().get(reservationId);
  }

  committedAmount(
    principalId: string,
    mandateId: string,
    now: number,
    windowMs: number,
  ) {
    return this.next().committedAmount(
      principalId,
      mandateId,
      now,
      windowMs,
    );
  }
}

async function sqliteHarness(
  connectionCount: number,
): Promise<StoreHarness> {
  const { path } = tempDatabase();
  const stores: SqliteAtomicStore[] = [];
  for (let i = 0; i < connectionCount; i++) {
    stores.push(
      await openSqliteStore(path, {
        busyTimeoutMs: 20,
        busyRetries: 1,
        retryJitterMs: 0,
        metadataNow: () => 0,
      }),
    );
  }
  const first = stores[0];
  if (first === undefined) throw new Error("SQLite store missing");
  return {
    store:
      stores.length === 1
        ? first
        : new AlternatingStore(stores),
    close: async () => {
      for (const store of stores) await store.close();
    },
  };
}

runAtomicStoreContract(
  "G1: SQLite atomic store",
  () => sqliteHarness(1),
);

runAtomicStoreContract(
  "G1: SQLite two-connection atomic store",
  () => sqliteHarness(2),
);

describe("SQLite persistence and recovery", () => {
  it("keeps cap reservation across close and reopen", async () => {
    const { path } = tempDatabase();
    const first = await openSqliteStore(path);
    expect(
      await first.tryReserve(
        reserveReq({ amount: 100n, now: 0, cap: 100n }),
      ),
    ).toMatchObject({ ok: true });
    await first.close();

    const second = await openSqliteStore(path);
    expect(await second.recoverAfterRestart(1_000, 60_000)).toEqual({
      markedUnknown: 1,
      expired: 0,
    });
    expect(
      await second.tryReserve(
        reserveReq({ amount: 1n, now: 1_000, cap: 100n }),
      ),
    ).toMatchObject({ ok: false, reason: "cap_exceeded" });
    await second.close();
  });

  it("keeps settled spend in-window, then ages it out", async () => {
    const { path } = tempDatabase();
    const first = await openSqliteStore(path);
    const reservation = await first.tryReserve(
      reserveReq({
        amount: 100n,
        now: 0,
        cap: 100n,
        windowMs: 1_000,
      }),
    );
    if (!reservation.ok) throw new Error("reserve failed");
    await first.transition(
      reservation.reservationId,
      "reserved",
      "signed",
    );
    await first.transition(
      reservation.reservationId,
      "signed",
      "settled",
      { settledAt: 500 },
    );
    await first.close();

    const second = await openSqliteStore(path);
    expect(
      await second.committedAmount(
        "principal-1",
        "mandate-1",
        1_000,
        1_000,
      ),
    ).toBe(100n);
    expect(
      await second.committedAmount(
        "principal-1",
        "mandate-1",
        1_501,
        1_000,
      ),
    ).toBe(0n);
    await second.close();
  });

  it("keeps dedup key across reopen until TTL", async () => {
    const { path } = tempDatabase();
    const first = await openSqliteStore(path);
    expect(await first.putIfAbsent("intent-1", 1_000, 0)).toBe(true);
    await first.close();

    const second = await openSqliteStore(path);
    expect(await second.putIfAbsent("intent-1", 1_000, 999)).toBe(false);
    expect(await second.putIfAbsent("intent-1", 1_000, 1_000)).toBe(true);
    await second.close();
  });

  it("globally prunes expired dedup rows", async () => {
    const { path } = tempDatabase();
    const store = await openSqliteStore(path);
    await store.putIfAbsent("expired-intent", 100, 0);
    await store.putIfAbsent("live-intent", 1_000, 0);

    await store.releaseExpired(100, 60_000);
    await store.close();

    const raw = new DatabaseSync(path);
    const row = raw
      .prepare("SELECT COUNT(*) AS count FROM dedup")
      .get();
    raw.close();
    expect(row?.["count"]).toBe(1);
  });

  it("retains terminal audit state for 24 hours, then prunes it", async () => {
    const { path } = tempDatabase();
    const store = await openSqliteStore(path);
    const reservation = await store.tryReserve(
      reserveReq({
        amount: 1n,
        now: 0,
        safeReleaseAt: 1_000,
        recoveryReleaseAt: 61_000,
      }),
    );
    if (!reservation.ok) throw new Error("reserve failed");

    expect(await store.releaseExpired(1_000, 60_000)).toBe(1);
    expect(await store.get(reservation.reservationId)).toMatchObject({
      status: "expired",
    });
    expect(
      await store.releaseExpired(1_000 + 86_400_000, 60_000),
    ).toBe(0);
    expect(await store.get(reservation.reservationId)).toBeUndefined();
    await store.close();
  });

  it("prunes settled rows only after the configured maximum window", async () => {
    const { path } = tempDatabase();
    const store = await openSqliteStore(path, {
      maxAccountingWindowMs: 5_000,
    });
    const reservation = await store.tryReserve(
      reserveReq({ amount: 7n, now: 0, windowMs: 1_000 }),
    );
    if (!reservation.ok) throw new Error("reserve failed");
    await store.transition(
      reservation.reservationId,
      "reserved",
      "settled",
      { settledAt: 100, now: 100 },
    );

    await store.releaseExpired(5_099, 5_000);
    expect(await store.get(reservation.reservationId)).toBeDefined();
    await store.releaseExpired(5_100, 5_000);
    expect(await store.get(reservation.reservationId)).toBeUndefined();
    await expect(
      store.committedAmount(
        "principal-1",
        "mandate-1",
        5_100,
        5_001,
      ),
    ).rejects.toThrow(/exceeds SQLite max accounting window/);
    await store.close();
  });

  it("persists one immutable maximum accounting window", async () => {
    const { path } = tempDatabase();
    const first = await openSqliteStore(path, {
      maxAccountingWindowMs: 5_000,
    });
    await first.close();

    const second = await openSqliteStore(path, {
      maxAccountingWindowMs: 5_000,
    });
    await second.close();
    const contracted = await openSqliteStore(path, {
      maxAccountingWindowMs: 4_000,
    });
    await contracted.close();
    await expect(
      openSqliteStore(path, { maxAccountingWindowMs: 6_000 }),
    ).rejects.toThrow(/is 5000; requested window ceiling 6000/);
  });

  it("enforces a maximum configured by another live connection", async () => {
    const { path } = tempDatabase();
    const openedBeforeMaximum = await openSqliteStore(path);
    const configured = await openSqliteStore(path, {
      maxAccountingWindowMs: 5_000,
    });

    await expect(
      openedBeforeMaximum.tryReserve(
        reserveReq({ amount: 1n, now: 0, windowMs: 5_001 }),
      ),
    ).rejects.toThrow(/exceeds SQLite max accounting window/);
    await configured.close();
    await openedBeforeMaximum.close();
  });

  it("keeps older rows whose own window exceeds a later maximum", async () => {
    const { path } = tempDatabase();
    const first = await openSqliteStore(path);
    const reservation = await first.tryReserve(
      reserveReq({ amount: 7n, now: 0, windowMs: 10_000 }),
    );
    if (!reservation.ok) throw new Error("reserve failed");
    await first.transition(
      reservation.reservationId,
      "reserved",
      "settled",
      { settledAt: 100, now: 100 },
    );
    await first.close();

    const second = await openSqliteStore(path, {
      maxAccountingWindowMs: 5_000,
    });
    await second.releaseExpired(5_100, 5_000);
    expect(
      await second.committedAmount(
        "principal-1",
        "mandate-1",
        5_100,
        5_000,
      ),
    ).toBe(7n);
    await second.releaseExpired(10_100, 5_000);
    expect(await second.get(reservation.reservationId)).toBeUndefined();
    await second.close();
  });

  it("recovers signed row as unknown through full recovery window", async () => {
    const { path } = tempDatabase();
    const first = await openSqliteStore(path);
    const reservation = await first.tryReserve(
      reserveReq({
        amount: 100n,
        now: 0,
        cap: 100n,
        windowMs: 1_000,
        safeReleaseAt: 10_000,
        recoveryReleaseAt: 11_000,
      }),
    );
    if (!reservation.ok) throw new Error("reserve failed");
    await first.transition(
      reservation.reservationId,
      "reserved",
      "signed",
    );
    await first.close();

    const second = await openSqliteStore(path);
    expect(await second.recoverAfterRestart(10_999, 1_000)).toEqual({
      markedUnknown: 1,
      expired: 0,
    });
    expect(
      (await second.get(reservation.reservationId))?.status,
    ).toBe("unknown");
    expect(await second.releaseExpired(11_000, 1_000)).toBe(1);
    await second.close();
  });

  it("extends recovered deadline before expiring under a longer window", async () => {
    const { path } = tempDatabase();
    const first = await openSqliteStore(path);
    const reservation = await first.tryReserve(
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
    await first.transition(
      reservation.reservationId,
      "reserved",
      "signed",
    );
    await first.close();

    const second = await openSqliteStore(path);
    expect(
      await second.recoverAfterRestart(16_000, 100_000),
    ).toEqual({
      markedUnknown: 1,
      expired: 0,
    });
    expect(await second.get(reservation.reservationId)).toMatchObject({
      status: "unknown",
      windowMs: 5_000,
      recoveryReleaseAt: 110_000,
    });
    expect(
      await second.tryReserve(
        reserveReq({
          amount: 1n,
          now: 16_000,
          cap: 100n,
          windowMs: 100_000,
        }),
      ),
    ).toMatchObject({ ok: false, reason: "cap_exceeded" });
    await second.close();
  });

  it("does not forget last-instant settlement before full window passes", async () => {
    const { path } = tempDatabase();
    const first = await openSqliteStore(path);
    const reservation = await first.tryReserve(
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
    await first.transition(
      reservation.reservationId,
      "reserved",
      "signed",
    );
    await first.close();

    const second = await openSqliteStore(path);
    await second.recoverAfterRestart(14_999, 5_000);
    expect(
      await second.tryReserve(
        reserveReq({
          amount: 1n,
          now: 14_999,
          cap: 100n,
          windowMs: 5_000,
        }),
      ),
    ).toMatchObject({ ok: false, reason: "cap_exceeded" });
    expect(await second.releaseExpired(15_000, 5_000)).toBe(1);
    await second.close();
  });

  it("persists signed deadline extension and authorization reference", async () => {
    const { path } = tempDatabase();
    const first = await openSqliteStore(path);
    const reservation = await first.tryReserve(
      reserveReq({
        amount: 1n,
        now: 0,
        windowMs: 2_000,
        safeReleaseAt: 10_000,
        recoveryReleaseAt: 12_000,
      }),
    );
    if (!reservation.ok) throw new Error("reserve failed");
    await first.transition(
      reservation.reservationId,
      "reserved",
      "signed",
      {
        safeReleaseAt: 15_000,
        authorization: {
          network: "eip155:84532",
          asset: "0xasset",
          from: "0xpayer",
          nonce: "0xnonce",
          validBefore: 15,
        },
      },
    );
    await first.close();

    const second = await openSqliteStore(path);
    expect(await second.get(reservation.reservationId)).toMatchObject({
      safeReleaseAt: 15_000,
      recoveryReleaseAt: 17_000,
      authorization: {
        network: "eip155:84532",
        asset: "0xasset",
        from: "0xpayer",
        nonce: "0xnonce",
        validBefore: 15,
      },
    });
    await second.close();
  });

  it("keeps old longer window after config contraction and reopen", async () => {
    const { path } = tempDatabase();
    const first = await openSqliteStore(path);
    const reservation = await first.tryReserve(
      reserveReq({
        amount: 100n,
        now: 0,
        windowMs: 5_000,
      }),
    );
    if (!reservation.ok) throw new Error("reserve failed");
    await first.transition(
      reservation.reservationId,
      "reserved",
      "signed",
    );
    await first.transition(
      reservation.reservationId,
      "signed",
      "settled",
      { settledAt: 0 },
    );
    await first.close();

    const second = await openSqliteStore(path);
    expect(
      await second.committedAmount(
        "principal-1",
        "mandate-1",
        3_000,
        1_000,
      ),
    ).toBe(100n);
    await second.close();
  });

  it("rejects duplicate payer-signed authorization reference", async () => {
    const { path } = tempDatabase();
    const store = await openSqliteStore(path);
    const a = await store.tryReserve(
      reserveReq({ amount: 1n, now: 0, mandateId: "a" }),
    );
    const b = await store.tryReserve(
      reserveReq({ amount: 1n, now: 0, mandateId: "b" }),
    );
    if (!a.ok || !b.ok) throw new Error("reserve failed");
    const authorization = {
      network: "eip155:84532",
      asset: "0xAsset",
      from: "0xPayer",
      nonce: "0xSame",
      validBefore: 30,
    };
    await store.transition(a.reservationId, "reserved", "signed", {
      authorization,
    });
    await expect(
      store.transition(b.reservationId, "reserved", "signed", {
        authorization: {
          ...authorization,
          asset: authorization.asset.toLowerCase(),
          from: authorization.from.toLowerCase(),
          nonce: authorization.nonce.toLowerCase(),
        },
      }),
    ).rejects.toThrow();
    expect((await store.get(b.reservationId))?.status).toBe("reserved");
    await store.close();
  });

  it("stores dedup digest, never plaintext key", async () => {
    const { path } = tempDatabase();
    const store = await openSqliteStore(path);
    const key = "private-intent-id-never-plaintext";
    await store.putIfAbsent(key, 1_000, 0);
    await store.close();

    expect(readFileSync(path).includes(Buffer.from(key))).toBe(false);
  });

  it("creates database with mode 0600", async () => {
    const { path } = tempDatabase();
    const store = await openSqliteStore(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await store.close();
  });
});

describe("SQLite process concurrency", () => {
  it(
    "cannot race independent processes past cap",
    async () => {
      const { path } = tempDatabase();
      const initialized = await openSqliteStore(path);
      await initialized.close();

      const workers: ChildProcess[] = [];
      for (let i = 0; i < 12; i++) {
        workers.push(await startWorker(path));
      }
      const results = workers.map((worker) =>
        waitForWorkerMessage(worker, "result"),
      );
      const exits = workers.map((worker) => once(worker, "exit"));
      for (const worker of workers) worker.send("reserve");
      const messages = await Promise.all(results);
      expect(messages.filter((message) => message.ok)).toHaveLength(5);
      await Promise.all(exits);
      for (const worker of workers) workerChildren.delete(worker);

      const verifier = await openSqliteStore(path);
      expect(
        await verifier.committedAmount(
          "worker-principal",
          "worker-mandate",
          1_000,
          60_000,
        ),
      ).toBe(50n);
      await verifier.close();
    },
    20_000,
  );
});

describe("SQLite startup faults and migrations", () => {
  it("migrates version 1 in place without losing rows", async () => {
    const { path } = tempDatabase();
    const first = await openSqliteStore(path);
    const reservation = await first.tryReserve(
      reserveReq({ amount: 7n, now: 0 }),
    );
    if (!reservation.ok) throw new Error("reserve failed");
    await first.close();

    const raw = new DatabaseSync(path);
    raw.exec(`
      DROP INDEX reservations_settled_at;
      DROP INDEX reservations_terminal_updated;
      DROP INDEX dedup_expires;
      ALTER TABLE schema_meta DROP COLUMN max_accounting_window_ms;
      UPDATE schema_meta SET schema_version = 1;
    `);
    raw.close();

    const second = await openSqliteStore(path, {
      maxAccountingWindowMs: 60_000,
      metadataNow: () => 123,
    });
    expect(
      (await second.get(reservation.reservationId))?.amount,
    ).toBe(7n);
    await second.close();

    const verifier = new DatabaseSync(path);
    const meta = verifier
      .prepare(
        `SELECT
           schema_version,
           migrated_at_ms,
           max_accounting_window_ms
         FROM schema_meta`,
      )
      .get();
    verifier.close();
    expect(meta).toMatchObject({
      schema_version: 2,
      migrated_at_ms: 123,
      max_accounting_window_ms: 60_000,
    });
  });

  it("fails when database remains locked beyond retry bound", async () => {
    const { path } = tempDatabase();
    const first = await openSqliteStore(path);
    const second = await openSqliteStore(path, {
      busyTimeoutMs: 1,
      busyRetries: 0,
      retryJitterMs: 0,
    });
    const locker = new DatabaseSync(path);
    locker.exec("PRAGMA busy_timeout = 1");
    locker.exec("BEGIN IMMEDIATE");
    try {
      await expect(
        second.tryReserve(reserveReq({ amount: 1n, now: 0 })),
      ).rejects.toThrow(/locked|busy/i);
    } finally {
      locker.exec("ROLLBACK");
      locker.close();
      await second.close();
      await first.close();
    }
  });

  it("rejects corrupt database", async () => {
    const { path } = tempDatabase();
    writeFileSync(path, "not a sqlite database", { mode: 0o600 });
    await expect(openSqliteStore(path)).rejects.toThrow();
  });

  it("rejects read-only database", async () => {
    const { path } = tempDatabase();
    const store = await openSqliteStore(path);
    await store.close();
    chmodSync(path, 0o400);
    try {
      await expect(openSqliteStore(path)).rejects.toThrow(
        /owner-writable/,
      );
    } finally {
      chmodSync(path, 0o600);
    }
  });

  it("rejects unreadable database", async () => {
    const { path } = tempDatabase();
    const store = await openSqliteStore(path);
    await store.close();
    chmodSync(path, 0o200);
    try {
      await expect(openSqliteStore(path)).rejects.toThrow();
    } finally {
      chmodSync(path, 0o600);
    }
  });

  it("rejects directory and unwritable paths", async () => {
    const { dir } = tempDatabase();
    await expect(openSqliteStore(dir)).rejects.toThrow(/regular file/);
    await expect(
      openSqliteStore(join(dir, "missing", "state.sqlite")),
    ).rejects.toThrow();
    const unwritable = join(dir, "unwritable");
    mkdirSync(unwritable, { mode: 0o500 });
    try {
      await expect(
        openSqliteStore(join(unwritable, "state.sqlite")),
      ).rejects.toThrow();
    } finally {
      chmodSync(unwritable, 0o700);
    }
  });

  it("rejects unknown database schema", async () => {
    const { path } = tempDatabase();
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE foreign_state (id TEXT PRIMARY KEY) STRICT");
    raw.close();
    await expect(openSqliteStore(path)).rejects.toThrow(
      /schema_meta missing/,
    );
  });

  it("rejects newer schema version", async () => {
    const { path } = tempDatabase();
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE schema_meta (
        singleton INTEGER PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        migrated_at_ms INTEGER NOT NULL
      ) STRICT;
      INSERT INTO schema_meta VALUES (1, 999, 0, 0);
    `);
    raw.close();
    await expect(openSqliteStore(path)).rejects.toThrow(
      /newer than supported/,
    );
  });

  it("rejects malformed current-version schema", async () => {
    const { path } = tempDatabase();
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE schema_meta (
        singleton INTEGER PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        migrated_at_ms INTEGER NOT NULL
      ) STRICT;
      INSERT INTO schema_meta VALUES (1, 1, 0, 0);
      CREATE TABLE reservations (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE dedup (key_digest BLOB PRIMARY KEY) STRICT;
    `);
    raw.close();
    await expect(openSqliteStore(path)).rejects.toThrow(
      /schema/,
    );
  });

  it("rejects current schema missing authorization uniqueness", async () => {
    const { path } = tempDatabase();
    const first = await openSqliteStore(path);
    await first.close();
    const raw = new DatabaseSync(path);
    raw.exec("DROP INDEX reservations_authorization");
    raw.close();
    await expect(openSqliteStore(path)).rejects.toThrow(
      /authorization.*missing/,
    );
  });

  it("rejects case-sensitive authorization uniqueness", async () => {
    const { path } = tempDatabase();
    const first = await openSqliteStore(path);
    await first.close();
    const raw = new DatabaseSync(path);
    raw.exec(`
      DROP INDEX reservations_authorization;
      CREATE UNIQUE INDEX reservations_authorization
        ON reservations (asset, payer, authorization_nonce)
        WHERE authorization_nonce IS NOT NULL;
    `);
    raw.close();
    await expect(openSqliteStore(path)).rejects.toThrow(
      /collation differs/,
    );
  });

  it("reopens current schema idempotently without losing rows", async () => {
    const { path } = tempDatabase();
    const first = await openSqliteStore(path);
    const reservation = await first.tryReserve(
      reserveReq({ amount: 7n, now: 0 }),
    );
    if (!reservation.ok) throw new Error("reserve failed");
    await first.close();

    const second = await openSqliteStore(path);
    expect(
      (await second.get(reservation.reservationId))?.amount,
    ).toBe(7n);
    await second.close();
  });

  it("rejects URI and in-memory paths", async () => {
    await expect(openSqliteStore(":memory:")).rejects.toThrow(
      /local file path/,
    );
    await expect(openSqliteStore("file:state.sqlite")).rejects.toThrow(
      /local file path/,
    );
  });
});
