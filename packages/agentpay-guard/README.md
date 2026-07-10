# agentpay-guard

Stateful, agent-agnostic x402 v2 policy plugin. Installs over the native
`onBeforePaymentCreation` hook (pre-signing) and enforces:

1. **Atomic budget cap** — rolling-window cumulative spend, reserve-before-sign,
   keyed on `(principalId, mandateId)` with an optional principal-level aggregate
   cap. Reservations span the sign→settle gap and reconcile crash-safely.
2. **Trusted intent constraint check** — binds the about-to-be-signed
   `{ payTo, value, asset, network }` against a provenance-verified mandate.
   Honest naming: a *constraint check*, not AP2 SD-JWT-VC cryptographic binding.
3. **Duplicate-authorization guard** — keyed on the payer-owned
   payment-identifier / client intent, never merchant-controlled inputs.

Everything outside the MVP envelope (`exact` + EIP-3009 + Base Sepolia USDC) fails
closed. Zero agent-SDK deps in core.

See the repo root `README.md` for the full model and the `docs/` for the threat
matrix.

## API

```ts
installAgentPayGuard(client, {
  policy, store, principalId,
  clock?, mandateVerifier?, resolveDedupContext?,
  escalationPolicy?, onEscalate?, onAudit?,
}) => AgentPayGuard
```

The returned `AgentPayGuard` drives the reservation state machine
(`reconcile(now)` expires provably-dead reservations). The store contract
(`tryReserve` / `transition` / `putIfAbsent` / `removeDedup` / `releaseExpired`,
with `now` injected) is the atomicity boundary — a shared external store (Redis
Lua / Postgres serializable) is **required** for multi-worker deployments and must
pass the G1 suite.
