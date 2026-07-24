# Frozen versions

Everything the benchmark depends on is pinned here. Changing any line is a
pre-registration amendment and must be dated.

## x402 SDK (target: v2)

| Package | Version | Role |
|---|---|---|
| `@x402/core` | 2.17.0 | client + resource-server core, native hooks |
| `@x402/fetch` | 2.17.0 | `wrapFetchWithPayment`, `x402Client` |
| `@x402/evm` | 2.17.0 | `ExactEvmScheme` (EIP-3009), signer adapters |
| `@x402/express` | 2.17.0 | `paymentMiddlewareFromConfig` (self-hosted endpoint) |
| `@x402/mcp` | 2.17.0 | MCP v2 transport |
| `viem` | 2.31.7 | signer + EIP-712 digest |

Legacy v1 packages (`x402-fetch`, `x402-axios`) are **not** used. `@coinbase/x402`
(facilitator config) is server-side only and not a client dep.

## Chain / network

- Network: **Base Sepolia**, CAIP-2 `eip155:84532` (v2 id, not v1 `base-sepolia`).
- Asset: **USDC** `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (6 decimals).
- Scheme: **`exact`** + EIP-3009 `transferWithAuthorization`. Everything else
  fails closed.
- RPC: pin the exact endpoint at first CI run (env `BASE_SEPOLIA_RPC_URL`).
- Facilitator: pin `X402_FACILITATOR_URL` at first funded run; record its
  `/supported` response in the reproducibility bundle.

## Signed EIP-3009 fields (verified at runtime)

`{ from, to, value, validAfter="0", validBefore=now+maxTimeoutSeconds, nonce }`;
domain `{ name, version, chainId:84532, verifyingContract: USDC }`. Nonce =
32 SDK-random bytes per call (not caller-controllable).

## Agent model (stochastic arm — to finalize at stochastic freeze)

- Primary pinned model: **`claude-sonnet-5`** (cost-appropriate for ~250 runs).
- Escalation alt for the null-baseline branch: a more capable tier if arm
  A refuses the bait below threshold, or demote the stochastic arm to
  "demonstration". Model id frozen at the stochastic pre-registration, not now — it depends on the agent scaffold and the null-baseline pilot.

## Toolchain

- Node ≥ 22.13.0 (dev on 26.3.0), TypeScript 5.8.3, vitest 3.2.4, tsx 4.20.3.
