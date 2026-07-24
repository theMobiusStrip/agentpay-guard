# @themobiusstrip/agentpay-proxy

**Guarded x402 payment proxy for AI agents.** The x402 client,
[`agentpay-guard`](https://www.npmjs.com/package/@themobiusstrip/agentpay-guard),
and the signing key live in ONE process, out of the agent's reach; the agent
gets a single capability — `paid_fetch(url)` over HTTP or MCP. Every payment
is decided by policy below the model, fail-closed: optional independent
per-payment ceiling, rolling-window budget with atomic reserve-before-sign, optional
payee/amount mandate binding, duplicate-authorization guard, deny-by-default envelope
(`exact` + Base Sepolia + USDC).

```
agent (Claude, no keys)
   │ paid_fetch(url)                       <- HTTP or MCP
   ▼
agentpay-proxy                              <- x402 client + agentpay-guard + signer
   │ 402 → policy decides → sign EIP-3009 → retry with payment
   ▼
x402-gated site → facilitator → USDC settles on Base Sepolia
```

Why a proxy: the guard's deployment precondition is an **out-of-process
signer** — a prompt-injected agent that can run code can bypass any in-process
hook. Behind the proxy, injection can at most *ask* for a payment; policy
answers.

## Quick start

```bash
npx @themobiusstrip/agentpay-proxy          # starts on 127.0.0.1:4020
```

First run generates a **testnet** payer wallet (`.agentpay-proxy-wallet.json`,
mode 600 — keep it out of git) and prints faucet instructions. Fund the payer
with Base Sepolia USDC at <https://faucet.circle.com> (no ETH needed — the
facilitator pays settlement gas). Then:

```bash
curl -s -X POST http://127.0.0.1:4020/paid-fetch \
  -H 'content-type: application/json' \
  -d '{"url":"https://x402.org/protected"}'
```

Funded → `{"status":200,"body":"…","settlement":"<base64 receipt with tx hash>"}`.
Unfunded → the guard still runs the whole pipeline (`reserved → allow → signed`)
and the merchant re-402s at verification; nothing moves.

## Wire into Claude

```bash
claude mcp add paywall -- npx @themobiusstrip/agentpay-proxy mcp
```

The `mcp` command is a stdio forwarder to a running proxy (`PROXY_URL`,
default `http://127.0.0.1:4020`) — it holds no keys. Claude then has one tool,
`paid_fetch`; blocked payments return the machine-readable guard reason
(`cap_exceeded`, `intent_payto_mismatch`, …) instead of content.

## Configuration (env)

| var | default | meaning |
| --- | --- | --- |
| `PAYER_PK` | — | payer private key; else `WALLET_FILE` (default `./.agentpay-proxy-wallet.json`, auto-generated, TESTNET ONLY) |
| `HOST` / `PORT` | `127.0.0.1` / `4020` | bind address. Loopback by default — this process holds a key; authenticate the hop before exposing it |
| `CAP` | `100000` | per-mandate cap per window, atomic USDC ($0.10) |
| `AGG_CAP` | `200000` | aggregate cap across all mandates ($0.20) — salami-drain stop |
| `MAX_PAYMENT` | off | hard maximum for each payment, atomic USDC; works without `MANDATE` or `PIN_PAYTO`; `0` blocks every positive payment |
| `WINDOW_MS` | `300000` | rolling budget window |
| `CEILING_S` | `300` | max authorization lifetime the proxy signs; effective ceiling `min(CEILING_S, WINDOW_MS/1000)` |
| `STORE` | `sqlite` | `sqlite` for restart-safe state; `memory` only for disposable demos/tests |
| `STATE_DB` | `./.agentpay-proxy-state.sqlite` | SQLite state file, mode `0600` |
| `MAX_ACCOUNTING_WINDOW_MS` | current `WINDOW_MS` | durable upper bound for future rolling windows; must be at least `WINDOW_MS` |
| `MANDATE=1` + `PIN_PAYTO`, `PIN_MAX` | off | mandate-required profile: bind every payment to this payee/max ($0.01 default max) |
| `ALLOWED_HOSTS` | any | comma-separated allowlist of hosts `paid_fetch` may call. When set, the proxy also **refuses HTTP redirects** so an allowed host cannot redirect it to a disallowed one |

