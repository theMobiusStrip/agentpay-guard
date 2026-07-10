/**
 * Self-hosted x402-v2-gated endpoint on Base Sepolia (the §5 fallback stack).
 * Gates GET /paid behind an `exact` USDC payment, and wraps the paid handler in
 * the x402-idempotency-middleware IdempotencyGuard so a replayed authorization
 * gets the cached grant instead of a second service delivery.
 *
 * REQUIRES (env): X402_FACILITATOR_URL (a v2 facilitator that verifies+settles
 * on Base Sepolia). Run: npm run -w @agentpay-guard/spike e2e:server
 *
 * NOTE: on-chain settlement needs a funded payer + a live facilitator, so this
 * is the funded-run half of G0(c). The offline hook-probe proves SDK integration
 * without funds; this proves the paid round trip once funded.
 */
import express from "express";
import { paymentMiddlewareFromConfig } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import {
  IdempotencyGuard,
  InMemoryClaimStore,
  type PaymentPayloadLike,
} from "../../packages/x402-idempotency-middleware/dist/index.js";

const PORT = Number(process.env.PORT ?? 4021);
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL;
const PAY_TO = process.env.X402_PAY_TO; // merchant address that receives USDC
const BASE_SEPOLIA = "eip155:84532";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

if (!FACILITATOR_URL || !PAY_TO) {
  console.error("Set X402_FACILITATOR_URL and X402_PAY_TO (see spike/e2e/README.md).");
  process.exit(1);
}

const app = express();
const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

// Replay defense (custody artifact). One grant per payer-signed authorization.
const replay = new IdempotencyGuard({ store: new InMemoryClaimStore(), leaseMs: 30_000 });

app.use(
  paymentMiddlewareFromConfig(
    {
      "GET /paid": {
        accepts: {
          scheme: "exact",
          network: BASE_SEPOLIA,
          // Pin USDC explicitly via an AssetAmount price (1000 atomic = $0.001).
          price: { asset: USDC, amount: "1000" },
          payTo: PAY_TO,
          maxTimeoutSeconds: 20,
        },
      },
    },
    facilitator,
  ),
);

app.get("/paid", async (req, res) => {
  // The payment header has been verified+settled by the middleware above. Guard
  // the delivery on the payer-signed authorization for replay safety.
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
    res.status(begin.grant.status).json(begin.grant.body);
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

  const body = { data: "the paid content", servedAt: new Date().toISOString() };
  await replay.complete(begin.key, begin.claimToken, {
    status: 200,
    headers: {},
    body,
  });
  res.status(200).json(body);
});

app.listen(PORT, () => {
  console.log(`x402-gated endpoint on http://localhost:${PORT}/paid (Base Sepolia USDC, $0.001)`);
  console.log(`facilitator: ${FACILITATOR_URL}`);
});
