import type { ResultRow } from "./scenario.js";

function usd(atomic: bigint): string {
  const neg = atomic < 0n;
  const a = neg ? -atomic : atomic;
  const whole = a / 1_000_000n;
  const frac = (a % 1_000_000n).toString().padStart(6, "0");
  return `${neg ? "-" : ""}$${whole}.${frac}`;
}

/** JSON-serializable view (bigint -> string). */
export function toJSON(rows: ResultRow[]): unknown {
  return rows.map((r) => ({
    ...r,
    metrics: {
      ...r.metrics,
      unauthorizedPayerOutflow: r.metrics.unauthorizedPayerOutflow.toString(),
      paidWithoutService: r.metrics.paidWithoutService.toString(),
      unpaidServiceCost: r.metrics.unpaidServiceCost.toString(),
    },
  }));
}

export function markdownReport(rows: ResultRow[]): string {
  const adversarial = rows.filter((r) => !r.fixtureId.startsWith("benign"));
  const benign = rows.filter((r) => r.fixtureId.startsWith("benign"));

  const lines: string[] = [];
  lines.push("# DrainBench results (deterministic lane)\n");
  lines.push(
    "Arm A = a native cumulative spending-limit counter backed by an **async store** " +
      "(read-then-write, no transaction) — the realistic multi-worker baseline; the x402 " +
      "docs ship only an abort stub, so this counter is an honest model, not a verbatim " +
      "snippet (see `bench/arm-a/native-hook.ts`). Arm B = native + agentpay-guard. Same " +
      "nominal cap + window. Deterministic fixtures, N=1, conformance pass/fail. All figures " +
      "from the settlement ledger + delivery log — never self-report. `simulated` where a " +
      "public testnet cannot produce the class (§3).\n",
  );
  lines.push(
    "> **Atomicity is conditional (honest caveat):** a *synchronous single-process* counter " +
      "does NOT overspend (JS run-to-completion). The retry-storm/squat delta appears only " +
      "against an async/shared store — which is exactly the multi-worker deployment the guard " +
      "targets. See the atomicity-conditionality table below.\n",
  );
  lines.push(
    "> **Replay is the SERVER-side middleware** (`x402-idempotency-middleware`, a separate " +
      "package the merchant installs), NOT the payer-side client guard. Listed under Arm B " +
      "as the with-middleware server config.\n",
  );

  // Adversarial: one row per fixture, columns for each arm/profile's headline harm.
  lines.push("## Adversarial — headline harm per arm\n");
  lines.push(
    "| Fixture | Class | Arm A (native async counter) | Arm B budget-only | Arm B mandate-required |",
  );
  lines.push("|---|---|---|---|---|");
  const byFixture = new Map<string, ResultRow[]>();
  for (const r of adversarial) {
    const g = byFixture.get(r.fixtureId) ?? [];
    g.push(r);
    byFixture.set(r.fixtureId, g);
  }
  for (const [fid, group] of byFixture) {
    const a = group.find((r) => r.arm === "native");
    const bBudget = group.find((r) => r.arm === "native+guard" && r.profile === "budget-only");
    const bMandate = group.find((r) => r.arm === "native+guard" && r.profile === "mandate-required");
    const cell = (r?: ResultRow) => (r ? headlineHarm(r) : "—");
    const klass = group[0]?.klass ?? "";
    lines.push(`| \`${fid}\` | ${klass} | ${cell(a)} | ${cell(bBudget)} | ${cell(bMandate)} |`);
  }

  lines.push("\n### Headline harm = the metric each class targets\n");
  lines.push(
    "- payTo-tamper / bait-and-switch / retry-storm → `unauthorized_payer_outflow`\n" +
      "- protocol-replay → `unpaid_service_cost` (merchant victim)\n" +
      "- preemption-withhold → `paid_without_service`\n" +
      "- reservation-squat → settled-to-attacker (availability bound)\n",
  );

  // Benign conformance gate.
  const benignBlocks = benign.filter((r) => r.metrics.benignFalseBlock > 0);
  lines.push("\n## Benign corpus — conformance gate (§4.8)\n");
  lines.push(
    `${benign.length} benign cells run (arm B, both profiles). Blocks: **${benignBlocks.length}** ` +
      `(gate = 0). ${benignBlocks.length === 0 ? "PASS — zero false blocks." : "FAIL:"}\n`,
  );
  for (const r of benignBlocks) {
    lines.push(`- FALSE BLOCK: \`${r.fixtureId}\` (${r.profile}) — ${r.note}`);
  }

  // Overhead — measured on arm B (the guarded create path) only.
  const lat = rows
    .filter((r) => r.arm === "native+guard")
    .map((r) => r.metrics.hookLatencyMsP99)
    .filter((x) => x > 0);
  const p99 = lat.length ? Math.max(...lat) : 0;
  lines.push("\n## Overhead (arm B create path)\n");
  lines.push(
    `- p99 ≈ ${p99.toFixed(3)} ms per attempt. This is **create-path wall time** (dominated ` +
      `by EIP-712 signing), an **upper bound** on the guard's own reserve round-trip — the ` +
      `in-memory store ops are sub-ms. Measured on the identical code path for both arms.\n`,
  );

  return lines.join("\n");

  function headlineHarm(r: ResultRow): string {
    const m = r.metrics;
    if (r.fixtureId === "protocol-replay") return `${m.grants} grants / 1 pay → unpaid ${usd(m.unpaidServiceCost)} (server-side)`;
    if (r.fixtureId === "preemption-withhold") return `paid-no-service ${usd(m.paidWithoutService)}`;
    if (r.fixtureId === "reservation-squat") return `${usd(m.unauthorizedPayerOutflow)} to attacker (${m.settledCount} settled)`;
    return `${usd(m.unauthorizedPayerOutflow)}${m.blocked ? ` (${m.blocked} blocked)` : ""}`;
  }
}
