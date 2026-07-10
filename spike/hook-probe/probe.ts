/**
 * G0 hook probe (Q1 / Q1b / Q1c / Q2 / TOCTOU) — runnable, OFFLINE.
 *
 * EIP-3009 signing is a local operation (no chain funds, no facilitator), so we
 * can empirically confirm the client-hook and nonce semantics the workflow agents
 * read from source, and prove agentpay-guard installs and gates the REAL SDK.
 *
 * Run: npm run -w @agentpay-guard/spike hook-probe
 */
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import {
  installAgentPayGuard,
  InMemoryAtomicStore,
  type Policy,
} from "../../packages/agentpay-guard/dist/index.js";

const BASE_SEPOLIA = "eip155:84532";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAYTO = "0x2222222222222222222222222222222222222222";

function syntheticPaymentRequired(amount: string, maxTimeoutSeconds = 20) {
  return {
    x402Version: 2,
    resource: { url: "https://api.example.com/paid" },
    accepts: [
      {
        scheme: "exact",
        network: BASE_SEPOLIA,
        asset: USDC,
        amount,
        payTo: PAYTO,
        maxTimeoutSeconds,
        extra: { name: "USDC", version: "2" },
      },
    ],
  };
}

function makeClient() {
  const account = privateKeyToAccount(generatePrivateKey());
  const client = new x402Client();
  client.register(BASE_SEPOLIA, new ExactEvmScheme(account as never));
  return { client, account };
}

const results: { id: string; pass: boolean; detail: string }[] = [];
function record(id: string, pass: boolean, detail: string) {
  results.push({ id, pass, detail });
}

