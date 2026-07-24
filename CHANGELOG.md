# Changelog

## 2026-07-23

### `@themobiusstrip/agentpay-guard` 0.0.5

- Add optional `Policy.maxPaymentAmount` ceiling. Apply in both policy profiles
  before reservation or dedup state changes.
- Add `payment_amount_exceeds` block reason. Allow exact-limit payments;
  `0n` blocks every positive payment.
- Reject invalid runtime ceiling values with fail-closed `policy_invalid`.
- Document standalone ceiling boundary: no payee binding, no cumulative
  protection. Keep rolling caps and trusted mandates as complementary controls.

### `@themobiusstrip/agentpay-proxy` 0.0.4

- Add `MAX_PAYMENT` environment setting. Default off; no `MANDATE`,
  `PIN_PAYTO`, or `PIN_MAX` required.
- Reject invalid programmatic `maxPaymentAmount` before proxy creation.
- Pin guard 0.0.5. Refuse proxy release until exact guard dependency exists on
  npm.
- Exercise `MAX_PAYMENT` through installed guard and proxy tarballs.

### `@themobiusstrip/x402-idempotency-middleware` 0.0.5

- Version-only lockstep release. No middleware behavior change.
