# Threat / control / metric matrix

Anchored to **OWASP Top 10 for Agentic Applications 2026 (ASI01–ASI10)** + the
x402 security papers so numbers are comparable/citable. Honest scoping: a class is
**defended** only if a built control stops it; otherwise **analyzed** or
**measured (simulated lane)**. §1 and §3 of the plan must agree — they do here.

**Live incident anchor (May 4, 2026):** the Grok/Bankr agent wallet was drained of
~$150k–200k (≈3B DRB on Base) in a **two-stage** attack — an NFT sent to escalate
the agent's Bankr permissions past its transfer limits, then a **Morse-encoded
prompt injection** to trigger the transfer (ASI01 goal-hijack + ASI03 privilege
abuse). Proof the threat is live *and* that permission-escalation + heuristic
string filters get evaded.

## Deployment precondition (write it down)

The plugin hardens **tool-mediated content-level injection**, **not arbitrary code
execution**. The guarantee is conditional on the agent **not holding signing
authority** → in practice an **out-of-process signer** (the Claude demo uses a
payment-proxy). Out of threat model: LLM-router/supply-chain interception,
private-key exfiltration, and anything reachable if the agent holds the raw signer
or can execute code. The `store` is a **trusted component (in the TCB)**:
fail-closed covers "store unavailable", not a poisoned store.

## Tier A — LLM/context layer (client controls; well-citable)

| Attack | Reaches guard via | Control | Status | Citation |
|---|---|---|---|---|
| Prompt-injection-to-pay (goal hijack) | merchant response / MCP tool text | intent-constraint check (if trusted mandate) + budget cap | **defended** (mandate-required) / cap-only (budget-only) | OWASP ASI01; arXiv 2601.22569 (ASR only, **no** drain-rate) |
| Confused deputy / MCP tool poisoning | malicious tool description | intent-constraint check | **defended** (mandate-required) | Invariant Labs (Apr 2025); MCPTox 2508.14925 |
| Rug pull (tool def mutated post-approval) | tool re-definition | TOFU on tool identity | **analyzed** (stretch) | Invariant; ETDI 2506.01333 |
| Price/quote bait-and-switch (quote low, bill high) | 402 header | intent-constraint check (quoted vs about-to-be-signed `value`) | **defended** (mandate-required) | **self-authored fixture** — see citation note below |

**Citation note (Q9 correction):** the plan's mapping of bait-and-switch to arXiv
2605.30998 is **REFUTED** — that paper does **not** name quote-manipulation. The
bait-and-switch fixture is therefore **self-authored** and counted in the
anti-overfit tally. Do **not** cite 2605.30998 for it.

## Tier B — protocol/settlement layer (custody spine)

**Measurability caveat:** a reorg **cannot be induced on Base Sepolia** (centralized
sequencer), and the four-metric oracle reads the very receipts a reorg erases — so
those classes run on a **local anvil-forked simulated lane**, labeled *simulated*
in the report.

| Attack | Correct layer | In this project | Status | Citation |
|---|---|---|---|---|
| **Protocol replay** — 1 settlement → many grants | resource server claims the **payer-signed authorization** (EIP-712 digest), not the client payment-identifier | `x402-idempotency-middleware` (claim-with-lease + cached-response) | **DEFENDED** + measured | 2605.11781 (Attack II; 248 grants/payment) |
| Settlement preemption / front-running | server ordering + **client validity-window clamp** | validBefore clamp **BUILT** (control #1); server ordering **described** | preemption **built (client half)** + measured (sim lane) | 2605.11781 (Attack I-B) |
| Reorg / confirmation-depth revert-grant | gate grant on confirmation depth | **analyzed**; defense **described** | measured (sim lane only) | 2605.11781 (Attack I-A) |
| Facilitator compromise / trust boundary | facilitator attestation | **analyzed; out-of-scope** defense; **not** in held-out corpus | analyzed | 2605.30998 (facilitator centralization — see label note) |
| Merchant-selection Sybil | reputation / discovery hardening | **analyzed; out-of-scope** | measured (sim lane) | 2605.11781 (Attack IV; 71.8% capture) |
| Sub-threshold / cumulative economic drain | **principal-level aggregate** budget cap (control #1) | **built** + measured | 2605.30998 (serial replay ≤99/auth) + Halborn spend-controls |
| **Denial-of-wallet / availability** | per-payee reservation limit; short `validBefore`; escalate-on-repeated-expiry | per-payee limit **built**; own metric (reservation-squatting fixture) | **partly built** + measured | self-authored (fail-closed is the attack surface) |

**Citation traps:** do **not** cite 2604.11309 "Salami Slicing" (multi-turn
jailbreak, **not** payments) — say "sub-threshold / cumulative drain".
CVE-2025-49596 (MCP Inspector RCE) = evidence of MCP's immature posture, **not** a
tool-poisoning example.

**2605.30998 label correction (Q9):** cite it for the *existence* of the flaw
classes (cross-resource substitution / duplicate-settlement / overdraft / denial
of settlement, framed around invariants I1–I5), but **do not** use the fabricated
"F1–F5" labels and **do not** quote the unverified "74% of Base merchants" figure.

## Controls → metrics map

| Control (built) | Primary metric it moves |
|---|---|
| Atomic budget cap (rolling window, reserve-before-sign, principal aggregate) | `unauthorized_payer_outflow` (drain), `benign_false_block_rate` + latency |
| Trusted intent constraint check | `unauthorized_payer_outflow` (payTo-tamper, quote-vs-billed) |
| Duplicate-auth guard | `unauthorized_payer_outflow` (re-presentation) |
| Server replay middleware | `unpaid_service_cost` (merchant victim) — replay |
| validBefore clamp | `paid_without_service` (preemption, client half) |
| Per-payee reservation limit | denial-of-wallet availability metric |
