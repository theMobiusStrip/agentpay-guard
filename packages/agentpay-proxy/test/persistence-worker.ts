import { openSqliteStore } from "@themobiusstrip/agentpay-guard/sqlite";

const [stateDb, principalId, dedupKey, nowRaw] = process.argv.slice(2);
if (
  stateDb === undefined ||
  principalId === undefined ||
  dedupKey === undefined ||
  nowRaw === undefined
) {
  throw new Error("seed worker arguments missing");
}
const now = Number(nowRaw);
if (!Number.isSafeInteger(now)) throw new Error("seed time invalid");

const store = await openSqliteStore(stateDb);
const reservation = await store.tryReserve({
  principalId,
  mandateId: "__no_mandate__",
  amount: 100_000n,
  payTo: "0xseed",
  now,
  windowMs: 300_000,
  cap: 100_000n,
  safeReleaseAt: now + 60_000,
  recoveryReleaseAt: now + 360_000,
});
if (!reservation.ok) throw new Error("seed reserve failed");
if (!(await store.putIfAbsent(dedupKey, 360_000, now))) {
  throw new Error("seed dedup failed");
}
process.send?.({ kind: "seeded" });

// Parent kills process abruptly. No close/checkpoint path.
setInterval(() => {}, 60_000);
