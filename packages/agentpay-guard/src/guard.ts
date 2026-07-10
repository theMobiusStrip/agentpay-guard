import { type AuditSink, noopAudit } from "./audit.js";
import { type Clock, safeReleaseAtMs, systemClock } from "./clock.js";
import { evaluatePayment } from "./evaluate.js";
import { type DedupContext } from "./policy/dedup.js";
import type { AtomicStore } from "./store/types.js";
import type {
  Decision,
  GuardDecision,
  Policy,
  ResolvedPayment,
  VerifiedMandate,
} from "./types.js";
import type {
  PaymentCreatedContextLike,
  PaymentCreationContextLike,
  PaymentCreationFailureContextLike,
  PaymentResponseContextLike,
  X402ClientLike,
  X402PaymentRequirementsLike,
} from "./x402-types.js";

export interface InstallOptions {
  policy: Policy;
  store: AtomicStore;
  principalId: string;
  clock?: Clock;
  /**
   * Verifies mandate PROVENANCE (issuer, signature, expiry) and returns the
   * trusted mandate to bind against, or undefined if none. In `mandate-required`
   * profile, undefined => block.
   */
  mandateVerifier?: (
    ctx: PaymentCreationContextLike,
  ) => Promise<VerifiedMandate | undefined> | VerifiedMandate | undefined;
  /**
   * Supplies the payer-owned dedup context (payment-identifier / intent id).
   * Without it the guard falls back to mandate+resource-derived intent.
   */
  resolveDedupContext?: (ctx: PaymentCreationContextLike) => DedupContext;
  /**
   * Optional predicate requesting human escalation for a payment. Default
   * handling is fail-closed (abort). Provide `onEscalate` to override per case.
   */
  escalationPolicy?: (
    payment: ResolvedPayment,
    mandate: VerifiedMandate | undefined,
  ) => boolean;
  /**
   * Host escalation handler. Returns the final decision for an escalated
   * payment. Absent => escalate defaults to "block" (never a silent fail-open).
   */
  onEscalate?: (
    payment: ResolvedPayment,
    mandate: VerifiedMandate | undefined,
  ) => Promise<Decision> | Decision;
  onAudit?: AuditSink;
}

/** Correlation entry linking a reservation across the before/after/failure hooks. */
interface PendingEntry {
  reservationId: string;
  payment: ResolvedPayment;
  reservedAtSeconds: number;
  horizonSeconds: number;
  dedupKey?: string;
}

function requirementsSignature(r: X402PaymentRequirementsLike): string {
  return `${r.network}|${r.scheme}|${r.asset.toLowerCase()}|${r.payTo.toLowerCase()}|${r.amount}`;
}

function toResolvedPayment(r: X402PaymentRequirementsLike, resourceUrl?: string): ResolvedPayment {
  const base: ResolvedPayment = {
    scheme: r.scheme,
    network: r.network as ResolvedPayment["network"],
    asset: r.asset.toLowerCase(),
    payTo: r.payTo.toLowerCase(),
    value: safeBigInt(r.amount),
    maxTimeoutSeconds: r.maxTimeoutSeconds,
  };
  return resourceUrl === undefined ? base : { ...base, resourceUrl };
}

/** Parse a decimal string to bigint; -1n signals an unresolved/invalid amount. */
function safeBigInt(s: string): bigint {
  try {
    if (!/^\d+$/.test(s.trim())) return -1n;
    return BigInt(s.trim());
  } catch {
    return -1n;
  }
}

/**
 * Extract the EIP-3009 authorization fields from a signed exact-scheme payload
 * for the onAfterPaymentCreation TOCTOU check. Returns undefined if the payload
 * shape is unrecognized (we then audit but cannot compare).
 */