async function main() {
  // --- Q1: hook fires pre-signing and exposes resolved {to,value,network,asset}
  {
    const { client } = makeClient();
    let ctxSeen: unknown;
    let hookFiredBeforePayload = false;
    client.onBeforePaymentCreation(async (ctx) => {
      ctxSeen = ctx;
      hookFiredBeforePayload = true;
      return;
    });
    const payload = await client.createPaymentPayload(syntheticPaymentRequired("100000") as never);
    const c = ctxSeen as { selectedRequirements?: Record<string, unknown>; paymentRequired?: { resource?: { url?: string } } };
    const sr = c?.selectedRequirements ?? {};
    const hasResolved =
      sr["payTo"] !== undefined &&
      sr["amount"] !== undefined &&
      sr["network"] !== undefined &&
      sr["asset"] !== undefined;
    record(
      "Q1: hook fires pre-signing with resolved fields",
      hookFiredBeforePayload && hasResolved && !!payload,
      `fired=${hookFiredBeforePayload} resolved={payTo,amount,network,asset}=${hasResolved} payloadCreated=${!!payload}`,
    );
    // Q1c: originating HTTP request exposure at the hook?
    const hasResourceUrl = !!c?.paymentRequired?.resource?.url;
    const hasHttpMethodBody =
      (c as Record<string, unknown>)["request"] !== undefined ||
      (sr as Record<string, unknown>)["method"] !== undefined;
    record(
      "Q1c: originating HTTP request (method/body) at hook",
      !hasHttpMethodBody, // expected: NOT exposed -> confirms request-side binding moves to wrapper
      `resourceUrl(server-declared)=${hasResourceUrl}; method/body-of-outgoing-request=${hasHttpMethodBody} (expected false)`,
    );
  }

  // --- Q1b: does a THROW in the hook abort (fail-closed) rather than proceed to sign?
  {
    const { client } = makeClient();
    client.onBeforePaymentCreation(async () => {
      throw new Error("probe-throw");
    });
    let aborted = false;
    let signedAnyway = false;
    try {
      const p = await client.createPaymentPayload(syntheticPaymentRequired("100000") as never);
      signedAnyway = !!p;
    } catch {
      aborted = true;
    }
    record(
      "Q1b: hook throw aborts before signing (fail-closed)",
      aborted && !signedAnyway,
      `aborted=${aborted} signedAnyway=${signedAnyway} (fail-open would be signedAnyway=true)`,
    );
  }

  // --- Q1b': abort:true return blocks
  {
    const { client } = makeClient();
    client.onBeforePaymentCreation(async () => ({ abort: true as const, reason: "probe-abort" }));
    let blocked = false;
    try {
      await client.createPaymentPayload(syntheticPaymentRequired("100000") as never);
    } catch (e) {
      blocked = /aborted/i.test(String(e));
    }
    record("Q1b': {abort:true} return blocks the payment", blocked, `blocked=${blocked}`);
  }

  // --- Q2: nonce origin + signed fields (validBefore = now + maxTimeoutSeconds, validAfter = 0)
  {
    const { client } = makeClient();
    const p1 = (await client.createPaymentPayload(syntheticPaymentRequired("100000", 20) as never)) as {
      payload: { authorization?: Record<string, unknown> };
    };
    const p2 = (await client.createPaymentPayload(syntheticPaymentRequired("100000", 20) as never)) as {
      payload: { authorization?: Record<string, unknown> };
    };
    const a1 = p1.payload.authorization ?? {};
    const a2 = p2.payload.authorization ?? {};
    const nonce1 = String(a1["nonce"] ?? "");
    const nonce2 = String(a2["nonce"] ?? "");
    const noncesDiffer = nonce1 !== "" && nonce1 !== nonce2; // SDK mints fresh random per call
    const validAfterZero = String(a1["validAfter"]) === "0";
    const vb = Number(a1["validBefore"]);
    const nowS = Math.floor(Date.now() / 1000);
    const vbSane = vb > nowS && vb <= nowS + 25; // ~ now + 20s
    record(
      "Q2: nonce SDK-internal random (differs per call), not caller-controllable",
      noncesDiffer,
      `nonce1=${nonce1.slice(0, 14)}… nonce2=${nonce2.slice(0, 14)}… differ=${noncesDiffer}`,
    );
    record(
      "Q2: signed EIP-3009 fields (validAfter=0, validBefore≈now+timeout)",
      validAfterZero && vbSane,
      `validAfter=${a1["validAfter"]} validBefore=${a1["validBefore"]} sane=${vbSane}`,
    );
  }

  // --- End-to-end: agentpay-guard installed on the REAL client allows + blocks
  {
    const policy: Policy = {
      profile: "budget-only",
      windowMs: 60_000,
      perMandateCap: 150_000n,
      envelope: { schemes: ["exact"], networks: [BASE_SEPOLIA], assets: [USDC.toLowerCase()] },
      validBeforeCeilingSeconds: 30,
      reorgMarginMs: 2_000,
      maxClockSkewMs: 5_000,
    };
    const { client } = makeClient();
    // Use the real system clock: the SDK signs validBefore against wall time, so
    // the guard's TOCTOU check must reason on the same clock (in production they
    // are the same). A fake clock far from real time would (correctly) trip the
    // validBefore divergence check.
    installAgentPayGuard(client, {
      policy,
      store: new InMemoryAtomicStore(),
      principalId: "probe",
    });

    // 1st: within cap -> allowed (payload signs).
    let firstOk = false;
    try {
      const p = await client.createPaymentPayload(syntheticPaymentRequired("100000") as never);
      firstOk = !!p;
    } catch {
      firstOk = false;
    }
    // 2nd: 100000 + 100000 = 200000 > 150000 cap -> guard blocks (abort).
    let secondBlocked = false;
    try {
      await client.createPaymentPayload(syntheticPaymentRequired("100000") as never);
    } catch (e) {
      secondBlocked = /cap_exceeded|aborted/i.test(String(e));
    }
    record(
      "E2E: guard allows in-cap, blocks over-cap on the REAL SDK client",
      firstOk && secondBlocked,
      `firstAllowed=${firstOk} secondBlocked=${secondBlocked}`,
    );

    // Out-of-envelope ASSET on a registered network -> the hook fires and the
    // guard's envelope check blocks it (the SDK itself rejects unregistered
    // network/scheme even earlier; this exercises the guard's own gate).
    let envBlocked = false;
    let envReason = "";
    try {
      const req = syntheticPaymentRequired("1");
      req.accepts[0]!.asset = "0x000000000000000000000000000000000000dEaD";
      await client.createPaymentPayload(req as never);
    } catch (e) {
      envReason = String(e);
      envBlocked = /envelope_asset|aborted/i.test(envReason);
    }
    record("E2E: guard fails closed on out-of-envelope asset", envBlocked, `blocked=${envBlocked} err=${envReason.slice(0, 80)}`);
  }

  // Report
  let allPass = true;
  console.log("\n=== G0 hook probe report (offline) ===\n");
  for (const r of results) {
    if (!r.pass) allPass = false;
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id}\n        ${r.detail}`);
  }
  console.log(`\n=== ${allPass ? "ALL PASS" : "SOME FAILED"} ===\n`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error("probe crashed:", e);
  process.exit(2);
});
