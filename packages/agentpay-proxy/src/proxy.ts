/**
 * createPaymentProxy — the guarded x402 payment proxy as an embeddable Express app.
 *
 * Topology (the guard's deployment precondition, not a style choice):
 *
 *   agent (no keys) --HTTP/MCP--> proxy [x402 client + agentpay-guard + signer] --x402--> paid site
 *
 * The agent gets ONE capability: POST /paid-fetch {"url", "intentId"?}. It
 * cannot reach the signer, the policy, or the store. Every payment is
 * evaluated below the model, fail-closed.
 *
 * Dedup semantics: each request runs under a DedupContext carrying an
 * intentId (caller-supplied, else a fresh UUID). Distinct requests are
 * distinct purchase intents; a caller retrying the SAME logical purchase
 * passes the same intentId and the duplicate-authorization guard refuses a
 * second signature for it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import express from "express";
import type { Express } from "express";
import { privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem/accounts";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import {
  installAgentPayGuard,
  InMemoryAtomicStore,
  type AgentPayGuard,
  type AtomicStore,
  type AuditSink,
  type DedupContext,
  type Policy,
  type VerifiedMandate,
} from "@themobiusstrip/agentpay-guard";
import { BASE_SEPOLIA, BASE_SEPOLIA_USDC, type ProxyConfig } from "./config.js";

export interface ProxyHooks {
  /** Receives every guard audit event. Default: one console line per event. */
  onAudit?: AuditSink;
  /**
   * Overrides the mandate source. Default: config.mandate pinned constraints
   * (mandate-required profile) or none (budget-only). Real deployments verify
   * a signed mandate's provenance here — constraints must come from outside
   * the model.
   */
  mandateVerifier?: () => VerifiedMandate | undefined;
  /** Swap the in-memory store for a shared one when running multiple workers. */
  store?: AtomicStore;
}

export interface PaymentProxy {
  app: Express;
  account: PrivateKeyAccount;
  guard: AgentPayGuard;
  policy: Policy;
}

/** Cap on caller-supplied intentId — bounds store-key growth, fails closed over. */
export const MAX_INTENT_ID_LEN = 256;

/**
 * Parse + vet the fetch target. Rejects anything that isn't an http(s) URL by
 * PARSED protocol (not just a regex prefix — blocks javascript:/file:/data: and
 * a value that passes a prefix test but fails WHATWG parse), and enforces the
 * host allowlist when configured. Returns the normalized url + host or an error.
 *
 * Exported for unit tests; NOT re-exported from index.ts (internal to the pkg).
 */
export function vetTarget(
  raw: unknown,
  allowedHosts: readonly string[] | undefined,
): { url: string; host: string } | { error: string } {
  if (typeof raw !== "string" || raw === "") {
    return { error: 'body must be {"url": "http(s)://...", "intentId"?: string}' };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: "url is not a valid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: `unsupported url scheme ${parsed.protocol} (http/https only)` };
  }
  const host = parsed.host.toLowerCase();
  if (allowedHosts && !allowedHosts.includes(host)) {
    return { error: `host ${host} not in ALLOWED_HOSTS` };
  }
  return { url: parsed.toString(), host };
}

