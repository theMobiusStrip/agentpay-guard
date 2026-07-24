# Threat model — in-scope vs out-of-scope (the honest boundary)

Companion to `docs/reference/threat-model-matrix.md` (the attack taxonomy). This states the
guarantee positively and names what is deliberately out of scope, so the boundary
reads as competence, not a gap.

## The guarantee (stated positively)

agentpay-guard **hardens tool-mediated payment paths against content-level
injection** — malicious 402 headers, merchant responses, and MCP tool text that
try to make an agent sign a payment it should not. Enforcement runs at x402 v2's
`onBeforePaymentCreation` hook (pre-signing), below any agent framework, and:

- caps cumulative spend with an **atomic reserve-before-sign** rolling-window
  budget whose accounting **spans the sign→settle gap** and reconciles crash-safely;
- binds the about-to-be-signed `{ payTo, value, asset, network }` to a **trusted,
  provenance-verified mandate** (fails safe when the only "intent" is agent-derived);
- prevents **our** agent from double-signing one logical purchase **when a
  payer-owned id (paymentIdentifier/intentId), mandate, or resource is present**;
  with none of these the client-side guard is skipped and the budget cap is the
  sole backstop (see `SECURITY.md` → Honest limitations).

The server-side `x402-idempotency-middleware` defends **protocol replay** at the
resource server — the layer that owns it.

## Deployment precondition (must hold, and the flagship demo satisfies it)

The guarantee is conditional on the agent **not holding signing authority**. In
practice that means an **out-of-process signer**: the Claude example
(`examples/claude-proxy.ts`) runs the x402 client + guard + signer inside a
payment-proxy the agent reaches over one `pay` capability. A prompt-injected agent
that can *run code* or *issue raw HTTP* could otherwise instantiate a second x402
client, call the signer directly, or monkey-patch the hook — the plugin is **not a
sandbox**. "Outside the LLM context" ≠ "outside the agent's authority".

The `examples/raw-viem.ts` co-located-key variant is fine for brevity but is
**labeled as not the precondition-satisfying configuration**.

## Explicitly OUT of the threat model (written down)

- Upstream **LLM-router / supply-chain** interception.
- **Private-key exfiltration**; anything reachable if the agent holds the raw
  signer/wallet credential directly, or can **execute arbitrary code**.
- **Arbitrary code execution** by the agent (the guard defends content-level
  injection, **not** code execution).
- A **poisoned store.** The `store` is a **trusted component (in the TCB)**;
  fail-closed covers "store unavailable", not a maliciously-corrupted store.

## Load-bearing assumptions

- **Atomicity domain.** The bundled memory store is volatile and
  **single-process**. Proxy CLI defaults to restart-safe SQLite for one active
  process per database. PostgreSQL is required for multi-worker / multi-host
  lifecycle ownership. Two workers with per-process stores each get full cap.
  G1 runs unchanged against memory plus one- and two-connection SQLite.
- **Clock / skew.** Reservation expiry is judged against an authoritative clock
  (local time minus a stated `maxClockSkewMs`, folded into the reorg margin), so a
  fast local clock cannot release a still-settleable authorization. The skew bound
  is a declared assumption.
- **EIP-3009 signs `{from,to,value,validAfter,validBefore,nonce}` only** — not
  merchant / URL / method. So `payTo`/`value` bind cleanly; resource-URL binding is
  only as strong as the separately-signed mandate. The nonce is SDK-internal
  (verified), so client nonce-keyed dedup is theater and the server keys on the
  signed authorization (EIP-712 digest / `(token,from,nonce)`).

## Availability (denial-of-wallet)

Fail-closed is itself an attack surface: an adversary can weaponize it (unknown
scheme, broken mandate, reservation squatting) to force blocks. Mitigations built /
named: **per-payee reservation limit** (built, measured — DrainBench squat row),
short accepted `validBefore` horizons (the validity clamp), escalate-on-repeated-
expiry (named). `benign_false_block_rate` measures only *accidental* positives; the
squat fixture measures the *weaponized* case separately.

Crash recovery also fails toward availability: recovered nonterminal
authorizations become `unknown` and hold full cap through
`safeReleaseAt + max(original windowMs, active windowMs)`. Deadline extension
happens before expiry, so post-restart window growth cannot forget possibly
settled spend. This may over-block after crash. It prevents lost settlement
responses from reopening budget early.
