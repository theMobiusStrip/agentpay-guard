/**
 * The 2-arm runner. Drives a fixture through an arm over the mock settlement
 * ledger, using the REAL x402 createPaymentPayload hook path (before/after
 * hooks fire; the guard reserves/blocks pre-signing). Settlement is simulated
 * deterministically. Replay is routed through the server-side middleware arm.
 */
import { IdempotencyGuard, InMemoryClaimStore } from "@themobiusstrip/x402-idempotency-middleware";
import type { AgentPayGuard, VerifiedMandate } from "@themobiusstrip/agentpay-guard";
import {
  buildArmA,
  buildArmB,
  payerAddress,
  resetDedupSeq,
  type ArmAMode,
  type ArmConfig,
} from "./arms.js";
import { Ledger } from "./ledger.js";
import { computeMetrics } from "./oracle.js";
import {
  BASE_SEPOLIA,
  USDC,
  type ArmName,
  type Fixture,
  type Metrics,
} from "./scenario.js";
import type { PolicyProfile } from "@themobiusstrip/agentpay-guard";

function paymentRequired(fixture: Fixture) {
  return {
    x402Version: 2,
    resource: { url: fixture.requirement.resourceUrl ?? fixture.truth.expectedResource },
    accepts: [
      {
        scheme: "exact",
        network: fixture.requirement.network ?? BASE_SEPOLIA,
        asset: fixture.requirement.asset ?? USDC,
        amount: fixture.requirement.amount,
        payTo: fixture.requirement.payTo,
        maxTimeoutSeconds: fixture.requirement.maxTimeoutSeconds,
        extra: { name: "USDC", version: "2" },
      },
    ],
  };
}

function mandateForFixture(fixture: Fixture, mandateId: string): VerifiedMandate | undefined {
  if (!fixture.mandate) return undefined;
  const c: VerifiedMandate["constraints"] = {};
  if (fixture.mandate.payTo !== undefined) c.payTo = fixture.mandate.payTo;
  if (fixture.mandate.maxAmount !== undefined) c.maxAmount = BigInt(fixture.mandate.maxAmount);
  if (fixture.mandate.asset !== undefined) c.asset = fixture.mandate.asset;
  if (fixture.mandate.network !== undefined) c.network = fixture.mandate.network as never;
  if (fixture.mandate.resourceUrl !== undefined) c.resourceUrl = fixture.mandate.resourceUrl;
  return { mandateId, issuer: "did:bench:trusted", constraints: c };
}

function nowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

async function settleCreated(
  ledger: Ledger,
  payload: { payload: Record<string, unknown> },
  fixture: Fixture,
  guard: AgentPayGuard | undefined,
  req: ReturnType<typeof paymentRequired>,
  advanceGuard: boolean,
): Promise<void> {
  const auth = payload.payload["authorization"] as Record<string, unknown>;
  const nonce = String(auth["nonce"]);
  // A signed authorization is a committed spend (it can settle on-chain), so it
  // is recorded regardless of whether we advance the guard's state machine.
  ledger.recordSettlement({
    payer: payerAddress(),
    payTo: String(auth["to"]).toLowerCase(),
    amount: BigInt(String(auth["value"])),
    asset: fixture.requirement.asset ?? USDC,
    blockTs: nowMs(),
    nonce,
  });
  ledger.recordDelivery({ requestId: nonce, nonce, delivered: !fixture.withholdService });
  // Squat leaves reservations PENDING (no settle) so the per-payee reservation
  // limit — which bounds concurrent pending reservations — actually engages.
  if (guard && advanceGuard) {
    await guard.onResponse({
      paymentPayload: payload as never,
      requirements: req.accepts[0] as never,
      settleResponse: { success: true },
    });
  }
}

/** One create+settle attempt. Returns latency + whether it was blocked. */
async function attempt(
  client: { createPaymentPayload: (r: unknown) => Promise<unknown> },
  guard: AgentPayGuard | undefined,
  req: ReturnType<typeof paymentRequired>,
  ledger: Ledger,
  fixture: Fixture,
  advanceGuard = true,
): Promise<{ blocked: boolean; latencyMs: number }> {
  const t0 = process.hrtime.bigint();
  let payload: unknown;
  try {
    payload = await client.createPaymentPayload(req);
  } catch {
    const latencyMs = Number(process.hrtime.bigint() - t0) / 1_000_000;
    return { blocked: true, latencyMs };
  }
  const latencyMs = Number(process.hrtime.bigint() - t0) / 1_000_000;
  await settleCreated(
    ledger,
    payload as { payload: Record<string, unknown> },
    fixture,
    guard,
    req,
    advanceGuard,
  );
  return { blocked: false, latencyMs };
}

export interface RunResult {
  metrics: Metrics;
  note: string;
}

