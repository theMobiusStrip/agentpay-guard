/**
 * A website that requires x402: GET /article costs $0.001 USDC on Base
 * Sepolia. Unpaid request -> HTTP 402 + payment requirements. Paid request ->
 * facilitator verifies + settles on-chain, then the article is served.
 *
 * Handler wrapped in x402-idempotency-middleware: replaying an already-settled
 * authorization returns the CACHED response, never a second delivery.
 *
 * The payer side is @themobiusstrip/agentpay-proxy (packages/agentpay-proxy);
 * this file is the merchant side the tutorial's attack demos tamper with.
 *
 * Run: PAY_TO=<merchant address> npm run -w @agentpay-guard/examples paid-site
 *
 * Env knobs: PORT (4021), PAY_TO (required — any address you control,
 * receive-only), PRICE (Money form, default "$0.001"), FACILITATOR_URL.
 * Attack demos: PRICE='$2' (over-cap), PAY_TO=0xdead... (payee tamper vs a
 * mandate-pinned proxy).
 */
import express from "express";
import { paymentMiddlewareFromConfig } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  IdempotencyGuard,
  InMemoryClaimStore,
  type PaymentPayloadLike,
} from "@themobiusstrip/x402-idempotency-middleware";

const PORT = Number(process.env.PORT ?? 4021);
const PAY_TO = process.env.PAY_TO;
const PRICE = process.env.PRICE ?? "$0.001"; // Money form: resolves Base Sepolia USDC + EIP-712 domain
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://x402.org/facilitator";
const BASE_SEPOLIA = "eip155:84532";

if (!PAY_TO || !/^0x[0-9a-fA-F]{40}$/.test(PAY_TO)) {
  console.error("Set PAY_TO=<0x merchant address> — any address you control (receive-only).");
  process.exit(1);
}

const app = express();
const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

// 402 gate: verify + settle through the facilitator before the handler runs.
// Third arg registers the server-side scheme — without it the middleware
// throws RouteConfigurationError at boot. The Money-form price injects the
// token's EIP-712 domain (extra: {name:"USDC",version:"2"}) the client needs
// to sign; a bare {asset, amount} price does not.
app.use(
  paymentMiddlewareFromConfig(
    {
      "GET /article": {
        accepts: {
          scheme: "exact",
          network: BASE_SEPOLIA,
          price: PRICE,
          payTo: PAY_TO,
          maxTimeoutSeconds: 20,
        },
      },
    },
    facilitator,
    [{ network: BASE_SEPOLIA, server: new ExactEvmScheme() }],
  ),
);

// Replay defense: one delivery per payer-signed authorization.
const replay = new IdempotencyGuard({ store: new InMemoryClaimStore(), leaseMs: 30_000 });

app.get("/article", async (req, res) => {
  const headerB64 = req.header("PAYMENT-SIGNATURE");
  let payload: PaymentPayloadLike | undefined;
  try {
    payload = headerB64
      ? (JSON.parse(Buffer.from(headerB64, "base64").toString("utf8")) as PaymentPayloadLike)
      : undefined;
  } catch {
    payload = undefined;
  }
  if (!payload) {
    res.status(400).json({ error: "missing/unparseable payment" });
    return;
  }

  const begin = await replay.begin(payload);
  if (begin.kind === "replay") {
    res.status(begin.grant.status).json(begin.grant.body); // cached grant, no re-delivery
    return;
  }
  if (begin.kind === "in_progress") {
    res.status(409).json({ error: "duplicate in progress" });
    return;
  }
  if (begin.kind === "unkeyable") {
    res.status(400).json({ error: "unkeyable payment" });
    return;
  }

  const body = { article: "the paid content 🎉", servedAt: new Date().toISOString() };
  await replay.complete(begin.key, begin.claimToken, { status: 200, headers: {}, body });
  res.status(200).json(body);
});

app.listen(PORT, () => {
  console.log(`paid site on http://localhost:${PORT}/article`);
  console.log(`  price: ${PRICE} USDC -> payTo ${PAY_TO}`);
  console.log(`  facilitator: ${FACILITATOR_URL}`);
});
