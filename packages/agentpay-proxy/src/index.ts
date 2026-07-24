/**
 * @themobiusstrip/agentpay-proxy — guarded x402 payment proxy for AI agents.
 *
 * The proxy holds the x402 client, agentpay-guard, and the signer in one
 * process out of the agent's reach; the agent gets a single `paid_fetch`
 * capability over HTTP or MCP. Programmatic entry: createPaymentProxy.
 */
export { createPaymentProxy } from "./proxy.js";
export type { PaymentProxy, ProxyHooks } from "./proxy.js";

export {
  configFromEnv,
  storeConfigFromEnv,
  DEFAULTS,
  DEFAULT_STATE_DB,
  BASE_SEPOLIA,
  BASE_SEPOLIA_USDC,
} from "./config.js";
export type {
  ProxyConfig,
  ProxyStoreConfig,
  PinnedMandate,
  StoreKind,
} from "./config.js";

export { runMcpForwarder } from "./mcp.js";
