# agentpay-guard

[![npm](https://img.shields.io/npm/v/@themobiusstrip/agentpay-guard?color=cb3837)](https://www.npmjs.com/package/@themobiusstrip/agentpay-guard)

```bash
npm i @themobiusstrip/agentpay-guard
```

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
(`tryReserve` / `transition` / `putIfAbsent` / `removeDedup` /
`releaseExpired` / `recoverAfterRestart`, with injected time) is atomicity
boundary. `InMemoryAtomicStore` is volatile single-process state.
`@themobiusstrip/agentpay-guard/sqlite` supplies restart-safe one-host state.
PostgreSQL is required for multi-worker / multi-host lifecycle ownership.

## Persistent SQLite

SQLite ships in this package through a Node-specific subpath. Beta while
Node's built-in `node:sqlite` API remains experimental. Requires Node
`>=22.13.0`.

```ts
import { openSqliteStore } from "@themobiusstrip/agentpay-guard/sqlite";

const store = await openSqliteStore(".agentpay-proxy-state.sqlite");
const recovered = await store.recoverAfterRestart(Date.now(), 300_000);
// Pass store to installAgentPayGuard() or createPaymentProxy().
```

Store opens in WAL mode with full synchronous durability, bounded lock waits,
schema version checks, and mode `0600`. Missing, locked, corrupt, read-only, or
newer-schema state throws. No memory fallback.

Reservations, rolling-window attribution, and payer-owned dedup keys persist.
Signed rows retain only `{ network, asset, from, nonce, validBefore }`; private
keys, signatures, and raw payment payloads never enter database.

V1 supports one active proxy process per database. Independent SQLite
connections serialize accounting, but process-local x402 lifecycle correlation
still requires one proxy owner. Call `close()` after stopping traffic.