export function createPaymentProxy(
  payerKey: `0x${string}`,
  config: ProxyConfig,
  hooks: ProxyHooks = {},
): PaymentProxy {
  const maxPaymentAmount: unknown = config.maxPaymentAmount;
  if (
    maxPaymentAmount !== undefined &&
    (typeof maxPaymentAmount !== "bigint" || maxPaymentAmount < 0n)
  ) {
    throw new Error("maxPaymentAmount must be a non-negative bigint");
  }

  const account = privateKeyToAccount(payerKey);

  const policy: Policy = {
    profile: config.mandate ? "mandate-required" : "budget-only",
    windowMs: config.windowMs,
    perMandateCap: config.perMandateCap,
    ...(maxPaymentAmount !== undefined
      ? { maxPaymentAmount }
      : {}),
    principalAggregateCap: config.principalAggregateCap,
    envelope: {
      schemes: ["exact"],
      networks: [BASE_SEPOLIA],
      assets: [BASE_SEPOLIA_USDC],
    },
    validBeforeCeilingSeconds: config.ceilingSeconds,
    reorgMarginMs: 2_000,
    maxClockSkewMs: 5_000,
  };

  const onAudit: AuditSink =
    hooks.onAudit ??
    ((e) =>
      console.log(
        `[guard] ${e.kind}` +
          (e.decision ? ` ${e.decision.decision}/${e.decision.reason}` : "") +
          (e.payment ? ` ${e.payment.value} -> ${e.payment.payTo}` : "") +
          (e.detail ? ` — ${e.detail}` : ""),
      ));

  const pinned = config.mandate;
  const mandateVerifier =
    hooks.mandateVerifier ??
    (pinned
      ? (): VerifiedMandate => ({
          mandateId: "pinned-mandate",
          issuer: "did:agentpay-proxy:operator",
          constraints: {
            payTo: pinned.payTo,
            maxAmount: pinned.maxAmount,
            asset: BASE_SEPOLIA_USDC,
            network: BASE_SEPOLIA,
          },
        })
      : undefined);

  const client = new x402Client();
  client.register(BASE_SEPOLIA, new ExactEvmScheme(account));

  // Request-scoped dedup context: resolveDedupContext runs inside the SDK's
  // payment hooks, so the per-request intentId travels via AsyncLocalStorage.
  const dedupAls = new AsyncLocalStorage<DedupContext>();

  const guard = installAgentPayGuard(client, {
    policy,
    store: hooks.store ?? new InMemoryAtomicStore(),
    principalId: `payer:${account.address}`,
    resolveDedupContext: () => dedupAls.getStore() ?? {},
    ...(mandateVerifier ? { mandateVerifier } : {}),
    onAudit,
  });

  // When a host allowlist is set, the proxy holds a key and must not be
  // redirect-escaped: an allowed host that 302s to an internal/disallowed host
  // would otherwise be followed by undici (default redirect:"follow"), turning
  // the allowlist into SSRF. Refuse redirects in that mode — the vetted initial
  // host is then the ONLY host reached. Without an allowlist the proxy is an
  // open fetch relay (loopback-bound by default); redirects follow as usual.
  const baseFetch: typeof fetch = config.allowedHosts
    ? (input, init) => fetch(input, { ...init, redirect: "error" })
    : fetch;
  const fetchWithPay = wrapFetchWithPayment(baseFetch, client);

  const app = express();
  app.use(express.json());

  app.get("/healthz", (_req, res) => {
    const ready = guard.isHealthy();
    res.status(ready ? 200 : 503).json({
      ready,
      store: ready ? "ready" : "unavailable",
      payer: account.address,
      profile: policy.profile,
    });
  });

  app.post("/paid-fetch", async (req, res) => {
    if (!guard.isHealthy()) {
      res.status(503).json({
        error: "payment store unavailable; restart and recover required",
      });
      return;
    }
    const body = req.body as { url?: unknown; intentId?: unknown } | undefined;
    const target = vetTarget(body?.url, config.allowedHosts);
    if ("error" in target) {
      res.status(400).json({ error: target.error });
      return;
    }
    if (typeof body?.intentId === "string" && body.intentId.length > MAX_INTENT_ID_LEN) {
      res.status(400).json({ error: `intentId exceeds ${MAX_INTENT_ID_LEN} chars` });
      return;
    }
    const intentId =
      typeof body?.intentId === "string" && body.intentId.trim() !== ""
        ? body.intentId
        : randomUUID();
    try {
      const r = await dedupAls.run({ intentId }, () => fetchWithPay(target.url));
      const settlement = r.headers.get("PAYMENT-RESPONSE"); // settlement receipt (tx hash inside)
      const responseBody = await r.text();
      res.status(200).json({
        status: r.status,
        intentId,
        body: responseBody,
        ...(settlement ? { settlement } : {}),
      });
      try {
        await guard.reconcile();
      } catch {
        // Paid response is already delivered. Reconcile latched readiness, so
        // later paid requests fail closed until restart and recovery.
      }
    } catch (e) {
      if (guard.isHealthy()) {
        try {
          await guard.reconcile();
        } catch {
          // reconcile latches unhealthy; response below stays generic.
        }
      }
      // Guard blocks surface as "Payment creation aborted: <reason>".
      const healthy = guard.isHealthy();
      res.status(healthy ? 502 : 503).json({
        error: healthy
          ? e instanceof Error
            ? e.message
            : String(e)
          : "payment store unavailable; restart and recover required",
        intentId,
      });
    }
  });

  return { app, account, guard, policy };
}
