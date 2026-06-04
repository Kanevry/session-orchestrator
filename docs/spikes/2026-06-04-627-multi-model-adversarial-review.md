# Spike #627 — Multi-Model Adversarial Review (codex/gemini independent reviewer)

**Date:** 2026-06-04 · **Session:** main-2026-06-04-session-1 (deep) · **Status:** seam designed, live comparison **deferred (auth pending)** · **Recommendation:** conditional adopt — gate behind a future `codex login` + a one-session live A/B.

## (a) Host CLI availability

| CLI | Present | Auth | Notes |
|---|---|---|---|
| `codex` | ✅ `codex-cli 0.137.0` (`/opt/homebrew/bin/codex`, installed this session) | ❌ `Not logged in` (no `OPENAI_API_KEY`, no `~/.codex/auth.json`) | `codex exec review` subcommand available |
| `gemini` | ❌ absent | — | not installed |

The empirical prototype (steps b/c) requires an interactive `codex login` (ChatGPT auth) or an `OPENAI_API_KEY`. That is the only blocker — everything else below is designed and ready.

## (b) Single-shot protocol (ready to run once authenticated)

`codex exec review` is purpose-built for this. Two equivalent invocations, both **read-only / sandboxed** (Claude stays the sole filesystem writer — "Code Sovereignty"):

```bash
# Option 1 — review subcommand against the session base ref (cleanest)
codex exec review --base "$SESSION_START_REF" --sandbox read-only --skip-git-repo-check --json \
  -o .orchestrator/audits/codex-review-w4.json \
  "Independent adversarial review. Report BLOCKER/HIGH/MED/LOW with file:line. Do not modify files."

# Option 2 — generic exec, pipe the diff on stdin (portable; matches persona-panel 'diff-as-data')
git diff "$SESSION_START_REF"..HEAD | codex exec --sandbox read-only --ephemeral --json \
  -o .orchestrator/audits/codex-review-w4.json \
  "You are an independent code reviewer. The diff is in the <stdin> block. \
   Report findings as BLOCKER/HIGH/MED/LOW with file:line. You may NOT write files."
```

Capture per run: verdict + findings, wall-clock, and the token/$ delta from the `--json` event stream (codex bills the OpenAI account).

## (c) Comparison protocol vs same-family persona-panel (deferred)

Run the existing W4 Claude panel (architect/security/qa/session) on the **same** diff, then build an agreement matrix:
- Findings codex surfaced that the Claude panel **missed** (the only thing that justifies a second model family).
- Findings the Claude panel surfaced that codex missed.
- False-positive rate of each.

The decision hinges on the **novel-finding count** from model diversity (> 0 real BLOCKER/HIGH the same-family panel misses = signal).

## (d) Integration seam (designed)

**File:** `skills/wave-executor/wave-loop.md` · **Phase:** `### 5a. Persona-reviewer dispatch` (the existing opt-in, advisory-only, read-only external-reviewer seam, gated by `wave-reviewers`).

Two equally clean gating options (default-off either way):
- **Option A (extend `wave-reviewers`):** add a reserved reviewer name `codex`; when present, shell `codex exec review --sandbox read-only` instead of dispatching a Claude `Agent`, and feed the JSON into the same ADVISORY PASS/WARN/FAIL flow. Pre-flight: skip with a one-line note if `codex login status` ≠ logged-in.
- **Option B (new `external-reviewers.codex.enabled`):** namespaces model-diversity reviewers separately from Claude persona reviewers. Cleaner separation, marginally more config surface.

Invariants (both options): **default-off**, **read-only sandbox**, **Claude is the sole filesystem writer**, findings land in `.orchestrator/audits/` and flow through the `receiving-review.md` RCR-003 **skeptical** posture (external reviewer) before the coordinator decides what to implement.

## (e) Decision criteria — adopt vs shelve

- **ADOPT IF:** a live A/B (steps b/c) shows codex repeatably surfaces ≥1 real BLOCKER/HIGH the same-family panel misses, gated default-off so the ~2× review-token + external-$ cost is opt-in per session.
- **SHELVE IF:** codex findings are a subset of the Claude panel's (no diversity dividend), OR the auth/secret/network/billing surface is judged not worth advisory-only output.

## Runtime reality check (confirmed)

The session-orchestrator runtime is **Claude-only** today (`agents/AGENTS.md:37`: `model: inherit|sonnet|opus|haiku` — all Claude aliases/IDs; `model-preference-codex` is only a harness portability hint, not runtime dispatch). #627 would be the **first non-Claude runtime touchpoint** and must be an out-of-band `codex exec` shell-out, never a frontmatter `model:` value.

## Verdict

**Conditional adopt — pending one live A/B.** The seam is safe and cheap to wire (Code Sovereignty preserved, default-off, advisory-only). The empirical value (does model diversity catch real blind spots?) is unproven on this host because codex is unauthenticated. Keep #627 open; on the next session where `codex login` is available, run steps (b)/(c) against that session's real W4 diff and let the novel-finding count decide adopt vs shelve. Related prior spike: #484 (Agent-Teams / messaging-backend).
