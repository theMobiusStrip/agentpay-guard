---
name: adversarial-review
description: >
  Independent adversarial security review of a custody-spine change against SECURITY.md.
  Spawns a FRESH reviewer subagent that did NOT write the code, prompted to break the diff
  (cap overspend, window-slide, early release, fail-open void-return, TOCTOU, dedup/replay
  bypass, honest-scope overclaim, DrainBench fairness regression), fixes P1/P2 findings with
  regression tests, then re-reviews until clean. Use before landing changes to the store,
  guard, evaluate/policy, or the replay middleware — or when the user asks to "adversarially
  review", "security review", "attack this diff", or invokes /adversarial-review.
---

# Adversarial review — custody spine

The writing context does not get to grade its own work: it shares its own blind
spots, which is exactly how a real overspend or fail-open slips through. The
reviewer MUST be a **separate subagent with fresh context**.

Scope = the **custody spine**: the files in `AGENTS.md` → Security (the atomic
store, `evaluate.ts`, `guard.ts`, `policy/*.ts`, and the
`x402-idempotency-middleware`). If the diff doesn't touch those, say so and stop —
a broad code review is a different tool (`/code-review`).

## 1. Scope the diff

Collect the diff for the custody-spine files from the merge-base with the default
branch to HEAD (or the working-tree diff if uncommitted). If none of those files
changed, report "no custody-spine changes" and stop.

## 2. Independent review (Agent tool — a subagent that did NOT write this code)

Spawn a reviewer subagent. Give it: `SECURITY.md`, the `AGENTS.md` → Security
invariant table, the diff, and the files it touches. Instruct it to **attack like a
staff custody/security engineer, not to confirm**. For each hunk, find a concrete
way *this change* either widens an item in `SECURITY.md`'s "Honest limitations" or
breaks a Security-table invariant. Hunt specifically for:

- **Cap overspend / double-count** in any interleaving — window-slide (pending
  reservation stops holding cap before terminal), settled spend dropped or
  double-counted, aggregate/per-payee accounting wrong.
- **Early release** — `releaseExpired` freeing a still-settleable reservation; skew
  applied in the wrong direction; `safeReleaseAt` not covering the signed
  `validBefore`.
- **Fail-open** — a guard hook path that returns `void`/`undefined` (⇒ allow) on
  error instead of `{ abort: true }`; an envelope/intent/dedup check bypassable.
- **Lifecycle mis-correlation** — `onFailure` releasing a *signed* authorization's
  hold; ignored `transition()` CAS returns; nonce/FIFO correlation crossing
  concurrent identical payments.
- **Replay** — the middleware keying on the client-supplied payment-identifier
  instead of the payer-signed authorization; a crash permanently stranding a
  payment; a stale worker overwriting a fresh grant.
- **Honest-scope overclaim** — a doc/comment claiming a guarantee the code doesn't
  provide, or relabeling arm A as "documented", or dropping a DrainBench fairness
  disclosure.

It returns findings as `{ severity P1..P4, file:line, concrete failing input or
interleaving, fix }`. If it genuinely finds nothing exploitable, it returns an
explicit "no exploitable findings" plus what it checked.

## 3. Fix + re-review

Fix every **P1/P2** (and cheap P3s) with the smallest correct change; preserve the
trust boundary and the fail-closed posture. **Add or extend a regression test** for
the bug class (`store.g1`, `evaluate`, `guard`, `regression.review`, or
`x402-idempotency-middleware/test/replay`). Run **Build & verify** (AGENTS.md):
typecheck + `vitest run` + hook-probe + bench. Then loop back to step 2 with a
**FRESH** reviewer until it reports no P1/P2.

## 4. Report

Reviewer verdict, findings fixed (severity + `file:line`), tests added, and Build &
verify green. Log the review in `docs/process/review-log.md` (private).

Never sign off without a clean independent review. Never let the writing context be
the reviewer.
