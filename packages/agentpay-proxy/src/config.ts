/**
 * Proxy configuration. MVP envelope is fixed to the guard's tested slice —
 * `exact` + Base Sepolia + USDC — everything else fails closed. Knobs cover
 * budget, per-payment ceiling, authorization-lifetime ceiling, optional pinned
 * mandate, and optional origin allowlist for the fetch capability.
 */

export const BASE_SEPOLIA = "eip155:84532" as const;
/** Base Sepolia USDC (lowercased — guard envelope requires lowercase assets). */
export const BASE_SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e" as const;

export interface PinnedMandate {
  /** Payee the policy binds every payment to (lowercased). */
  payTo: string;
  /** Max amount per payment, atomic token units (USDC 6-decimals). */
  maxAmount: bigint;
}

export interface ProxyConfig {
  /** Bind host. Default 127.0.0.1 — the proxy holds a signing key; expose deliberately. */
  host: string;
  port: number;
  /** Rolling budget window, ms. Also bounds the effective validBefore ceiling. */
  windowMs: number;
  /** Per-mandate cumulative cap per window, atomic units. */
  perMandateCap: bigint;
  /** Optional per-payment ceiling, atomic units. Independent of mandate mode. */
  maxPaymentAmount?: bigint;
  /** Aggregate cap across ALL mandates — salami-drain stop. */
  principalAggregateCap: bigint;
  /**
   * Max authorization lifetime the proxy will sign, seconds. Effective ceiling
   * is min(ceilingSeconds, windowMs/1000). The public x402.org demo requests
   * 300s; tighten for your own merchants.
   */
  ceilingSeconds: number;
  /** Present => mandate-required profile with these pinned constraints. */
  mandate?: PinnedMandate;
  /** If set, paid-fetch only fetches URLs whose host is in this list. */
  allowedHosts?: readonly string[];
}

export type StoreKind = "sqlite" | "memory";

export interface ProxyStoreConfig {
  kind: StoreKind;
  stateDb: string;
  maxAccountingWindowMs: number;
}

export const DEFAULT_STATE_DB = ".agentpay-proxy-state.sqlite";

export const DEFAULTS: Readonly<Omit<ProxyConfig, "mandate" | "allowedHosts">> = {
  host: "127.0.0.1",
  port: 4020,
  windowMs: 300_000,
  perMandateCap: 100_000n, // $0.10
  principalAggregateCap: 200_000n, // $0.20
  ceilingSeconds: 300,
};

/**
 * Build a ProxyConfig from environment variables:
 * HOST, PORT, WINDOW_MS, CAP, AGG_CAP, MAX_PAYMENT, CEILING_S
 * (numbers/atomic bigints),
 * MANDATE=1 + PIN_PAYTO + PIN_MAX (pinned mandate; PIN_PAYTO required),
 * ALLOWED_HOSTS (comma-separated host[:port] list).
 * Throws on malformed numeric values — misconfigured money knobs must not
 * silently fall back.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const cfg: ProxyConfig = {
    host: env.HOST ?? DEFAULTS.host,
    port: intFromEnv(env, "PORT", DEFAULTS.port),
    windowMs: intFromEnv(env, "WINDOW_MS", DEFAULTS.windowMs),
    perMandateCap: bigintFromEnv(env, "CAP", DEFAULTS.perMandateCap),
    principalAggregateCap: bigintFromEnv(env, "AGG_CAP", DEFAULTS.principalAggregateCap),
    ceilingSeconds: intFromEnv(env, "CEILING_S", DEFAULTS.ceilingSeconds),
  };
  if (env.MAX_PAYMENT !== undefined && env.MAX_PAYMENT !== "") {
    cfg.maxPaymentAmount = bigintFromEnv(env, "MAX_PAYMENT", 0n);
  }
  if (env.MANDATE === "1") {
    const payTo = env.PIN_PAYTO?.toLowerCase();
    if (!payTo || !/^0x[0-9a-f]{40}$/.test(payTo)) {
      throw new Error("MANDATE=1 requires PIN_PAYTO=<0x address> (the payee to bind payments to)");
    }
    cfg.mandate = { payTo, maxAmount: bigintFromEnv(env, "PIN_MAX", 10_000n) };
  }
  const hosts = env.ALLOWED_HOSTS
    ?.split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== "");
  if (hosts && hosts.length > 0) cfg.allowedHosts = hosts;
  return cfg;
}

/** Parse CLI-only persistent-store settings. Embedded use injects a store. */
export function storeConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  activeWindowMs: number = DEFAULTS.windowMs,
): ProxyStoreConfig {
  if (!Number.isSafeInteger(activeWindowMs) || activeWindowMs <= 0) {
    throw new Error("activeWindowMs must be a positive safe integer");
  }
  const rawKind = env.STORE ?? "sqlite";
  if (rawKind !== "sqlite" && rawKind !== "memory") {
    throw new Error(
      `STORE must be "sqlite" or "memory", got "${rawKind}"`,
    );
  }
  const stateDb = env.STATE_DB ?? DEFAULT_STATE_DB;
  if (stateDb.trim() === "") {
    throw new Error("STATE_DB must not be empty");
  }
  const maxAccountingWindowMs = intFromEnv(
    env,
    "MAX_ACCOUNTING_WINDOW_MS",
    activeWindowMs,
  );
  if (maxAccountingWindowMs < activeWindowMs) {
    throw new Error(
      "MAX_ACCOUNTING_WINDOW_MS must be at least WINDOW_MS",
    );
  }
  return { kind: rawKind, stateDb, maxAccountingWindowMs };
}

function intFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${key} must be a positive integer, got "${raw}"`);
  return n;
}

function bigintFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: bigint): bigint {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a non-negative integer (atomic units), got "${raw}"`);
  return BigInt(raw);
}