function extractSignedAuth(
  payload: Record<string, unknown>,
): { to?: string; value?: bigint; validBefore?: number; nonce?: string } | undefined {
  const auth = (payload["authorization"] ?? payload["auth"]) as
    | Record<string, unknown>
    | undefined;
  if (!auth || typeof auth !== "object") return undefined;
  const to = typeof auth["to"] === "string" ? (auth["to"] as string).toLowerCase() : undefined;
  const value =
    typeof auth["value"] === "string" || typeof auth["value"] === "number"
      ? safeBigInt(String(auth["value"]))
      : undefined;
  const vb = auth["validBefore"];
  const validBefore =
    typeof vb === "string" || typeof vb === "number" ? Number(vb) : undefined;
  const nonce = typeof auth["nonce"] === "string" ? (auth["nonce"] as string).toLowerCase() : undefined;
  const out: { to?: string; value?: bigint; validBefore?: number; nonce?: string } = {};
  if (to !== undefined) out.to = to;
  if (value !== undefined && value >= 0n) out.value = value;
  if (validBefore !== undefined && Number.isFinite(validBefore)) out.validBefore = validBefore;
  if (nonce !== undefined) out.nonce = nonce;
  return out;
}

/**
 * Handle to a guard installed on an x402 client. Exposes the lifecycle
 * transitions a transport/harness drives (submit/settle/reconcile) so the
 * reservation state machine can advance beyond payload creation.
 */
export class AgentPayGuard {
  /**
   * Pre-sign handoff queue: RESERVED entries awaiting their after/failure hook,
   * keyed by requirements-signature. Entries within a signature group are
   * fungible (identical amount/payTo/horizon), so before→after|failure pops any
   * of them — mis-ordering across concurrent identical payments is amount-neutral
   * and never crosses a reserved entry with a signed one.
   */
  private readonly pending = new Map<string, PendingEntry[]>();
  /**
   * Post-sign correlation: SIGNED entries keyed by the payer-signed EIP-3009
   * nonce (unique per authorization, verified). This removes the signature-based
   * after→response ambiguity that could settle/expire the wrong reservation.
   */
  private readonly signedByNonce = new Map<string, PendingEntry>();

  constructor(
    private readonly store: AtomicStore,
    private readonly policy: Policy,
    private readonly principalId: string,
    private readonly clock: Clock,
    private readonly audit: AuditSink,
    private readonly opts: InstallOptions,
  ) {}

  private pushPending(sig: string, entry: PendingEntry): void {
    const q = this.pending.get(sig);
    if (q) q.push(entry);
    else this.pending.set(sig, [entry]);
  }

  private shiftPending(sig: string): PendingEntry | undefined {
    const q = this.pending.get(sig);
    if (!q || q.length === 0) return undefined;
    const e = q.shift();
    if (q.length === 0) this.pending.delete(sig);
    return e;
  }

  private unshiftPending(sig: string, entry: PendingEntry): void {
    const q = this.pending.get(sig);
    if (q) q.unshift(entry);
    else this.pending.set(sig, [entry]);
  }

  async before(
    ctx: PaymentCreationContextLike,
  ): Promise<void | { abort: true; reason: string }> {
    // Fail-CLOSED contract (Q1b): any thrown/unexpected error must abort. We
    // never `return;` (void === allow) from a catch. The catch-all also yields a
    // clean SDK "Payment creation aborted: <reason>" instead of a raw crash.
    let decision: GuardDecision;
    try {
      decision = await this.decide(ctx);
    } catch (err) {
      this.audit({
        kind: "error",
        detail: `guard hook threw: ${err instanceof Error ? err.message : String(err)}`,
      });
      return { abort: true, reason: "agentpay-guard internal error (fail-closed)" };
    }
    this.audit({ kind: "decision", decision });
    if (decision.decision === "allow") return;
    return { abort: true, reason: `${decision.reason}: ${decision.message}` };
  }

