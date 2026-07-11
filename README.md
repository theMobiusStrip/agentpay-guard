# agentpay-guard

[![CI](https://github.com/theMobiusStrip/agentpay-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/theMobiusStrip/agentpay-guard/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node ≥22](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)
[![npm agentpay-guard](https://img.shields.io/npm/v/@themobiusstrip/agentpay-guard?label=agentpay-guard&color=cb3837)](https://www.npmjs.com/package/@themobiusstrip/agentpay-guard)
[![npm x402-idempotency-middleware](https://img.shields.io/npm/v/@themobiusstrip/x402-idempotency-middleware?label=x402-idempotency-middleware&color=cb3837)](https://www.npmjs.com/package/@themobiusstrip/x402-idempotency-middleware)

**Hard spending limits for AI agents that pay over x402 — enforced below the LLM,
before anything is signed, fail-closed.** agentpay-guard installs on x402 v2's
native client hook (`onBeforePaymentCreation`) and decides every payment against
durable state: an atomic rolling-window budget (reserve-before-sign), payee/amount
bound to a verified mandate, a duplicate-authorization guard, and a deny-by-default
envelope. Agent- and signer-agnostic: the same plugin guards Claude / GPT /
LangChain / raw scripts, over viem / Circle MPC / CDP signers.

## Why

x402 lets an agent pay per HTTP request by signing a USDC authorization (EIP-3009
`transferWithAuthorization`). The agent is steerable: any content it ingests — a
402 header, a merchant response, an MCP tool description — can push it to pay the
wrong payee, an inflated amount, or the same thing many times over. This is live:
the Grok/Bankr agent wallet lost ~$150k–200k to a two-stage prompt injection
(May 2026), straight past permission checks and heuristic string filters. Prompt-
level defenses get evaded; spend enforcement has to run **below the model**, in
code, with the worst case bounded in dollars.

## What ships

- **[`@themobiusstrip/agentpay-guard`](https://www.npmjs.com/package/@themobiusstrip/agentpay-guard)** — the client plugin. Atomic budget cap spanning the
  sign→settle gap (rolling window + principal aggregate), trusted-intent
  constraint check, duplicate-auth guard. Everything outside the MVP envelope
  (`exact` + EIP-3009 + Base Sepolia USDC) fails closed.
- **[`@themobiusstrip/x402-idempotency-middleware`](https://www.npmjs.com/package/@themobiusstrip/x402-idempotency-middleware)** — replay defense for the **resource server** (the API being paid — e.g. a paid weather API or MCP tool server), keyed on the
  payer-signed EIP-3009 authorization (claim-with-lease + cached response). Covers
  the attack class the payer-side plugin structurally can't see.
- **DrainBench** (`packages/drainbench`, private) — a reproducible, offline, deterministic
  harm benchmark: the same attacks with and without the guard, losses measured in
  dollars (below).

## Measured deltas (DrainBench deterministic lane)

DrainBench drives the same attack fixtures through two arms and reports dollars
lost, read from the settlement ledger (never self-report). **Arm A ("native")** =
a plain x402 client with the cumulative spending-limit counter an integrator would
write today (the x402 docs ship only an abort stub, so arm A is an honest *model*
of that baseline). **Arm B** = the same client with agentpay-guard installed.

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

## Quickstart

```bash
npm ci
npm run build
npx vitest run                              # full suite incl. the G1 gate
npm run -w @agentpay-guard/spike hook-probe # offline SDK probe (8/8, no funds)
```

## Using the plugin

```bash
npm i @themobiusstrip/agentpay-guard
```

```ts
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import { installAgentPayGuard, InMemoryAtomicStore, type Policy } from "@themobiusstrip/agentpay-guard";

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

## Design notes

**Delta vs incumbents:** the whitespace is **not** "atomic reserve-before-sign" —
AWS's Spend Governor already does that. It is the **rolling-window double-spend
closure + crash-safe reconciliation across the sign→settle gap + deterministic
expiry against an authoritative clock**, enforced agent- and signer-agnostically
over the hook — plus a **server-side replay middleware** for the class the client
structurally can't see.

**The atomicity model in one paragraph:** a reservation **holds cap until a
terminal state regardless of window age** (the rolling window does not slide
pending reservations out); settled spend is attributed **at settlement time** and
ages out of the window normally; any authorization whose `validBefore` would exceed
reserve-time + the policy ceiling is rejected. Together these close the "withhold
settlement until the window slides, then sign a fresh batch" ~2× double-spend that
a concurrency-only test misses. Expiry is judged against an authoritative clock
(local time minus a max-skew bound folded into the reorg margin), so a fast local
clock cannot release a reservation whose authorization can still settle. All of
this is exercised by the G1 gate.

## Layout

```
packages/agentpay-guard/               the client plugin (the deliverable)
packages/x402-idempotency-middleware/  server replay middleware (custody artifact)
packages/drainbench/                   the DrainBench harm-metric benchmark + agent scaffold
examples/                              two worked examples (claude-proxy, raw-viem)
spike/hook-probe/                      offline hook probe against the real SDK
spike/e2e/                             funded Base Sepolia round-trip harness
bench/                                 reproducibility bundle + results
docs/reference/                        durable: threat model + attack taxonomy
```

**Agent-agnosticism** is shown by the core-vs-adapter separation (zero agent-SDK
deps in core) plus the two worked examples — the *same* plugin guards a
Claude-via-proxy agent and a raw-viem script. Framework adapters (LangChain, etc.)
are **examples-only**, not shipped packages.
