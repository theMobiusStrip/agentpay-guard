/**
 * Structural (duck-typed) mirror of the x402 v2 client hook surface we depend on,
 * verified against @x402/core 2.17.0 type declarations (x402Client class,
 * PaymentCreationContext / PaymentCreatedContext / PaymentCreationFailureContext).
 *
 * We depend on the SHAPE, not the package, so the pure policy logic is testable
 * without instantiating the SDK and is not pinned to one @x402/core minor. The
 * real x402Client satisfies this interface.
 */

export interface X402PaymentRequirementsLike {
  scheme: string;
  network: string;
  asset: string;
  amount: string; // atomic units, decimal string
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface X402ResourceInfoLike {
  url: string;
}

export interface X402PaymentRequiredLike {
  x402Version: number;
  resource?: X402ResourceInfoLike;
  accepts: X402PaymentRequirementsLike[];
}

export interface X402PaymentPayloadLike {
  x402Version: number;
  accepted?: X402PaymentRequirementsLike;
  payload: Record<string, unknown>;
}

export interface PaymentCreationContextLike {
  paymentRequired: X402PaymentRequiredLike;
  selectedRequirements: X402PaymentRequirementsLike;
}

export interface PaymentCreatedContextLike extends PaymentCreationContextLike {
  paymentPayload: X402PaymentPayloadLike;
}

export interface PaymentCreationFailureContextLike
  extends PaymentCreationContextLike {
  error: Error;
}

export interface PaymentResponseContextLike {
  paymentPayload: X402PaymentPayloadLike;
  requirements: X402PaymentRequirementsLike;
  settleResponse?: { success: boolean; transaction?: string };
  paymentRequired?: X402PaymentRequiredLike;
  error?: Error;
}

/** The subset of x402Client methods agentpay-guard registers against. */
export interface X402ClientLike {
  onBeforePaymentCreation(
    hook: (
      ctx: PaymentCreationContextLike,
    ) => Promise<void | { abort: true; reason: string }>,
  ): unknown;
  onAfterPaymentCreation(
    hook: (ctx: PaymentCreatedContextLike) => Promise<void>,
  ): unknown;
  onPaymentCreationFailure(
    hook: (
      ctx: PaymentCreationFailureContextLike,
    ) => Promise<void | { recovered: true; payload: X402PaymentPayloadLike }>,
  ): unknown;
  onPaymentResponse?(
    hook: (
      ctx: PaymentResponseContextLike,
    ) => Promise<void | { recovered: true }>,
  ): unknown;
}
