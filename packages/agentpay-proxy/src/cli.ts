#!/usr/bin/env node
/**
 * agentpay-proxy CLI.
 *
 *   agentpay-proxy [serve]   start the guarded payment proxy (HTTP)
 *   agentpay-proxy mcp       stdio MCP forwarder -> a running proxy
 *
 * serve env: PAYER_PK (else WALLET_FILE, default ./.agentpay-proxy-wallet.json,
 * auto-generated on first run — TESTNET ONLY, never a real key), HOST, PORT,
 * WINDOW_MS, CAP, AGG_CAP, CEILING_S, MANDATE=1 + PIN_PAYTO/PIN_MAX,
 * ALLOWED_HOSTS. mcp env: PROXY_URL (default http://127.0.0.1:4020).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { configFromEnv } from "./config.js";
import { createPaymentProxy } from "./proxy.js";
import { runMcpForwarder } from "./mcp.js";

const USAGE = `agentpay-proxy — guarded x402 payment proxy (Base Sepolia USDC)

Usage:
  agentpay-proxy [serve]   start the proxy (default)
  agentpay-proxy mcp       stdio MCP forwarder for a running proxy
  agentpay-proxy --help
`;

function loadOrCreateKey(): `0x${string}` {
  const envKey = process.env.PAYER_PK;
  if (envKey) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(envKey)) {
      console.error("PAYER_PK must be a 0x-prefixed 32-byte hex private key.");
      process.exit(1);
    }
    return envKey as `0x${string}`;
  }
  const file = resolve(process.env.WALLET_FILE ?? ".agentpay-proxy-wallet.json");
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { payerKey?: string };
    if (!parsed.payerKey || !/^0x[0-9a-fA-F]{64}$/.test(parsed.payerKey)) {
      console.error(`${file} exists but has no valid payerKey.`);
      process.exit(1);
    }
    return parsed.payerKey as `0x${string}`;
  }
  const payerKey = generatePrivateKey();
  const address = privateKeyToAccount(payerKey).address;
  writeFileSync(file, JSON.stringify({ payerKey, address }, null, 2), { mode: 0o600 });
  console.log(`Generated payer wallet ${address} -> ${file}`);
  console.log("TESTNET ONLY — keep this file out of git. Fund on Base Sepolia:");
  console.log("  USDC : https://faucet.circle.com  (pick Base Sepolia)");
  console.log("  ETH  : not needed — the facilitator submits the settlement tx.");
  return payerKey;
}

function serve(): void {
  let config;
  try {
    config = configFromEnv();
  } catch (e) {
    // Fail closed: a malformed money/config knob must stop the proxy starting,
    // not fall back to a default that silently widens the spend envelope.
    console.error(`config error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  const key = loadOrCreateKey();
  const { app, account, policy } = createPaymentProxy(key, config);
  app.listen(config.port, config.host, () => {
    console.log(`payment proxy on http://${config.host}:${config.port}/paid-fetch`);
    console.log(`  payer  : ${account.address}`);
    console.log(
      `  profile: ${policy.profile}` +
        (config.mandate ? ` (payee pinned ${config.mandate.payTo}, max ${config.mandate.maxAmount})` : ""),
    );
    if (config.host !== "127.0.0.1" && config.host !== "localhost") {
      console.log("  WARNING: bound to a non-loopback host. This process holds a signing key —");
      console.log("  authenticate the agent->proxy hop before exposing it.");
    }
  });
}

const cmd = process.argv[2] ?? "serve";
switch (cmd) {
  case "serve":
    serve();
    break;
  case "mcp":
    await runMcpForwarder(process.env.PROXY_URL ?? "http://127.0.0.1:4020");
    break;
  case "--help":
  case "-h":
  case "help":
    console.log(USAGE);
    break;
  default:
    console.error(`unknown command: ${cmd}\n`);
    console.error(USAGE);
    process.exit(1);
}