  private async decide(ctx: PaymentCreationContextLike): Promise<GuardDecision> {
    const now = this.clock.now();
    const resourceUrl = ctx.paymentRequired.resource?.url;
    const payment = toResolvedPayment(ctx.selectedRequirements, resourceUrl);

    const mandate = this.opts.mandateVerifier
      ? await this.opts.mandateVerifier(ctx)
      : undefined;

    const dedup: DedupContext = this.opts.resolveDedupContext
      ? this.opts.resolveDedupContext(ctx)
      : {};

    const decision = await evaluatePayment(
      { payment, mandate, dedup, now },
      { policy: this.policy, store: this.store, principalId: this.principalId },
    );

    if (decision.decision !== "allow" || !decision.reservationId) return decision;

    // Escalation: evaluated AFTER a would-be allow so it integrates with the
    // reservation lifecycle. Default is fail-closed (block + release).
    if (this.opts.escalationPolicy?.(payment, mandate)) {
      const handled: Decision = this.opts.onEscalate
        ? await this.opts.onEscalate(payment, mandate)
        : "block";
      this.audit({ kind: "escalate", reservationId: decision.reservationId, detail: handled });
      if (handled !== "allow") {
        await this.store.transition(decision.reservationId, "reserved", "released");
        return {
          decision: "block",
          reason: "escalated",
          message: "payment escalated and not approved",
          matchedRule: "escalate",
        };
      }
    }

    const sig = requirementsSignature(ctx.selectedRequirements);
    this.pushPending(sig, {
      reservationId: decision.reservationId,
      payment,
      reservedAtSeconds: Math.floor(now / 1000),
      horizonSeconds:
        payment.maxTimeoutSeconds ?? this.policy.validBeforeCeilingSeconds,
      ...(decision.dedupKey !== undefined ? { dedupKey: decision.dedupKey } : {}),
    });
    this.audit({
      kind: "reserved",
      reservationId: decision.reservationId,
      payment: pickAudit(payment),
    });
    return decision;
  }

  async after(ctx: PaymentCreatedContextLike): Promise<void> {
    const sig = requirementsSignature(ctx.selectedRequirements);
    const entry = this.shiftPending(sig);
    if (!entry) return; // no correlated reservation (e.g. guard registered late)

    // TOCTOU check (§5): the hook reserved the resolved tuple, then trusted the
    // SDK to sign exactly those. Confirm the signed payload matches.
    const signed = extractSignedAuth(ctx.paymentPayload.payload);
    if (signed) {
      const mismatchTo =
        signed.to !== undefined && signed.to !== entry.payment.payTo;
      const mismatchValue =
        signed.value !== undefined && signed.value !== entry.payment.value;
      // Bound the signed validBefore by what the reservation was actually PRICED
      // for (entry.horizonSeconds), not the looser policy ceiling — otherwise a
      // signed validBefore beyond the horizon can outlive safeReleaseAt and be
      // released while still settleable (+1s for second-rounding/signing latency).
      const validBeforeTooFar =
        signed.validBefore !== undefined &&
        signed.validBefore > entry.reservedAtSeconds + entry.horizonSeconds + 1;

      if (mismatchTo || mismatchValue || validBeforeTooFar) {
        this.audit({
          kind: "toctou_mismatch",
          reservationId: entry.reservationId,
          detail: `signed=${JSON.stringify({
            to: signed.to,
            value: signed.value?.toString(),
            validBefore: signed.validBefore,
          })} reserved=${JSON.stringify({
            to: entry.payment.payTo,
            value: entry.payment.value.toString(),
          })}`,
          payment: pickAudit(entry.payment),
        });
        // Restore to the FRONT of the reserved queue (still `reserved`, never
        // transitioned) so the failure hook that follows the abort releases it.
        this.unshiftPending(sig, entry);
        throw new Error("agentpay-guard: signed payload diverged from reserved tuple");
      }
    }

    // Extend safeReleaseAt to cover the ACTUAL signed validBefore (handles
    // signing latency: the SDK signs validBefore = signTime + maxTimeoutSeconds,
    // and signTime > hook time), so reconcile can never release it early.
    const transitionOpts: { safeReleaseAt?: number } = {};
    if (signed?.validBefore !== undefined) {
      transitionOpts.safeReleaseAt = safeReleaseAtMs(
        signed.validBefore,
        this.policy.reorgMarginMs,
        this.policy.maxClockSkewMs,
      );
    }
    const ok = await this.store.transition(
      entry.reservationId,
      "reserved",
      "signed",
      transitionOpts,
    );
    if (!ok) {
      // Should not happen (we popped a reserved entry); surface loudly.
      this.audit({
        kind: "error",
        reservationId: entry.reservationId,
        detail: "after(): reserved->signed CAS failed (correlation invariant broken)",
      });
      return;
    }
    this.audit({ kind: "signed", reservationId: entry.reservationId });
    // Correlate the rest of the lifecycle by the payer-signed nonce.
    if (signed?.nonce) {
      this.signedByNonce.set(signed.nonce, entry);
    }
  }

