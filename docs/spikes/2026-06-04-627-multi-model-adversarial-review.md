# Spike #627 — Multi-Model Adversarial Review (codex/gemini independent reviewer)

**Date:** 2026-06-04 · **Session:** main-2026-06-04-session-1 (deep) · **Status:** ~~seam designed, live comparison **deferred (auth pending)**~~ → **live A/B executed 2026-06-11 (codex authenticated, ChatGPT mode)** · **Recommendation:** ~~conditional adopt~~ → **LEAN ADOPT** — diversity dividend confirmed (1 verified-real HIGH + 1 MEDIUM unique to codex). See the 2026-06-11 execution section below.

> **2026-06-11 update:** the "codex unauthenticated" blocker in (a) is resolved. `codex login status` = `Logged in using ChatGPT` (subscription billing, no per-call $). The live A/B in step (b)/(c) ran against a real code subset; the decisive numbers are in the dated execution section at the end of this doc.

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

---

## Spike execution 2026-06-11 (session-3 W2-C3)

The deferred live A/B (steps b/c) was executed. codex is now authenticated, so the empirical question — *does a second model family surface real defects the same-family Claude review misses?* — has a measured answer.

### Environment

| Item | Value |
|---|---|
| codex CLI | `codex-cli 0.137.0` |
| Auth mode | `Logged in using ChatGPT` (subscription — **no per-call $**; cost measured in tokens + wall-clock) |
| Model / reasoning | default `gpt-5.5`, reasoning `xhigh` (per `~/.codex/config.toml`) |
| Invocation | `codex exec --sandbox read-only --skip-git-repo-check --ephemeral --json` (diff on stdin) |
| Claude reviewer | Opus 4.8 (this agent), anti-contamination order: Claude findings committed to `/tmp/627-claude-findings.md` **before** any codex invocation |
| Test diff | commit `c4c4d32` code subset — 4 bash scripts under `scripts/spikes/h3-agent-teams/` + `tests/skills/goal-integration-wiring.test.mjs`; **575 added LOC ≈ 25 KB** (`git show c4c4d32 -- '*.sh' '*.mjs'`) |

> Invocation note for the integration seam: `codex exec` is **non-interactive by design** in 0.137.0 — there is **no `--ask-for-approval` flag** on the `exec` subcommand (it errors `unexpected argument`). Use `-s read-only` / `--sandbox read-only` only. Also: macOS has no `timeout(1)` (and `gtimeout` was absent); rely on codex's own runtime ceiling, not a `timeout` wrapper. Benign stderr noise observed: codex's own plugin-cache emits `failed to load skill … invalid YAML` warnings (its mirror of these SKILL.md files) plus an unrelated Vercel-MCP `invalid_token` line — neither touches the review.

### Cost (VBC-001 evidence, quoted from the `--json` event stream)

```
turn.completed usage: input_tokens=24849  cached_input_tokens=2432  output_tokens=9859  reasoning_output_tokens=9322
```

- **Wall-clock: 3:08.84 (≈189 s)** for one read-only review of the 25 KB diff (`time` output: `3:08.84 total`).
- **Tokens: 24,849 in (2,432 cached) / 9,859 out** — of the output, **9,322 were reasoning tokens** (xhigh). So the visible review is ~537 tokens; the bulk of output cost is hidden chain-of-thought. At subscription billing this is $0 marginal, but the latency + reasoning-token weight is the real per-review cost to budget against.

### Findings — CLAUDE (Opus 4.8), condensed

All four were **LOW**, verdict **PASS**:
- **L1** `preflight.sh:48` — `set -uo pipefail` omits `-e`; `bash toggle.sh` exit ignored (but pass/fail assert different codes → no false-green).
- **L2** `…wiring.test.mjs:597,621` — over-broad `[\s\S]*?` "defaults enabled to false" regex; redundant with the scoped "FIRST enabled:" guard at L600/L624.
- **L3** `…wiring.test.mjs:603,626` — unguarded `.match(...)[0]/[1]` can throw TypeError (still fails the test → behaviorally safe).
- **L4** `run-h3.sh:165` — `rm -rf "${HOME}/.claude/teams/${TEAM}"` depends on `$HOME`; guarded by nounset, all values script-internal literals → not exploitable.

### Findings — CODEX (gpt-5.5 xhigh), condensed

Verdict **FAIL**:
- **HIGH** `setup.sh:13` — fixed `/tmp/h3-agent-teams-test` path written via `mkdir -p` + `cat >` with no symlink/ownership check → a pre-planted symlink (`-> $HOME`) would make the writes follow out-of-dir (overwrite `$HOME/package.json`, `$HOME/.claude/settings.json`). Predictable-/tmp-path symlink-following (CWE-377/CWE-61).
- **MEDIUM** `run-h3.sh:62` — the runbook's between-run reset (`run-h3.sh cleanup` → `setup.sh`) deletes then re-truncates `h3-results.jsonl`, destroying the run evidence the operator was just told (step 5) to append.
- **LOW** `…wiring.test.mjs:228,251` — the "lists exactly the two seam names" test is substring `toContain`; the correct seam-string appearing elsewhere (e.g. a comment) while the active block diverges → false-green.

### Verified cross-tab (every finding inspected line-by-line at c4c4d32)

