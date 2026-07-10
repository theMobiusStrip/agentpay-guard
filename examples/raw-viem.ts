/**
 * Example 1 — raw viem, signer CO-LOCATED with the guard.
 *
 * The SAME agentpay-guard plugin, installed over the x402 v2 client hooks. This
 * co-locates the key for brevity; it is LABELED as **not** the
 * precondition-satisfying configuration (a prompt-injected agent that can run
 * code here could call the signer directly). The Claude example runs the signer
 * out-of-process — see claude-proxy.ts.
 *
 * Runnable offline (EIP-3009 signing is local; no funds/facilitator needed):
 *   npm run -w @agentpay-guard/examples raw-viem
 */
import { x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { installAgentPayGuard, InMemoryAtomicStore, type Policy } from "agentpay-guard";

const BASE_SEPOLIA = "eip155:84532";
const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const MERCHANT = "0x1111111111111111111111111111111111111111";
const ATTACKER = "0x2222222222222222222222222222222222222222";

const policy: Policy = {
  profile: "mandate-required",
  windowMs: 60_000,
  perMandateCap: 1_000_000n, // 1 USDC
  envelope: { schemes: ["exact"], networks: [BASE_SEPOLIA], assets: [USDC] },
  validBeforeCeilingSeconds: 60,
  reorgMarginMs: 2_000,
  maxClockSkewMs: 5_000,
};

const account = privateKeyToAccount(generatePrivateKey());
const client = new x402Client().register(BASE_SEPOLIA, new ExactEvmScheme(account));

installAgentPayGuard(client, {
  policy,
  store: new InMemoryAtomicStore(),
  principalId: `payer:${account.address}`,
  // A trusted, provenance-verified mandate authorizing only the merchant.
  mandateVerifier: () => ({
    mandateId: "order-42",
    issuer: "did:example:trusted",
    constraints: { payTo: MERCHANT, maxAmount: 1_000_000n, asset: USDC, network: BASE_SEPOLIA },
  }),
  onAudit: (e) => console.log(`  [guard] ${e.kind}${e.decision ? " " + e.decision.reason : ""}`),
});

function req(payTo: string, amount: string) {
  return {
    x402Version: 2,
    resource: { url: "https://api.example/paid" },
    accepts: [{ scheme: "exact", network: BASE_SEPOLIA, asset: USDC, amount, payTo, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } }],
  };
}

async function tryPay(label: string, payTo: string, amount: string) {
  process.stdout.write(`${label}: `);
  try {
    await (client as never as { createPaymentPayload: (r: unknown) => Promise<unknown> }).createPaymentPayload(req(payTo, amount));
    console.log("SIGNED ✅");
  } catch (e) {
    console.log(`BLOCKED ⛔ (${e instanceof Error ? e.message.replace("Payment creation aborted: ", "") : String(e)})`);
  }
}

console.log("raw-viem example (signer co-located; NOT the precondition config)\n");
await tryPay("pay merchant $0.10", MERCHANT, "100000");
await tryPay("pay ATTACKER $0.10 (payTo-tamper)", ATTACKER, "100000");
await tryPay("pay merchant $2.00 (over cap)", MERCHANT, "2000000");
