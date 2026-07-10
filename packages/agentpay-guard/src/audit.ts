import type { GuardDecision, ResolvedPayment } from "./types.js";

/**
 * Audit event surface (§5). The escalate value and all lifecycle transitions are
 * surfaced through this callback interface, NOT a bundled logger — the host owns
 * observability.
 */
export type AuditKind =
  | "decision"
  | "reserved"
  | "signed"
  | "settled"
  | "released"
  | "expired"
  | "toctou_mismatch"
  | "escalate"
  | "error";

export interface AuditEvent {
  kind: AuditKind;
  decision?: GuardDecision;
  reservationId?: string;
  detail?: string;
  payment?: Pick<ResolvedPayment, "scheme" | "network" | "asset" | "payTo" | "value">;
}

export type AuditSink = (event: AuditEvent) => void;

export const noopAudit: AuditSink = () => {};
