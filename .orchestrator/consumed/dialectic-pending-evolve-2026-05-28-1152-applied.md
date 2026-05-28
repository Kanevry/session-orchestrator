# Dialectic (manual /evolve --dialectic --apply, evolve-2026-05-28-1152) — APPLIED

Third dialectic pass of 2026-05-28. The 0839 pass already harvested the deep-1 backlog (5 AGENT.md additions). This pass covers the 5 NEW deep-2 learnings (71→76). User delegated the judgment ("ich kann das nicht beurteilen — stell sicher dass es zu uns passt") and explicitly requested an **opus** QC pass instead of haiku to guarantee quality.

## Process

1. Built the exact production prompt via `runDialecticDeriver` (prompt-capturing dispatchAgent), budget raised to 35K (default 8K rejects; est. input 27,022 tokens). Payload: top-50 learnings (conf 0.8–1.0), last-10 sessions, both peer cards, CLAUDE.md steering.
2. **Haiku pass** (first): deferred ALL FIVE deep-2 learnings — over-conservative.
3. Coordinator independent review (RCR-001): flagged haiku as under-weighting 2 cross-cutting items.
4. **Opus QC pass** (user-requested): independently converged on the SAME 2 accepts / 3 defers. Independent agreement = high confidence.
5. Safe apply: constructed the 2 changed sections from current on-disk content + the 2 opus-refined bullets, merged ONLY those sections via `mergePeerCard` (avoids full-body transcription corruption — the 0839 sidecar's documented backtick risk). Read-back diff confirmed **exactly 2 lines added, 0 removed, 0 modified**.

## Applied: AGENT.md (2 bullets)

### § wave-execution (append) — learning `pattern-replication-review-finds-recurrence` (conf 0.85)

> When a wave ships a fix for a recurring anti-pattern, run a pattern-replication audit on the rest of the diff before W4 closes — the agent who just fixed the bug is the most likely to re-introduce it elsewhere in the same change set. A single-agent review misses the recurrence; a multi-reviewer W4 panel catches it. Add a 1-line grep of the diff for other instances of the just-fixed pattern.

**Why:** deep-2 F-NEW-1 — a `||`-truthy-whitespace fallback fixed in W2 (#601) recurred intact in the same session's W2 fold-in (VAULT_MIRROR_CANONICAL_SUFFIX); caught only by the W4 multi-reviewer panel. General W4 review methodology, gap in the cards.

### § architecture-and-code-patterns (append) — learning `existsSync-identity-gate` (conf 0.80)

> `existsSync(target)` is not an authorization check — it answers "does this path exist", not "is this the RIGHT path". For any write-gate where writing to the wrong target is the failure mode (vault mirror, deploy target, backup destination), guard on an IDENTITY probe (git remote get-url origin, a sentinel marker file, a known UUID) and host-qualify the match (`endsWith('host.tld/org/repo')`) so a same-named repo on a different host is still rejected. Fail closed: any non-zero probe exit OR non-matching identity is a whole-run `exit(2)`, not a per-entry skip. Provide a load-bearing env-var bypass for tests that legitimately target non-canonical tmp dirs, and cover the guard black-box with the bypass off.

**Why:** deep-2 #600 D2 — vault-mirror wrote into a wrong-but-existing dir because the guard checked `existsSync` alone. Cross-cutting write-safety principle (vault mirror / deploy / backup), uncovered by any existing bullet.

## Deferred (3 of 5 — opus + haiku agree)

- **drift-check parity (read BOTH CLAUDE.md+AGENTS.md)** (conf 0.75) — single-validator implementation detail, too narrow for a behavioural card.
- **fs.readdir withFileTypes uses lstat not stat** (conf 0.85) — durable but niche single-occurrence Node gotcha; a third trivia bullet not worth section bloat. Revisit if it recurs.
- **chained path-rewrite gate-on-original** (conf 0.75) — domain-specific to the vault path-migration pipeline; does not generalise.

## NOT changed

- **USER.md — zero changes.** Neither accepted learning is a user-preference signal. Stays at 2026-05-25 state. (Both passes agree.)

## Frontmatter

- AGENT.md `updated`: 2026-05-25 → 2026-05-28T11:52:26.975Z
- AGENT.md `source_sessions`: + `evolve-2026-05-28-1152`
- Validation: `ok: true` for both cards.

<!-- DIALECTIC_USAGE: opus-qc-pass model=opus budget=35000 est_in=27022 -->
