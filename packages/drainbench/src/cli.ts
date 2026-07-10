/**
 * DrainBench CLI — runs every fixture × arm × profile deterministically and
 * writes the results bundle. Offline: uses local signing + the mock settlement
 * ledger. Run: npm run -w @agentpay-guard/drainbench bench
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ArmConfig } from "./arms.js";
import { adversarialFixtures, benignFixtures } from "./fixtures.js";
import { runFixture } from "./runner.js";
import { markdownReport, toJSON } from "./report.js";
import { preemptionScenario, reorgScenario } from "./simlane.js";
import type { Fixture, ResultRow } from "./scenario.js";
import type { PolicyProfile } from "agentpay-guard";

const DEFAULT_CAP = 1_000_000n;
const DEFAULT_WINDOW = 60_000;

function cfgFor(fixture: Fixture): ArmConfig {
  const c: ArmConfig = {
    cap: fixture.cfg?.cap !== undefined ? BigInt(fixture.cfg.cap) : DEFAULT_CAP,
    windowMs: fixture.cfg?.windowMs ?? DEFAULT_WINDOW,
  };
  if (fixture.cfg?.aggregateCap !== undefined) c.aggregateCap = BigInt(fixture.cfg.aggregateCap);
  if (fixture.cfg?.perPayeeReservationLimit !== undefined)
    c.perPayeeReservationLimit = fixture.cfg.perPayeeReservationLimit;
  return c;
}

function passOf(fixtureId: string, m: ResultRow["metrics"], benign: boolean): boolean {
  if (benign) return m.benignFalseBlock === 0;
  return (
    m.unauthorizedPayerOutflow === 0n &&
    m.unpaidServiceCost === 0n &&
    m.paidWithoutService === 0n
  );
}

async function main() {
  const fixtures = [...adversarialFixtures, ...benignFixtures()];
  const profiles: PolicyProfile[] = ["budget-only", "mandate-required"];
  const rows: ResultRow[] = [];

  for (const fixture of fixtures) {
    const cfg = cfgFor(fixture);
    const allowedProfiles = fixture.profiles ?? profiles;

    // Arm A (native): profile-agnostic — run once. (Replay/squat handled inside.)
    {
      const { metrics, note } = await runFixture(fixture, "native", "budget-only", cfg);
      rows.push({
        fixtureId: fixture.id,
        klass: fixture.klass,
        arm: "native",
        profile: "n/a",
        metrics,
        pass: passOf(fixture.id, metrics, fixture.benign),
        note,
      });
    }

    // Arm B (native + guard): per profile.
    for (const profile of profiles) {
      if (!allowedProfiles.includes(profile)) continue;
      const { metrics, note } = await runFixture(fixture, "native+guard", profile, cfg);
      rows.push({
        fixtureId: fixture.id,
        klass: fixture.klass,
        arm: "native+guard",
        profile,
        metrics,
        pass: passOf(fixture.id, metrics, fixture.benign),
        note,
      });
    }
  }

  // Atomicity-conditionality: the concurrency-sensitive fixtures under a
  // synchronous single-process counter (no overspend) vs an async-store counter
  // (overspends) vs the guard — so the delta's precondition is explicit.
  const condLines: string[] = [
    "\n## Atomicity is conditional on a shared/async store (fairness disclosure)\n",
    "| Fixture | Arm A sync (single-process) | Arm A async (shared store) | Arm B (guard) |",
    "|---|---|---|---|",
  ];
  for (const id of ["retry-storm", "reservation-squat"]) {
    const f = fixtures.find((x) => x.id === id)!;
    const c = cfgFor(f);
    const sync = await runFixture(f, "native", "budget-only", c, "sync");
    const async = await runFixture(f, "native", "budget-only", c, "async");
    const guard = await runFixture(f, "native+guard", "budget-only", c);
    const cell = (r: { metrics: { settledCount: number } }) => `${r.metrics.settledCount} settled`;
    condLines.push(`| \`${id}\` | ${cell(sync)} | ${cell(async)} | ${cell(guard)} |`);
  }
  condLines.push(
    "\nA synchronous in-memory counter ties the guard (JS run-to-completion serializes it) " +
      "but is single-process-only; the guard's atomic reserve-before-sign is what makes the " +
      "SAME budget correct across the async/shared store a multi-worker deployment needs.\n",
  );

  // Simulated-chain lane (Tier-B classes Base Sepolia cannot produce, §3/§8).
  const reorg = reorgScenario();
  const preempt = preemptionScenario();
  const usd = (a: bigint) => `$${(Number(a) / 1e6).toFixed(6)}`;
  const simMd = [
    "\n## Simulated-chain lane (labeled *simulated* — not producible on Base Sepolia)\n",
    "| Scenario | Defense | unpaid_service_cost |",
    "|---|---|---|",
    ...reorg.map((r) => `| ${r.scenario} | ${r.defense} | ${usd(r.unpaidServiceCost)} — ${r.note} |`),
    "",
    `**Preemption exposure window:** merchant-suggested ${preempt.merchantSuggestedSeconds}s → ` +
      `clamped ${preempt.clampedSeconds}s. ${preempt.note}`,
    "",
  ].join("\n");

  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..", "..", "..");
  const outDir = join(repoRoot, "bench", "results");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "drainbench-results.json"), JSON.stringify(toJSON(rows), null, 2));
  const md = markdownReport(rows) + condLines.join("\n") + simMd;
  writeFileSync(join(outDir, "drainbench-report.md"), md);

  console.log(md);
  console.log(`\nWrote ${rows.length} result rows to ${outDir}`);
}

main().catch((e) => {
  console.error("bench failed:", e);
  process.exit(1);
});
