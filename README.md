# agentpay-guard

A **stateful, agent-agnostic x402 policy plugin** + **DrainBench**, a reproducible
adversarial harm-metric benchmark. Enforcement runs at x402 v2's native client
lifecycle hook (`onBeforePaymentCreation`, *pre-signing*), below any agent
framework, so it works across Claude / GPT / LangChain / raw scripts and across
signer backends (viem / Circle MPC / CDP).

> **Delta vs incumbents (measured in the G0 spike, Q8):** the whitespace is **not**
> "atomic reserve-before-sign" — AWS's Spend Governor already does that. It is the
> **rolling-window double-spend closure + crash-safe reconciliation across the
> sign→settle gap + deterministic expiry against an authoritative clock**, enforced
> agent- and signer-agnostically over the hook — plus a **server-side replay
> middleware** for the class the client structurally can't see.

## Status

- ✅ Core plugin: atomic budget cap (rolling window, reserve-before-sign, principal
  aggregate), trusted intent constraint check, duplicate-auth guard, fail-closed
  MVP envelope — over the real pinned SDK.
- ✅ **G1 overspend gate green**: concurrent overspend, **window-slide
  double-spend**, **skewed-clock**. G2 (circularity) and G3 (envelope/escalate/
  malformed-402) seeded.
- ✅ Server replay middleware (`x402-idempotency-middleware`): keyed on the
  payer-signed EIP-3009 authorization, claim-with-lease + cached-response.
- ✅ G0 spike: Q1/Q1b/Q1c/Q2 confirmed **at runtime** (offline hook probe, 8/8),
  Q8/Q9 resolved. Paid on-chain round trip built, blocked only on funding.
- ✅ **DrainBench** (`packages/drainbench`): reproducible four-metric harm
  benchmark, arm A (native) vs arm B (guard), deterministic + offline. Results in
  `bench/results/`.
- ✅ Two worked examples proving the same plugin guards both (`examples/`).
- ✅ Adversarial correctness review of the custody spine — all findings fixed +
  regression-tested.
- **73 tests + live SDK probe green**; both publishable packages npm-packable.

### Measured deltas (DrainBench deterministic lane)

| Class | Arm A (native) | Arm B (mandate-required) |
|---|---|---|
| retry-storm (atomicity, async store) | overspends cap by **$1.00** | **$0.00** — holds cap |
| payTo-tamper | **$0.10** to attacker | **$0.00** — blocked |
| bait-and-switch | **$0.999** over-quote | **$0.00** — blocked |
| protocol-replay (server middleware) | **5 grants / 1 pay** ($0.40 unpaid) | **1 grant** ($0.00) |
| reservation-squat | **$2.00** locked | **$0.30** — per-payee bound |
| benign corpus | — | **0 / 111 false blocks** |

**Fairness disclosed:** the retry-storm/squat atomicity delta is *conditional on an
async/shared store* — a synchronous single-process counter ties the guard (shown in
the report's atomicity-conditionality table). That's exactly the multi-worker
deployment the guard targets. Replay is the separate server-side middleware, not the
payer-side guard. Reproduce: `npm run -w @agentpay-guard/drainbench bench` (see
`bench/README.md`).

## Layout

```
packages/agentpay-guard/               the client plugin (the deliverable)
packages/x402-idempotency-middleware/  server replay middleware (custody artifact)
packages/drainbench/                   the DrainBench harm-metric benchmark + agent scaffold
examples/                              two worked examples (claude-proxy, raw-viem)
spike/hook-probe/                      offline G0 probe against the real SDK
spike/e2e/                             funded Base Sepolia round-trip harness
bench/                                 reproducibility bundle + results
docs/reference/                        durable: threat model + attack taxonomy
docs/deck.md                           the 5-slide deck
```

(`docs/process/` holds milestone notes — spike report, pre-registration, review
log, status — but is private/gitignored and absent from a fresh clone.)

**Agent-agnosticism** is shown by the core-vs-adapter separation (zero agent-SDK
deps in core) plus the two worked examples — the *same* plugin guards a
Claude-via-proxy agent and a raw-viem script. Framework adapters (LangChain, etc.)
are **examples-only** (plan cut candidate #1), not shipped packages.

## Quickstart

```bash
npm ci
npm run build
npx vitest run                              # full suite incl. the G1 gate
npm run -w @agentpay-guard/spike hook-probe # offline SDK probe (8/8, no funds)
```

## Using the plugin

```ts
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { installAgentPayGuard, InMemoryAtomicStore, type Policy } from "agentpay-guard";

const policy: Policy = {
  profile: "budget-only",                 // or "mandate-required"
  windowMs: 60_000,
  perMandateCap: 1_000_000n,              // 1 USDC (6 decimals)
  principalAggregateCap: 5_000_000n,      // catches salami drain across mandates
  envelope: {
    schemes: ["exact"],
    networks: ["eip155:84532"],           // Base Sepolia
    assets: ["0x036cbd53842c5426634e7929541ec2318f3dcf7e"], // USDC (lowercased)
  },
  validBeforeCeilingSeconds: 30,          // client half of the preemption defense
  reorgMarginMs: 2_000,
  maxClockSkewMs: 5_000,
};

const account = privateKeyToAccount(process.env.PK as `0x${string}`);
const client = new x402Client().register("eip155:84532", new ExactEvmScheme(account));

const guard = installAgentPayGuard(client, {
  policy,
  store: new InMemoryAtomicStore(),       // swap a shared store for multi-worker
  principalId: `payer:${account.address}`,
  onAudit: (e) => console.log("[guard]", e.kind, e.reason ?? ""),
});

const fetchWithPay = wrapFetchWithPayment(fetch, client);
// guard.reconcile() drives deterministic expiry of stale reservations.
```

**Deployment precondition (honest scope):** the plugin hardens **tool-mediated
content-level injection, not arbitrary code execution**, and presumes an
**out-of-process signer** (a prompt-injected agent that can run code or issue raw
HTTP can bypass any in-process hook). The flagship demo runs the signer in a
payment-proxy for exactly this reason. See `docs/reference/threat-model-matrix.md`.

## The atomicity model in one paragraph

A reservation **holds cap until a terminal state regardless of window age** (the
rolling window does not slide pending reservations out); settled spend is
attributed **at settlement time** and ages out of the window normally; any
authorization whose `validBefore` would exceed reserve-time + the policy ceiling is
rejected. Together these close the "withhold settlement until the window slides,
then sign a fresh batch" ~2× double-spend that a concurrency-only test misses.
Expiry is judged against an authoritative clock (local time minus a max-skew bound
folded into the reorg margin), so a fast local clock cannot release a reservation
whose authorization can still settle. All of this is exercised by the G1 gate.
