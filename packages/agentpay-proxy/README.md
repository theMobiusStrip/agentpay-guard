# @themobiusstrip/agentpay-proxy

**Guarded x402 payment proxy for AI agents.** The x402 client,
[`agentpay-guard`](https://www.npmjs.com/package/@themobiusstrip/agentpay-guard),
and the signing key live in ONE process, out of the agent's reach; the agent
gets a single capability — `paid_fetch(url)` over HTTP or MCP. Every payment
is decided by policy below the model, fail-closed: rolling-window budget with
atomic reserve-before-sign, optional payee/amount mandate binding,
duplicate-authorization guard, deny-by-default envelope
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
| `WINDOW_MS` | `300000` | rolling budget window |
| `CEILING_S` | `300` | max authorization lifetime the proxy signs; effective ceiling `min(CEILING_S, WINDOW_MS/1000)` |
| `MANDATE=1` + `PIN_PAYTO`, `PIN_MAX` | off | mandate-required profile: bind every payment to this payee/max ($0.01 default max) |
| `ALLOWED_HOSTS` | any | comma-separated allowlist of hosts `paid_fetch` may call. When set, the proxy also **refuses HTTP redirects** so an allowed host cannot redirect it to a disallowed one |

Malformed money knobs throw at startup — no silent fallback.

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

`ProxyHooks` (third argument) lets you supply an `onAudit` sink, a real
`mandateVerifier` (verify a *signed* mandate's provenance — constraints must
come from outside the model), and a shared `AtomicStore` for multi-worker
deployments (a per-worker in-memory store multiplies your budget by the
worker count).

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
- [`@themobiusstrip/x402-idempotency-middleware`](https://www.npmjs.com/package/@themobiusstrip/x402-idempotency-middleware) — replay defense for the merchant side
- `examples/paid-site.ts` in the repo — an x402-gated merchant to test against locally
