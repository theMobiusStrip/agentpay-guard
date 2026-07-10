# e2e paid round trip (Base Sepolia) — the funded half of G0(c)

Signing is local and fully exercised offline by `npm run -w @agentpay-guard/spike
hook-probe` (no funds). This harness proves the **on-chain settlement** round trip,
which needs a funded payer + a live v2 facilitator.

## Steps

```bash
# 1. Generate a throwaway payer wallet (prints the address + faucets).
npm run -w @agentpay-guard/spike e2e:wallet

# 2. Fund the printed address on Base Sepolia:
#    - USDC : https://faucet.circle.com
#    - ETH  : https://www.alchemy.com/faucets/base-sepolia   (for gas)

# 3. Start the self-hosted x402-v2-gated endpoint (signer NOT here — merchant side).
X402_FACILITATOR_URL=<v2 facilitator url> \
X402_PAY_TO=<merchant address> \
npm run -w @agentpay-guard/spike e2e:server

# 4. Run the payer client (signer-in-proxy topology: signer below the guard).
X402_ENDPOINT=http://localhost:4021/paid \
npm run -w @agentpay-guard/spike e2e:client
```

Expected: `status 200`, a `PAYMENT-RESPONSE` header (settlement tx), and guard
audit lines (`reserved → signed → settled`). Re-running the exact same signed
authorization against the server returns the **cached grant** (replay defended),
not a second delivery.

## Topology note

The **payment-proxy** pattern satisfies the deployment precondition: the x402
client + guard + signer live in this proxy; an agent reaches it over HTTP/MCP and
never holds signing authority. A co-located-key variant is fine for a raw-viem
example but is **not** the precondition-satisfying configuration.

`.wallet.json` is gitignored — never commit a key.
