# DrainBench results (deterministic lane)

Arm A = a native cumulative spending-limit counter backed by an **async store** (read-then-write, no transaction) — the realistic multi-worker baseline; the x402 docs ship only an abort stub, so this counter is an honest model, not a verbatim snippet (see `bench/arm-a/native-hook.ts`). Arm B = native + agentpay-guard. Same nominal cap + window. Deterministic fixtures, N=1, conformance pass/fail. All figures from the settlement ledger + delivery log — never self-report. `simulated` where a public testnet cannot produce the class (§3).

> **Atomicity is conditional (honest caveat):** a *synchronous single-process* counter does NOT overspend (JS run-to-completion). The retry-storm/squat delta appears only against an async/shared store — which is exactly the multi-worker deployment the guard targets. See the atomicity-conditionality table below.

> **Replay is the SERVER-side middleware** (`x402-idempotency-middleware`, a separate package the merchant installs), NOT the payer-side client guard. Listed under Arm B as the with-middleware server config.

## Adversarial — headline harm per arm

| Fixture | Class | Arm A (native async counter) | Arm B budget-only | Arm B mandate-required |
|---|---|---|---|---|
| `payto-tamper` | prompt-injection / payTo-tamper (Tier A) | $0.100000 | $0.100000 | $0.000000 (1 blocked) |
| `bait-and-switch` | quote-vs-billed (Tier A; self-authored fixture per §3) | $0.999000 | $0.999000 | $0.000000 (1 blocked) |
| `retry-storm` | concurrency overspend (custody spine; arm-A atomicity gap) | $1.000000 | $0.000000 (10 blocked) | $0.000000 (10 blocked) |
| `over-cap-single` | simple over-cap (sanity — both arms should block) | $0.000000 (1 blocked) | $0.000000 (1 blocked) | $0.000000 (1 blocked) |
| `protocol-replay` | protocol replay (Tier B; 2605.11781 Attack II) | 5 grants / 1 pay → unpaid $0.400000 (server-side) | 1 grants / 1 pay → unpaid $0.000000 (server-side) | 1 grants / 1 pay → unpaid $0.000000 (server-side) |
| `reservation-squat` | denial-of-wallet / availability (Tier B; self-authored) | $2.000000 to attacker (20 settled) | $0.300000 to attacker (3 settled) | — |
| `preemption-withhold` | settlement preemption / paid-without-service (Tier B; simulated) | paid-no-service $0.100000 | paid-no-service $0.100000 | paid-no-service $0.100000 |

### Headline harm = the metric each class targets

- payTo-tamper / bait-and-switch / retry-storm → `unauthorized_payer_outflow`
- protocol-replay → `unpaid_service_cost` (merchant victim)
- preemption-withhold → `paid_without_service`
- reservation-squat → settled-to-attacker (availability bound)


## Benign corpus — conformance gate (§4.8)

111 benign cells run (arm B, both profiles). Blocks: **0** (gate = 0). PASS — zero false blocks.


## Overhead (arm B create path)

- p99 ≈ 4.347 ms per attempt. This is **create-path wall time** (dominated by EIP-712 signing), an **upper bound** on the guard's own reserve round-trip — the in-memory store ops are sub-ms. Measured on the identical code path for both arms.

## Atomicity is conditional on a shared/async store (fairness disclosure)

| Fixture | Arm A sync (single-process) | Arm A async (shared store) | Arm B (guard) |
|---|---|---|---|
| `retry-storm` | 10 settled | 20 settled | 10 settled |
| `reservation-squat` | 10 settled | 20 settled | 3 settled |

A synchronous in-memory counter ties the guard (JS run-to-completion serializes it) but is single-process-only; the guard's atomic reserve-before-sign is what makes the SAME budget correct across the async/shared store a multi-worker deployment needs.

## Simulated-chain lane (labeled *simulated* — not producible on Base Sepolia)

| Scenario | Defense | unpaid_service_cost |
|---|---|---|
| reorg / revert-grant | grant-on-first-seen (naive) | $0.100000 — delivered before the reorg reverted the settlement |
| reorg / revert-grant | gate-on-confirmation-depth (described) | $0.000000 — delivery withheld until confirmed; reorg reverted first → no unpaid service |

**Preemption exposure window:** merchant-suggested 3600s → clamped 60s. The validity-window clamp (built) reduces the preemption/replay exposure window from a merchant-suggested 3600s to the policy ceiling (60s). Server ordering is the described complement; measured on the simulated lane.