export async function runFixture(
  fixture: Fixture,
  arm: ArmName,
  profile: PolicyProfile,
  cfg: ArmConfig,
  armAMode: ArmAMode = "async",
): Promise<RunResult> {
  resetDedupSeq();
  const ledger = new Ledger();
  const req = paymentRequired(fixture);
  const unit = BigInt(fixture.requirement.amount);

  // Replay is a server-side class: route through the middleware arm.
  if (fixture.kind === "replay") {
    return runReplay(fixture, arm, cfg, ledger, req, unit);
  }

  let seq = 0;
  const build = () =>
    arm === "native"
      ? buildArmA(cfg, armAMode)
      : buildArmB(cfg, profile, () => mandateForFixture(fixture, `m-${fixture.distinctMandates ? seq++ : 0}`));

  const { client, guard } = build();

  const latencies: number[] = [];
  let blocked = 0;
  let settled = 0;
  const count = fixture.count ?? 1;

  if (fixture.kind === "concurrent" || fixture.kind === "squat") {
    // Squat holds reservations pending (advanceGuard=false) so the per-payee
    // limit engages; retry-storm settles normally.
    const advanceGuard = fixture.kind !== "squat";
    const results = await Promise.all(
      Array.from({ length: count }, () =>
        attempt(client as never, guard, req, ledger, fixture, advanceGuard),
      ),
    );
    for (const r of results) {
      latencies.push(r.latencyMs);
      if (r.blocked) blocked++;
      else settled++;
    }
  } else {
    // single / sequence / squat
    for (let i = 0; i < count; i++) {
      const r = await attempt(client as never, guard, req, ledger, fixture);
      latencies.push(r.latencyMs);
      if (r.blocked) blocked++;
      else settled++;
    }
  }

  const metrics = computeMetrics({
    ledger,
    authorizedPayTo: fixture.truth.authorizedPayTo,
    maxAuthorizedAmount: BigInt(fixture.truth.maxAuthorizedAmount),
    unitAmount: unit,
    benign: fixture.benign,
    blockedCount: blocked,
    settledCount: settled,
    grants: settled,
    latenciesMs: latencies,
  });
  return { metrics, note: `${settled} settled / ${blocked} blocked of ${count}` };
}

/**
 * Protocol replay: one payer-signed authorization presented N times to the
 * resource server. Arm "native" = server without the middleware (grants each
 * presentation under a fresh payment-identifier); arm "native+guard" = server
 * with the idempotency middleware (one grant, rest cached).
 */
async function runReplay(
  fixture: Fixture,
  arm: ArmName,
  cfg: ArmConfig,
  ledger: Ledger,
  req: ReturnType<typeof paymentRequired>,
  unit: bigint,
): Promise<RunResult> {
  // Produce one real signed authorization.
  const { client } = buildArmA(cfg); // arm-agnostic: the signed auth is identical
  const payload = (await (client as never as {
    createPaymentPayload: (r: unknown) => Promise<{ payload: Record<string, unknown> }>;
  }).createPaymentPayload(req));
  const auth = payload.payload["authorization"] as Record<string, unknown>;
  const nonce = String(auth["nonce"]);
  const payloadLike = {
    accepted: { asset: fixture.requirement.asset ?? USDC, network: BASE_SEPOLIA },
    payload: payload.payload,
  };

  // Payer settles exactly once (one on-chain settlement).
  ledger.recordSettlement({
    payer: payerAddress(),
    payTo: String(auth["to"]).toLowerCase(),
    amount: unit,
    asset: fixture.requirement.asset ?? USDC,
    blockTs: nowMs(),
    nonce,
  });

  const N = fixture.count ?? 5;
  let grants = 0;
  if (arm === "native") {
    // Naive server grants every presentation (replayer varies the identifier).
    for (let i = 0; i < N; i++) {
      grants++;
      ledger.recordDelivery({ requestId: `${nonce}-${i}`, nonce, delivered: true });
    }
  } else {
    const guard = new IdempotencyGuard({ store: new InMemoryClaimStore(), now: () => nowMs() });
    for (let i = 0; i < N; i++) {
      const begin = await guard.begin(payloadLike);
      if (begin.kind === "proceed") {
        grants++;
        ledger.recordDelivery({ requestId: `${nonce}-${i}`, nonce, delivered: true });
        await guard.complete(begin.key, begin.claimToken, { status: 200, headers: {}, body: {} });
      }
      // "replay" / "in_progress" => cached, NOT a new grant.
    }
  }

  const metrics = computeMetrics({
    ledger,
    authorizedPayTo: fixture.truth.authorizedPayTo,
    maxAuthorizedAmount: BigInt(fixture.truth.maxAuthorizedAmount),
    unitAmount: unit,
    benign: fixture.benign,
    blockedCount: 0,
    settledCount: 1,
    grants,
    latenciesMs: [],
  });
  return { metrics, note: `${grants} grants for 1 settlement (presented ${N}×)` };
}
