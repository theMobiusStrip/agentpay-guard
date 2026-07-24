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
 * ALLOWED_HOSTS, STORE=sqlite|memory, STATE_DB, MAX_ACCOUNTING_WINDOW_MS. mcp
 * env: PROXY_URL (default http://127.0.0.1:4020).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  InMemoryAtomicStore,
  type AtomicStore,
  type RecoveryResult,
} from "@themobiusstrip/agentpay-guard";
import {
  openSqliteStore,
  type SqliteAtomicStore,
} from "@themobiusstrip/agentpay-guard/sqlite";
import {
  configFromEnv,
  storeConfigFromEnv,
} from "./config.js";
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
      throw new Error(
        "PAYER_PK must be a 0x-prefixed 32-byte hex private key.",
      );
    }
    return envKey as `0x${string}`;
  }
  const file = resolve(process.env.WALLET_FILE ?? ".agentpay-proxy-wallet.json");
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { payerKey?: string };
    if (!parsed.payerKey || !/^0x[0-9a-fA-F]{64}$/.test(parsed.payerKey)) {
      throw new Error(`${file} exists but has no valid payerKey.`);
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

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

async function closeSqliteAfterFailure(
  store: SqliteAtomicStore | undefined,
): Promise<void> {
  if (store === undefined) return;
  try {
    await store.close();
  } catch {
    // Preserve startup failure.
  }
}

async function serve(): Promise<void> {
  let config;
  let storeConfig;
  try {
    config = configFromEnv();
    storeConfig = storeConfigFromEnv(process.env, config.windowMs);
  } catch (e) {
    // Fail closed: a malformed money/config knob must stop the proxy starting,
    // not fall back to a default that silently widens the spend envelope.
    console.error(`config error: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }

  let sqliteStore: SqliteAtomicStore | undefined;
  let store: AtomicStore;
  let recovery: RecoveryResult;
  try {
    if (storeConfig.kind === "sqlite") {
      sqliteStore = await openSqliteStore(storeConfig.stateDb, {
        maxAccountingWindowMs: storeConfig.maxAccountingWindowMs,
      });
      store = sqliteStore;
    } else {
      store = new InMemoryAtomicStore();
    }
    recovery = await store.recoverAfterRestart(
      Date.now(),
      config.windowMs,
    );
  } catch (e) {
    await closeSqliteAfterFailure(sqliteStore);
    console.error(
      `store error: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exitCode = 1;
    return;
  }

  let key: `0x${string}`;
  try {
    key = loadOrCreateKey();
  } catch (e) {
    await closeSqliteAfterFailure(sqliteStore);
    console.error(
      `wallet error: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exitCode = 1;
    return;
  }

  let paymentProxy: ReturnType<typeof createPaymentProxy>;
  try {
    paymentProxy = createPaymentProxy(key, config, { store });
  } catch (e) {
    await closeSqliteAfterFailure(sqliteStore);
    console.error(
      `proxy error: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exitCode = 1;
    return;
  }
  const { app, account, policy } = paymentProxy;
  const server = app.listen(config.port, config.host, () => {
    console.log(`payment proxy on http://${config.host}:${config.port}/paid-fetch`);
    console.log(`  payer  : ${account.address}`);
    console.log(
      `  store  : ${
        sqliteStore === undefined
          ? "memory (volatile)"
          : `sqlite ${sqliteStore.path}`
      }`,
    );
    console.log(
      `  recover: ${recovery.markedUnknown} unknown, ${recovery.expired} expired`,
    );
    console.log(
      `  profile: ${policy.profile}` +
        (config.mandate ? ` (payee pinned ${config.mandate.payTo}, max ${config.mandate.maxAmount})` : ""),
    );
    if (config.host !== "127.0.0.1" && config.host !== "localhost") {
      console.log("  WARNING: bound to a non-loopback host. This process holds a signing key —");
      console.log("  authenticate the agent->proxy hop before exposing it.");
    }
  });

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (
    reason: string,
    exitCode: number,
  ): Promise<void> => {
    shutdownPromise ??= (async () => {
      console.log(`stopping payment proxy (${reason})`);
      try {
        await closeServer(server);
        await sqliteStore?.close();
      } catch (e) {
        console.error(
          `shutdown error: ${e instanceof Error ? e.message : String(e)}`,
        );
        process.exitCode = 1;
        return;
      }
      process.exitCode = exitCode;
    })();
    return shutdownPromise;
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT", 0);
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM", 0);
  });
  server.once("error", (error) => {
    console.error(`server error: ${error.message}`);
    void shutdown("server error", 1);
  });
}

const cmd = process.argv[2] ?? "serve";
switch (cmd) {
  case "serve":
    await serve();
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
