import { openSqliteStore } from "../src/store/sqlite/index.js";

const path = process.argv[2];
if (path === undefined) throw new Error("database path missing");

const store = await openSqliteStore(path, {
  busyTimeoutMs: 1_000,
  busyRetries: 5,
  retryJitterMs: 10,
});

process.send?.({ kind: "ready" });

process.once("message", (message) => {
  if (message !== "reserve") return;
  void (async () => {
    try {
      const result = await store.tryReserve({
        principalId: "worker-principal",
        mandateId: "worker-mandate",
        amount: 10n,
        payTo: "0xworker-payee",
        now: 1_000,
        windowMs: 60_000,
        cap: 50n,
        safeReleaseAt: 1_000_000,
        recoveryReleaseAt: 1_060_000,
      });
      process.send?.({
        kind: "result",
        ok: result.ok,
        ...(!result.ok ? { reason: result.reason } : {}),
      });
    } catch (error) {
      process.send?.({
        kind: "error",
        error: error instanceof Error ? error.message : "unknown error",
      });
    } finally {
      await store.close();
    }
  })();
});