| # | Finding | Bucket | Severity | Real? | Verification note |
|---|---|---|---|---|---|
| 1 | `setup.sh` predictable `/tmp` symlink-following | **UNIQUE-TO-CODEX** | HIGH (codex) / MED (calibrated) | **Y** | `git show c4c4d32:…/setup.sh` L13/17/18: `FIXTURE=/tmp/h3-agent-teams-test` fixed; `mkdir -p`+`cat >` with no `[ -L ]`/owner/`trap` guard. Real defect class. Severity calibration: single-user dev Mac (`/tmp→/private/tmp`), so live blast radius is low — but the **vulnerability is real and I (Claude) missed it entirely**. |
| 2 | `run-h3.sh` runbook destroys `h3-results.jsonl` between runs | **UNIQUE-TO-CODEX** | MEDIUM | **Y** | run-h3.sh L55 (append) → L61-63 (`cleanup`→`setup.sh`) → setup.sh L95 `: > "${FIXTURE}/h3-results.jsonl"` truncates. Following the documented procedure loses run-1 evidence before run-2. Genuine workflow defect; Claude missed it. |
| 3 | seams `toContain` substring can false-green | **SHARED (variant)** | LOW | **Y (partial)** | Empirically reproduced: extra inline seam → `toContain` correctly FAILS (bracket-close differs); but correct string in a comment + wrong active block → false-green (`true`). Same *class* as Claude-L2 but a **different assertion** (codex: seams L228/L251; Claude: enabled-regex L597/L621). Both real, both LOW, both compensated in the common case. |
| 4 | `preflight.sh` missing `-e` / ignored toggle exit | UNIQUE-TO-CLAUDE | LOW | Y | Confirmed; mitigated because pass/fail assert different exit codes (0 vs 2). |
| 5 | unguarded `.match()[0]/[1]` TypeError | UNIQUE-TO-CLAUDE | LOW | Y | Confirmed; throw still fails the test → no false-green. |
| 6 | `rm -rf "${HOME}/…"` HOME-dependence | UNIQUE-TO-CLAUDE | LOW | Y | Confirmed; nounset-guarded, literal-only → not exploitable. |

**False-positive rate:** codex 0/3 (all three findings verified real). Claude 0/3 unique (all real). Neither reviewer invented a finding. The divergence is **coverage**, not accuracy: codex hunted *security/workflow* (symlink, evidence-loss) where Claude hunted *test-suite false-green mechanics*. The two reviews are largely complementary, not overlapping — exactly the diversity hypothesis #627 set out to test.

### Decisive numbers → recommendation

> **Adopt-signal = count of UNIQUE-TO-CODEX, verified-real findings with severity ∈ {BLOCKER, HIGH} = 1** (the `setup.sh` symlink defect). Threshold for ADOPT is `> 0`.

**Recommendation: LEAN ADOPT.** The single live A/B already cleared the bar the spike defined: codex surfaced **1 verified-real HIGH** (plus a MEDIUM) that the same-family Claude review missed entirely, with a **0% false-positive rate**. The blind-spot was asymmetric and on the security axis — the most valuable place for a second opinion. Caveats that keep this "lean" rather than unconditional: (1) n=1 diff, on spike/operator-harness code (not the production runtime path) — a second A/B on a real `src/**` wave diff would harden the signal; (2) the HIGH is severity-calibrated to MEDIUM on a single-user host, so the *category* (out-of-dir write) is the durable win, not the absolute severity; (3) ~189 s wall-clock + ~9.3 k reasoning tokens per review is non-trivial latency even at $0 subscription billing — this must stay **opt-in, per-session**.

### Proposed integration seam (adopt-leaning)

Wire as an **optional, default-off** external reviewer in the existing W4 advisory-review flow — **Option A** from section (d), extending the `wave-reviewers`-style config rather than adding a parallel namespace:

```yaml
# Session Config (default off; mirrors wave-reviewers gating)
wave-reviewers:
  enabled: false
  reviewers: []                 # e.g. ["architect-reviewer", "codex"]  ← "codex" is the reserved external name
  mode: warn
```

- When `codex` appears in `reviewers[]`: pre-flight `codex login status`; if not logged in, **skip with a one-line note** (never block). Otherwise shell `git diff "$SESSION_START_REF"..HEAD | codex exec --sandbox read-only --ephemeral --json -o .orchestrator/audits/codex-review-w<N>.json "<adversarial rubric>"`.
- **Invariants (non-negotiable):** `--sandbox read-only` always; **Claude remains the sole filesystem writer** (Code Sovereignty); codex output is **advisory-only** and flows through `receiving-review.md` **RCR-003 skeptical posture** (external reviewer) before the coordinator decides what to implement; default-off so the ~189 s + reasoning-token cost is opt-in.
- **Do NOT** add `codex` as a frontmatter `model:` value — the runtime stays Claude-only (per the Runtime-reality-check section above); this is strictly an out-of-band `codex exec` shell-out at one advisory seam.
- Suggested follow-up before flipping default-anything: one more A/B on a production `src/**` diff to confirm the diversity dividend holds outside spike-harness code.

**Artifacts (this run, under `/tmp/627-*`):** `627-c4c4d32-code.diff` (input), `627-claude-findings.md` (pre-codex Claude review), `627-codex-lastmsg.md` (codex review), `627-codex-events.jsonl` (token stream), `627-codex-time.txt` (wall-clock).
