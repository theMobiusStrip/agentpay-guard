# agentpay-guard security model

agentpay-guard is a payment-policy plugin that enforces spend decisions **below the
LLM**, at x402 v2's `onBeforePaymentCreation` hook, before any authorization is
signed. This document states its trust boundary, threat model, what each control
actually guarantees — and, deliberately, where it does **not**.

One-sentence version: **the guard makes spend decisions deterministic,
reserve-before-commit, and fail-closed on tool-mediated payment paths — it is not a
sandbox, and it presumes an out-of-process signer.** So it hardens *content-level
injection* (malicious 402 headers, merchant responses, MCP tool text), not
arbitrary code execution or credential theft. If the agent holds the raw signer or
can run code, it can instantiate a second client, call the signer directly, or
monkey-patch the hook — none of which the guard can see.

## Threat model

**Assets.** The payer's spendable balance within the mandate/cap; the merchant's
delivered service; the budget-accounting **store** (part of the TCB); the audit
event stream.

**Trust boundary.** The agent/LLM is **untrusted** — it can be wrong, over-eager,
or prompt-injected via any content it ingests (402 `PAYMENT-REQUIRED` headers,
merchant responses, MCP tool descriptions). The guard runs *beneath* the agent at
the pre-signing hook. The **signer must be outside the agent's reach** — that is a
deployment precondition, not something the plugin enforces.

**Adversaries.**
1. *A prompt-injected agent* — steered to pay the wrong payee, the wrong amount, or
   too often. Reaches the guard as the resolved payment fields at the hook.
2. *A malicious merchant* — adversarial 402 (payTo-tamper, quote-vs-billed),
   protocol replay of a settled authorization, service withholding after
   settlement, reservation squatting (denial-of-wallet).
3. *An agent that holds signing authority or can execute code* — **out of the
   threat model**; the guard is not a sandbox (see Honest limitations).

## The controls

Each answers a *different* question; they are complementary, not redundant.

| Control | Question | Enforced by | A boundary? |
| --- | --- | --- | --- |
| **MVP envelope** | Is this the one slice we enforce? | fail-closed allowlist (`policy/envelope.ts`) | **Yes** — deny by default; unknown scheme/network/asset blocks |
| **Atomic budget cap** | Over the cumulative cap? | reserve-before-sign atomic store (`store/`) | **Yes**, for spend accounting — spans sign→settle; proxy CLI state survives restart |
| **Trusted intent check** | Right payee / amount / asset? | provenance-verified mandate (`policy/intent.ts`) | **Conditional** — only as strong as the mandate's provenance; fails safe when intent is agent-derived |
| **Duplicate-auth guard** | Double-sign one purchase? | payer-owned dedup key (`policy/dedup.ts`) | **Partial** — needs a payer-owned id to be precise; the cap is the backstop for jittered re-presentation (see Honest limitations) |
| **Server replay middleware** | Replay of a settled authorization? | payer-signed-auth idempotency (`x402-idempotency-middleware`) | **Yes**, server-side — the client structurally can't see this |
| **Out-of-process signer** | Does the agent hold the key? | deployment topology (payment-proxy) | **Yes — the precondition.** NOT enforced by the plugin; the flagship demo satisfies it |

## What the plugin guarantees

- **Deterministic, fail-closed spend enforcement** on tool-mediated payment paths:
  anything outside the envelope blocks; the budget cap is atomic and cannot be
  raced past; intent binding fails safe.
- **Spend accounting across the sign→settle gap** — a signed-but-unsettled
  authorization holds the cap. Restart-safe SQLite ships in the primary guard
  package through its `/sqlite` entry, and proxy CLI uses it by default. Before
  listening after restart, recovery atomically changes `reserved` / `signed` /
  `submitted` rows to `unknown`; those rows hold cap through `safeReleaseAt +
  original windowMs`. Lost responses cannot reopen budget while a last-instant
  settlement remains inside its rolling window. SQLite prunes settled history
  only after the persisted maximum accounting window; a larger requested window
  fails closed.
- **Server-side replay defense** keyed on the payer-signed EIP-3009 authorization.

## Honest limitations (do not overclaim)