  async onFailure(
    ctx: PaymentCreationFailureContextLike,
  ): Promise<void | { recovered: true; payload: never }> {
    const sig = requirementsSignature(ctx.selectedRequirements);
    const entry = this.shiftPending(sig);
    if (!entry) return;
    // Pre-sign failure => the entry is still RESERVED (we only ever queue reserved
    // entries here; signed entries live in signedByNonce). Release it and
    // un-consume the dedup key so a legitimate retry is not falsely blocked. We
    // never release a `signed` authorization's hold — that is a real overspend.
    const ok = await this.store.transition(entry.reservationId, "reserved", "released");
    if (!ok) {
      this.audit({
        kind: "error",
        reservationId: entry.reservationId,
        detail: "onFailure(): reserved->released CAS failed (entry not reserved)",
      });
      return;
    }
    if (entry.dedupKey !== undefined) {
      await this.store.removeDedup(entry.dedupKey);
    }
    this.audit({
      kind: "released",
      reservationId: entry.reservationId,
      detail: `pre-sign failure: ${ctx.error.message}`,
    });
    return;
  }

  async onResponse(
    ctx: PaymentResponseContextLike,
  ): Promise<void | { recovered: true }> {
    const signed = extractSignedAuth(ctx.paymentPayload.payload);
    const nonce = signed?.nonce;
    const entry = nonce ? this.signedByNonce.get(nonce) : undefined;
    if (!entry || !nonce) return; // no nonce-correlated signed reservation
    this.signedByNonce.delete(nonce);
    if (ctx.settleResponse?.success) {
      const ok = await this.store.transition(entry.reservationId, "signed", "settled", {
        settledAt: this.clock.now(),
      });
      if (!ok) {
        this.audit({
          kind: "error",
          reservationId: entry.reservationId,
          detail: "onResponse(): signed->settled CAS failed",
        });
        return;
      }
      this.audit({ kind: "settled", reservationId: entry.reservationId });
    } else if (ctx.error || ctx.settleResponse?.success === false) {
      // Signed and sent, but settlement failed/unknown. Move to `unknown` so it
      // keeps holding cap until reconciliation (releaseExpired) governs it
      // deterministically — never released early.
      await this.store.transition(entry.reservationId, "signed", "unknown");
      this.audit({
        kind: "expired",
        reservationId: entry.reservationId,
        detail: "settlement failed/unknown -> unknown (holds cap until expiry)",
      });
    }
    return;
  }

  /**
   * Drive reconciliation: expire provably-dead reservations, and prune the
   * nonce map of entries whose reservation has reached a terminal state.
   */
  async reconcile(now = this.clock.now()): Promise<number> {
    const released = await this.store.releaseExpired(now);
    for (const [nonce, entry] of this.signedByNonce) {
      const r = await this.store.get(entry.reservationId);
      if (!r || (r.status !== "signed" && r.status !== "submitted")) {
        this.signedByNonce.delete(nonce);
      }
    }
    return released;
  }
}

function pickAudit(p: ResolvedPayment) {
  return {
    scheme: p.scheme,
    network: p.network,
    asset: p.asset,
    payTo: p.payTo,
    value: p.value,
  };
}

/**
 * Install agentpay-guard over an x402 v2 client's native lifecycle hooks.
 * Enforcement runs at onBeforePaymentCreation (pre-signing), below any agent
 * framework. Returns the guard handle for driving settlement/reconciliation.
 */
export function installAgentPayGuard(
  client: X402ClientLike,
  options: InstallOptions,
): AgentPayGuard {
  const clock = options.clock ?? systemClock;
  const audit = options.onAudit ?? noopAudit;
  const guard = new AgentPayGuard(
    options.store,
    options.policy,
    options.principalId,
    clock,
    audit,
    options,
  );

  client.onBeforePaymentCreation((ctx) => guard.before(ctx));
  client.onAfterPaymentCreation((ctx) => guard.after(ctx));
  client.onPaymentCreationFailure((ctx) => guard.onFailure(ctx));
  client.onPaymentResponse?.((ctx) => guard.onResponse(ctx));

  return guard;
}