Malformed money knobs throw at startup — no silent fallback. Programmatic
`maxPaymentAmount` must be a non-negative `bigint`; invalid runtime values throw
before proxy creation.

`MAX_PAYMENT` is not cumulative and does not bind a payee. Keep `CAP` /
`AGG_CAP` for split-drain bounds; use mandate mode when payee or quoted-intent
binding is available. With `MAX_PAYMENT` and `PIN_MAX`, both checks apply.

SQLite opens, migrates, and recovers before listener starts. Recovered
`reserved` / `signed` / `submitted` rows become `unknown` and keep full cap
through authorization recovery deadline. A longer `WINDOW_MS` extends that
deadline before expiry; shortening never forgets old spend early. Set
`MAX_ACCOUNTING_WINDOW_MS` before first run if later window expansion is planned.
The persisted value becomes immutable; later window contraction reuses it,
while requests above it fail closed. Expired dedup rows, aged terminal rows,
and settled rows beyond every permitted window are pruned. Corrupt, unreadable,
locked, or newer schema state stops startup; proxy never falls back to memory.
SQLite supports one active proxy process per database.

`GET /healthz` returns `503` when store/lifecycle readiness latches unhealthy.
After possible transmission, failed lifecycle mutation blocks new paid requests
until restart/recovery. If merchant response already arrived, proxy returns that
paid response before reconciliation; reconciliation failure then blocks later
paid requests instead of replacing paid content with `503`. On `SIGINT` /
`SIGTERM`, listener closes before database checkpoint/close.

## Idempotency / retries

Each `paid-fetch` request runs as one purchase intent. Pass the same
`intentId` (`{"url": …, "intentId": "order-42"}`) to retry the SAME purchase —
the duplicate-authorization guard refuses to sign it twice. Omit `intentId`
for a fresh intent (a UUID is generated and echoed in the response). The
budget cap is the backstop either way.

## Programmatic use

```ts
import { createPaymentProxy, configFromEnv } from "@themobiusstrip/agentpay-proxy";

const { app, guard, account } = createPaymentProxy(process.env.PAYER_PK as `0x${string}`, {
  ...configFromEnv(),
  mandate: { payTo: "0xmerchant…", maxAmount: 10_000n },
});
app.listen(4020, "127.0.0.1");
```

`ProxyHooks` (third argument) lets embedded use supply an `onAudit` sink, a real
`mandateVerifier` (verify a *signed* mandate's provenance — constraints must
come from outside the model), and an explicit `AtomicStore`. Embedded
`createPaymentProxy()` keeps memory default and performs no hidden filesystem
writes. Inject a persistent adapter deliberately.

## Scope honesty

MVP envelope is `exact` + Base Sepolia (`eip155:84532`) + USDC — everything
else fails closed. The guard hardens **tool-mediated content-level
injection** with an out-of-process signer (this proxy); it is not a sandbox
for arbitrary code execution, and an agent with shell access to the proxy's
host can read the wallet file — isolate accordingly.

`paid_fetch` is a server-side fetch: without `ALLOWED_HOSTS` the proxy will
fetch any http(s) URL it is handed (an SSRF surface — it can reach hosts on
its own network). That is why it binds to **loopback by default**; set
`ALLOWED_HOSTS` and authenticate the agent→proxy hop before exposing it. The
guard still bounds what can be *paid* regardless — envelope + caps + mandate —
but a plain GET of an internal URL returns its body without payment. Full
threat model:
[agentpay-guard](https://github.com/theMobiusStrip/agentpay-guard).

## Related

- [`@themobiusstrip/agentpay-guard`](https://www.npmjs.com/package/@themobiusstrip/agentpay-guard) — the policy plugin this proxy deploys
- `@themobiusstrip/agentpay-guard/sqlite` — restart-safe one-host store entry used by CLI
- [`@themobiusstrip/x402-idempotency-middleware`](https://www.npmjs.com/package/@themobiusstrip/x402-idempotency-middleware) — replay defense for the merchant side
- `examples/paid-site.ts` in the repo — an x402-gated merchant to test against locally
