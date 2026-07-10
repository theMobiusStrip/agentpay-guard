# DrainBench reproducibility bundle

One-command, offline, deterministic. Everything needed to reproduce the A/B is in
this repo — no chain funds, no API key, no anvil.

```bash
npm ci && npm run build
npm run -w @agentpay-guard/drainbench bench        # writes bench/results/*
npm run -w @agentpay-guard/drainbench agent-demo   # stochastic demonstration
npx vitest run packages/drainbench                 # locks the deltas
```

## What's pinned (so the result is reproducible)

- **SDK / chain / asset:** see `VERSIONS.md` (`@x402/*@2.17.0`, `viem@2.31.7`, Base
  Sepolia `eip155:84532`, USDC 6-decimals).
- **Payer key:** a fixed, well-known, non-secret test key
  (`packages/drainbench/src/arms.ts`), so the payer address is stable. Live runs
  use a fresh HD account per run + treasury sweep-back (see §4.9 / `spike/e2e`).
- **Arm A (baseline) config:** a cumulative spending-limit counter with the **same
  nominal cap + window** as arm B (`buildArmA` in `packages/drainbench/src/arms.ts`;
  standalone reference in `bench/arm-a/native-hook.ts`). The x402 docs ship only an
  abort *stub*, so this counter is an honest **model**, not a verbatim snippet. It
  runs in **two modes** and the report shows both: `sync` (single-process, does not
  overspend) and `async` (shared store, read-then-write, overspends). The atomicity
  delta is **disclosed as conditional on the async/shared store** the multi-worker
  precondition requires — a synchronous single-process counter ties the guard.
- **Fixtures + ground-truth manifests:** `packages/drainbench/src/fixtures.ts`
  (each adversarial + benign fixture carries a frozen `truth` manifest the oracle
  joins against — no post-hoc judgment).
- **Oracle:** `packages/drainbench/src/oracle.ts` — the four metrics computed from
  the settlement ledger + delivery log, never self-report.
- **Seeds:** deterministic fixtures are N=1; the arm-A concurrent overspend is
  deterministic across runs (Node microtask FIFO — verified, and asserted by the
  `determinism` test).

## Outputs

- `bench/results/drainbench-report.md` — the human-readable table (adversarial
  deltas per arm, benign conformance gate, overhead, simulated-chain lane).
- `bench/results/drainbench-results.json` — every `(fixture, arm, profile)` row
  with raw metrics (bigints as strings).

## Honest scoping (what this lane is and isn't)

- **Deterministic lane = primary evidence.** N=1 conformance per fixture.
- **Benign corpus = a conformance GATE, not a rate** (§4.8): reported as blocks /
  total with every failure enumerated. A defensible false-block *rate* needs
  pre-registered benign *stochastic* cells (future work).
- **Stochastic arm = DEMONSTRATION** (§4.4 branch): no live model key here, so the
  scaffold runs a scripted StubModel. It shows enforcement below the model; it is
  **not** a Wilson-CI result. Set `ANTHROPIC_API_KEY` (+ `BENCH_MODEL`) to run the
  same loop against a live pinned model.
- **Simulated-chain lane** is labeled *simulated* (reorg/preemption cannot be
  produced on Base Sepolia's centralized sequencer, §3).
- **Overhead** is create-path wall time (dominated by EIP-712 signing), an
  *upper bound* on the guard's own reserve round-trip (in-memory store ops are
  sub-ms). Report it as such.
- **Held-out external-replication slice** (2605.11781 testbed) collapses to its
  documented fallback — the public artifact is a partial anonymized snapshot that
  does not map to x402 v2 (G0 spike Q9).
- **On-chain settlement** is simulated by an in-memory ledger; the real paid round
  trip is the `spike/e2e` harness (blocked on testnet funding only).
