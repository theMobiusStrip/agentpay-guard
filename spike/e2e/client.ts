/**
 * Payer client for the e2e run: wrapFetchWithPayment + agentpay-guard installed
 * over the x402 v2 client hooks. This is the payment-proxy topology — the signer
 * lives here, below the guard, and a caller (the agent) reaches it over HTTP.
 *
 * REQUIRES: spike/e2e/.wallet.json (run e2e:wallet first) funded with Base
 * Sepolia USDC + ETH, plus a running e2e:server.
 * Run: npm run -w @agentpay-guard/spike e2e:client
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import {
  installAgentPayGuard,
  InMemoryAtomicStore,
  type Policy,
} from "../../packages/agentpay-guard/dist/index.js";

const ENDPOINT = process.env.X402_ENDPOINT ?? "http://localhost:4021/paid";
const BASE_SEPOLIA = "eip155:84532";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

const here = dirname(fileURLToPath(import.meta.url));
const wallet = JSON.parse(readFileSync(join(here, ".wallet.json"), "utf8")) as {
  privateKey: `0x${string}`;
  address: string;
};
const account = privateKeyToAccount(wallet.privateKey);

const policy: Policy = {
  profile: "budget-only",
  windowMs: 60_000,
  perMandateCap: 1_000_000n, // 1 USDC cap for the demo
  principalAggregateCap: 2_000_000n,
  envelope: { schemes: ["exact"], networks: [BASE_SEPOLIA], assets: [USDC.toLowerCase()] },
  validBeforeCeilingSeconds: 30,
  reorgMarginMs: 2_000,
  maxClockSkewMs: 5_000,
};

const client = new x402Client();
client.register(BASE_SEPOLIA, new ExactEvmScheme(account));

const guard = installAgentPayGuard(client, {
  policy,
  store: new InMemoryAtomicStore(),
  principalId: `payer:${account.address}`,
  onAudit: (e) => console.log(`[guard] ${e.kind}${e.reservationId ? " " + e.reservationId : ""}${e.detail ? " — " + e.detail : ""}`),
});

const fetchWithPay = wrapFetchWithPayment(fetch, client);

async function main() {
  console.log(`payer ${account.address} -> ${ENDPOINT}`);
  const res = await fetchWithPay(ENDPOINT);
  console.log(`status ${res.status}`);
  console.log("body:", await res.text());
  const settle = res.headers.get("PAYMENT-RESPONSE");
  if (settle) console.log("PAYMENT-RESPONSE:", settle);
  await guard.reconcile();
}

main().catch((e) => {
  console.error("client error:", e);
  process.exit(1);
});
