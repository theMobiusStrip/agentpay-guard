# AGENTS.md — agentpay-guard

Guidance for AI agents (Claude Code, Codex, Cursor, …) working in this repo.
`CLAUDE.md` imports this file, so this is the single source of truth.

## What this is

A stateful, agent-agnostic **x402 v2 policy plugin** (`agentpay-guard`) + a
server-side **replay middleware** + **DrainBench**, a reproducible adversarial
harm-metric benchmark. npm workspaces monorepo. See `README.md` for the full story.

## Layout

```
packages/agentpay-guard/               the client plugin (the deliverable, published)
packages/x402-idempotency-middleware/  server replay middleware (published)
packages/drainbench/                   benchmark harness + agent scaffold (private)
examples/                              two worked examples (claude-proxy, raw-viem)
spike/                                 G0 hook probe (offline) + e2e harness (needs funds)
bench/                                 reproducibility bundle, arm-A baseline, results
docs/reference/                        durable: threat model + attack taxonomy
docs/deck.md                           the 5-slide deck
SECURITY.md                            authoritative security model (read before custody edits)
```
(`docs/process/` — milestone notes — is private/gitignored, absent in a fresh clone.)

## Commands

```bash
npm ci && npm run build          # build the two publishable packages
npx vitest run                   # full test suite (all packages)
npx tsc -b                       # typecheck published packages
npx tsc -p spike/tsconfig.json                       # typecheck spike
npx tsc -p packages/drainbench/tsconfig.json --noEmit # typecheck bench harness
npx tsc -p examples/tsconfig.json                    # typecheck examples
npx tsc -p bench/tsconfig.json                       # typecheck pinned arm-A
npm run -w @agentpay-guard/spike hook-probe          # offline SDK probe (no funds)
npm run -w @agentpay-guard/drainbench bench          # deterministic A/B -> bench/results/
npm run -w @agentpay-guard/drainbench agent-demo     # stochastic demonstration
```

CI (`.github/workflows/ci.yml`) runs all of the above.

## Build & verify

Before a change is done, run green:

```bash
npm run build                                              # publishable packages
npx tsc -b \
  && npx tsc -p spike/tsconfig.json \
  && npx tsc -p packages/drainbench/tsconfig.json --noEmit \
  && npx tsc -p examples/tsconfig.json \
  && npx tsc -p bench/tsconfig.json                        # every project, exit 0
npx vitest run                                             # full suite, 0 fail
npm run -w @agentpay-guard/spike hook-probe               # ALL PASS
npm run -w @agentpay-guard/drainbench bench               # writes bench/results/
```

Green = every typecheck exit 0, full vitest pass, probe ALL PASS, DrainBench deltas
+ benign gate (0 blocks) hold. Touch the custody spine (store/guard/middleware) →
**G1 stays green**, and drive the affected flow (probe / bench / examples), don't
trust types alone.

## Pinned versions (do not bump casually — it is a pre-registration amendment)

`@x402/*@2.17.0`, `viem@2.31.7`, Base Sepolia `eip155:84532`, USDC 6-decimals,
exact/EIP-3009 only. See `VERSIONS.md`.

## Invariants — do not regress these

- **Fail closed.** Anything outside the MVP envelope (scheme/network/asset) blocks,
  never allows. In the guard hook, a *void* return means **allow** — never
  `return;`/fall through from a catch; always `return { abort: true, reason }`.
- **G1 overspend gate stays green.** Concurrent overspend + window-slide
  double-spend + skewed-clock. The atomic store's accounting model (pending holds
  cap at any age; settled attributed at settlement time; expiry against an
  authoritative clock) is load-bearing — see `packages/agentpay-guard/src/store/`.
- **Server middleware keys on the payer-signed EIP-3009 authorization** (EIP-712
  digest / `(token,from,nonce)`), never the client-supplied payment-identifier.
- **Honest scoping is a feature, not a bug.** Do not over-claim. The plugin hardens
  tool-mediated content-injection, NOT arbitrary code execution; presumes an
  out-of-process signer. `docs/reference/threat-model.md` is the boundary.