- **`void` return means allow.** The hook contract treats a void return as "allow"
  and signs. Any self-caught error in the guard hook that falls through to `return;`
  is a **fail-open** hole. The guard's catch-all always returns `{ abort: true }`;
  a change that swallows an error without aborting reopens this.
- **Store scope is explicit.** `InMemoryAtomicStore` is volatile,
  single-process state for tests and disposable embedded use. The proxy CLI
  defaults to restart-safe SQLite. SQLite supports one active proxy process
  per database; independent connections serialize cap operations, but
  process-local lifecycle correlation still has one owner. PostgreSQL is
  required for multi-worker / multi-host lifecycle ownership. Every shipped
  store passes G1. Store remains **trusted (TCB)** — fail-closed covers
  unavailable state, not a poisoned store.
- **Crash recovery buys safety with availability.** RPC-free recovery treats
  every recovered nonterminal row as `unknown` and keeps full amount reserved
  through its recovery deadline. Recovery extends that deadline before expiry
  when active rolling window grows; window contraction never shortens old rows.
  Crash can over-block for one effective rolling window after authorization
  becomes un-settleable. It cannot undercount a possibly settled payment.
  Runtime store or lifecycle mutation failure latches proxy readiness false;
  new paid requests stay blocked until restart/recovery. A reconciliation
  failure after merchant response does not replace already paid content; it
  blocks later requests.
- **Intent binding is only as strong as the mandate.** EIP-3009 signs
  `{from,to,value,validAfter,validBefore,nonce}` — **not** merchant / resource URL /
  method. `payTo`/`value` bind cleanly; URL binding rests on a separately-signed
  mandate. When the only "intent" is agent-derived, the check **fails safe** rather
  than verifying attacker-vs-attacker.
- **The `budget-only` profile has no intent check.** payTo-tamper and
  bait-and-switch are **not** caught in that profile (the cap is the only control) —
  measured and disclosed in DrainBench. Use `mandate-required` when the ecosystem
  emits mandates.
- **The duplicate-auth guard needs a payer-owned identity.** It keys on a
  payer-set `paymentIdentifier` or `intentId`. Absent both, it falls back to
  `(mandate, resourceUrl, asset)` and treats distinct purchases sharing that tuple
  as duplicates — an intentional anti-jitter tradeoff, not per-purchase precision.
  Note `resourceUrl` is merchant-supplied, so in this weak config a merchant can
  influence whether the fallback fires. With **none** of payer-id/mandate/resourceUrl
  present, the fallback would be asset-only (constant), so client-side dedup is
  **skipped** rather than latching the principal to a single payment. The **budget
  cap is the sole backstop** for the payer-side double-pay this exposes
  (`unauthorized_payer_outflow`): the agent double-signing one purchase mints two
  *distinct* EIP-3009 nonces, and the server replay middleware keys on
  `(token, from, nonce)` — it collapses only *same-nonce* re-presentation (a
  different victim, `unpaid_service_cost`), so it does **not** bound this. Wire
  `resolveDedupContext` with a payer-owned id to distinguish distinct same-resource
  purchases and to get precise client-side duplicate defense.
- **Preemption / reorg are analyzed, not fully client-defended.** The client owns
  only the validity-window clamp; confirmation-depth gating and ordering are
  server-side. A merchant that settles then withholds service (`paid_without_service`)
  cannot be prevented client-side.
- **Clock/skew is an assumption.** Expiry is judged against an authoritative clock
  (local time minus a stated `maxClockSkewMs`, folded into the reorg margin). A
  local clock that runs ahead by more than the bound could release a still-settleable
  reservation.
- **Not a sandbox.** A prompt-injected agent that can run code or issue raw HTTP can
  bypass any in-process hook. The guarantee is conditional on an **out-of-process
  signer**; the demo uses a payment-proxy for exactly this reason.

## Companion docs

`docs/reference/threat-model.md` (in/out-of-scope boundary + assumptions) and
`docs/reference/threat-model-matrix.md` (OWASP-anchored attack taxonomy → controls →
metrics) expand this model. The custody-spine invariants live in `AGENTS.md` →
Security.

## Reporting a vulnerability

Open a private security advisory on the GitHub repository rather than a public
issue. Include reproduction steps (a concrete failing input / interleaving) and the
affected version.
