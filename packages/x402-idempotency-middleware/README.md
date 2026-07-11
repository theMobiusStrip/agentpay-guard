# x402-idempotency-middleware

[![npm](https://img.shields.io/npm/v/@themobiusstrip/x402-idempotency-middleware?color=cb3837)](https://www.npmjs.com/package/@themobiusstrip/x402-idempotency-middleware)

```bash
npm i @themobiusstrip/x402-idempotency-middleware
```

Server-side reference middleware for the **protocol-replay** class the client
plugin structurally cannot see: the client signer cannot stop an already-emitted
authorization from being replayed — that is a resource-server concern.

Keys idempotency on the **payer-signed EIP-3009 authorization** — the EIP-712
digest of the signed tuple, or `(token, from, nonce)` — **never** the
client-supplied `payment-identifier`. The identifier is attacker-variable (the
replayer is a client and controls it), so keying on it reproduces the "dedup is
theater" hole: a replayer re-presents the same signed authorization under a fresh
identifier and collects a second grant (the "Five Attacks on x402" paper reports
248 grants/payment). The nonce, by contrast, is part of the payer-signed
authorization and is unique per authorization (SDK-random 32 bytes — verified).

**Claim-with-lease + cached-response** (not just claim-before-grant):
- a duplicate of a claimed-and-granted payment **replays the stored grant**;
- a claimed-but-ungranted payment (server crashed between claim and grant) becomes
  **retryable after lease expiry** — otherwise the defense itself manufactures a
  permanent `paid_without_service`;
- a stale worker cannot grant over a newer reclaim (claim-token generations).

## API

```ts
const guard = new IdempotencyGuard({ store, leaseMs, domainNameVersion? });

const begin = await guard.begin(paymentPayload);
// begin.kind: "proceed" | "replay" | "in_progress" | "unkeyable"
if (begin.kind === "replay")  return cached(begin.grant);
if (begin.kind === "proceed") {
  const body = await doWorkAndDeliver();
  await guard.complete(begin.key, begin.claimToken, { status: 200, headers, body });
}
```

Framework-agnostic core; `spike/e2e/server.ts` shows it wired into an
`@x402/express`-gated endpoint.