- **DrainBench must stay fair.** Arm A is a *model* (the x402 docs ship only an
  abort stub), reported in both sync + async modes; the atomicity delta is disclosed
  as conditional on an async/shared store. Never relabel arm A as "documented", and
  keep the fairness disclosures in the report. Metrics come from the ledger, never
  self-report. Report the guard's own failures.
- **Never commit secrets.** `spike/e2e/.wallet.json` (a generated private key) is
  gitignored — keep it that way.

## Security — read before editing the custody spine

`SECURITY.md` is authoritative — read it before touching the files below. One line:
the guard enforces spend decisions **fail-closed, below the LLM**; it is not a
sandbox and presumes an out-of-process signer. A `void` return from the hook means
**allow** — never "close" a gap by loosening fail-closed.

Editing any file here → stop building and think like an attacker: how does *this
diff* widen a `SECURITY.md` "Honest limitation" or break the invariant?

| File | Invariant that must hold |
| --- | --- |
| `packages/agentpay-guard/src/store/memory.ts` | `tryReserve` atomic; pending holds cap at any age; settled attributed at settlement time; no early release; a new bug class ⇒ `store.g1.test.ts`. |
| `packages/agentpay-guard/src/store/types.ts` | Store contract stays atomic (`tryReserve`/`transition` CAS/`putIfAbsent`/`releaseExpired`), `now` injected — an external store must pass G1. |
| `packages/agentpay-guard/src/evaluate.ts` | Fail-closed check order; reserve-then-dedup with release-on-duplicate; `validBefore` clamp; dedup keys principal-scoped. |
| `packages/agentpay-guard/src/guard.ts` | Catch-all returns `{ abort: true }` (never `void` = allow); post-sign lifecycle correlates by nonce; `onFailure` never releases a *signed* hold; `onAfter` TOCTOU check. |
| `packages/agentpay-guard/src/policy/*.ts` | Envelope deny-by-default; intent fails safe when intent is agent-derived; dedup keys are payer-owned, not merchant-jitterable. |
| `packages/x402-idempotency-middleware/src/*` | Keys on the payer-signed authorization, NOT the payment-identifier; claim-with-lease + cached-response; a stale worker can't overwrite a fresh grant. |

### Adversarial review (harness)

Before landing a custody-spine change, run **`/adversarial-review`**
(`.claude/skills/adversarial-review/`): it spawns a **fresh** reviewer subagent (one
that did **not** write the code), prompted to *break* the diff against `SECURITY.md`;
you fix every P1/P2 with a regression test; it re-reviews with a fresh reviewer until
clean. Self-review by the writing context does not count — it shares its own blind
spots. This is a process check, not a containment boundary.

## Commit & PR conventions

- **Subject:** Conventional Commits — `type(scope): description`, imperative,
  ≤50 chars (e.g. `fix(store): cap pending holds at any age`). Types: feat, fix,
  docs, test, refactor, chore, ci. Scope = package/area (store, guard, middleware,
  drainbench, bench, readme, agents, ci).
- **Body:** required. Caveman it (style below) — minimum words for the *why*.
  Wrap at ~72 chars.
- **No process narrative** in commit/PR text — no conversation context, no cited
  sources, no timings/durations, no prompts, no "as requested". Describe the change
  and its rationale, nothing about how it was produced.

## Comment & doc style — caveman

Code comments, prose docs, and commit bodies use **caveman** compression: drop
articles, filler (just/really/basically), and hedging; fragments are fine; prefer
short synonyms.
Keep **exact**: technical terms, identifiers, code blocks, URLs, error strings, and
numbers. Use **full sentences** where fragment order could mislead — security
warnings, irreversible-action notes, and multi-step sequences.

The `caveman` skill is installed at project level (`.claude/skills/caveman/`) —
invoke via `/caveman`.

## Public repo hygiene

This is a public repo. **Never commit or push private data:** no `PLAN.md` or other
planning/process docs (see `.gitignore`), no machine details or usernames, no
credentials or keys (`spike/e2e/.wallet.json` is a generated key — stays ignored),
no absolute/internal filesystem paths. Prefer repo-relative paths in tracked files.

## Working style

- Prefer small, verifiable changes. Run the relevant test/gate after editing.
- The custody spine (store, guard, middleware) must be the most correct code in the
  repo — adversarially verify changes there.
- Commit only when asked; branch first if on the default branch.
