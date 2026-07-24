/**
 * agentpay-guard — a stateful, agent-agnostic x402 policy plugin.
 *
 * Installs over x402 v2's native client lifecycle hooks (enforcement at
 * onBeforePaymentCreation, pre-signing) and provides:
 *   1. atomic reserve-before-sign budget cap (rolling window, spans sign->settle)
 *   2. trusted intent / resource-binding constraint check
 *   3. local duplicate-authorization guard
 * Everything outside the MVP envelope fails closed.
 */

export { installAgentPayGuard, AgentPayGuard } from "./guard.js";
export type { InstallOptions } from "./guard.js";

export { evaluatePayment } from "./evaluate.js";
export type { EvaluateDeps, EvaluateInput } from "./evaluate.js";

export { InMemoryAtomicStore } from "./store/memory.js";
export type {
  AtomicStore,
  RecoveryResult,
  Reservation,
  ReserveRequest,
  ReserveResult,
  SignedAuthorizationReference,
  TransitionOptions,
} from "./store/types.js";

export { ManualClock, systemClock, safeReleaseAtMs } from "./clock.js";
export type { Clock } from "./clock.js";

export { deriveDedupKey } from "./policy/dedup.js";
export type { DedupContext } from "./policy/dedup.js";
export { checkEnvelope, checkResolvedFields } from "./policy/envelope.js";
export { checkIntent } from "./policy/intent.js";

export { noopAudit } from "./audit.js";
export type { AuditEvent, AuditKind, AuditSink } from "./audit.js";

export {
  PENDING_STATUSES,
  TERMINAL_STATUSES,
} from "./types.js";
export type {
  Caip2Network,
  Decision,
  GuardDecision,
  MvpEnvelope,
  Policy,
  PolicyProfile,
  ReasonCode,
  ReservationStatus,
  ResolvedPayment,
  VerifiedMandate,
} from "./types.js";

export type {
  X402ClientLike,
  PaymentCreationContextLike,
  PaymentCreatedContextLike,
  PaymentCreationFailureContextLike,
  PaymentResponseContextLike,
  X402PaymentRequirementsLike,
  X402PaymentRequiredLike,
  X402PaymentPayloadLike,
} from "./x402-types.js";
