# Instruction Delivery — How `.claude/rules/` Actually Reaches an Agent

> Measurement + decision record for GitLab issue **#931 (Teil b)**, Epic **#929**.
> Measured 2026-07-30 on branch `feat/929-instruments-enforcement` at the working-tree
> state of commit `a2a8397`. Every number below is reproducible with the command
> printed next to it.

**This document answers a question with "no".** The issue asks whether the dormant
rule-loader should be wired into a second delivery path. The measurement says it
should not. The reasoning is in [§5](#5-recommendation).

---

## 1. The measured status quo

`.claude/rules/` holds **26 files, 169,961 bytes**:

```console
$ find .claude/rules -name '*.md' | wc -l
26
$ find .claude/rules -name '*.md' -exec cat {} + | wc -c
169961
```

All 26 reach the agent through Claude Code's **native project-instruction loading**.
Three independent checks establish that no `*.mjs` code path in this repo performs
the injection:

```console
$ grep -c "^@" CLAUDE.md
0
$ node -e 'const s=require("./.claude/settings.json");console.log(JSON.stringify(Object.keys(s)))'
["permissions","hooks"]
$ git grep -n "loadApplicableRules" -- '*.mjs' | grep -v '^tests/' | grep -v '\* '
scripts/lib/instruction-budget-guard.mjs:81:import { loadApplicableRules } from './rule-loader.mjs';
scripts/lib/instruction-budget-guard.mjs:524:    allEntries = loadApplicableRules({ rulesDir, scopePaths: [] });
scripts/lib/instruction-budget-guard.mjs:525:    waveEntries = loadApplicableRules({ rulesDir, scopePaths: [], context: 'wave' });
scripts/lib/instruction-budget-guard.mjs:526:    coordinatorEntries = loadApplicableRules({ rulesDir, scopePaths: [], context: 'coordinator' });
scripts/print-applicable-rules.mjs:253:  rules = loadApplicableRules({ rulesDir, scopePaths, mode, hostClass, context });
```

`CLAUDE.md` has no imports; `.claude/settings.json` carries only `permissions` and
`hooks`; and the only two `loadApplicableRules` consumers are a **measurement probe**
(`instruction-budget-guard.mjs`) and a **CLI nobody calls at delivery time**
(`print-applicable-rules.mjs`). The single `SessionStart` hook is a git-behind check,
not an injector:

```console
$ node -e 'const s=require("./.claude/settings.json");console.log(s.hooks.SessionStart[0].hooks[0].command.slice(0,40))'
git fetch --quiet 2>/dev/null; BRANCH=$(git b
```

**Consequence:** the `globs:` / `paths:` / `tier:` frontmatter is understood by
`rule-loader.mjs` alone, and `rule-loader.mjs` does not run on the delivery path.
The scoping metadata is inert at the moment it would have to matter.

### 1.1 First-person confirmation (self-report, flagged as such)

The agent that produced this document ran as a **wave subagent** and received all
26 rule files in its context — including the four `tier: coordinator-only` files
(`loop-and-monitor.md`, `owner-persona.md`, `mvp-scope.md`, `lsp.md`, together
40,254 bytes) that a `context: 'wave'` load would have excluded, and including
glob-scoped rules whose globs do **not** intersect this wave's `allowedPaths`
(e.g. `anti-pattern-vi-restoreallmocks-…` scoped to `tests/lib/autopilot/**`,
`anti-pattern-agents-md-description-…` scoped to `agents/**` +
`scripts/lib/validate/**`).

This is introspective evidence about one context window, not a command transcript;
it is **corroborating**, not load-bearing. The load-bearing evidence is §1's three
grep/`node` checks, which show no `*.mjs` code path capable of applying the scoping.

### 1.2 There IS a second call site — and the census that missed it is this repo's own anti-pattern

§1's third check greps `-- '*.mjs'`. The wave-executor of this repo is **not a
module**; it is a skill body, executed as prose by the coordinator. The filter
therefore excludes the one consumer class that matters:

```console
$ git grep -ln "print-applicable-rules" -- 'skills'
skills/_shared/config-reading.md
skills/wave-executor/SKILL.md
skills/wave-executor/wave-loop.md
```

`skills/wave-executor/wave-loop.md` § "Pre-Dispatch: Glob-Scoped Rule Injection
(#336/#694)" does not describe the injection as optional. It instructs the
coordinator to run `print-applicable-rules.mjs --context wave` once per wave and
**prepend the result to EACH agent's prompt**. That is the same execution mechanism
as every other wave-executor step.

So `docs/rule-authoring.md:8` — "The wave-executor calls it at each wave boundary
[…] so a wave that touches only frontend files does not pay the token cost" — is
**not** documentation-vs-reality drift about a missing call site. The call site
exists as prose. What is wrong there is the *saving*: §2 measures it at 4.0% on a
real wave, not at the "does not pay" the sentence implies.

**This matters beyond bookkeeping.** §5 concludes that injecting alongside
undiminished native delivery costs +72% and is harmful — and a coordinator who
follows `wave-loop.md` literally does exactly that. The coordinator of the session
that produced this document noticed the size at dispatch time and declined to inject,
recording the deviation; the instruction itself was left standing. Naming the
diagnosis while leaving the instruction in place is the failure mode Epic #929 exists
to remove.

Note the shape of the mistake, because this repo already has a rule for it: a census
keyed on the payload (`loadApplicableRules` in `*.mjs`) misses every consumer that
pins only the channel (`print-applicable-rules.mjs` invoked from prose). See
`.claude/rules/anti-pattern-a-protocol-migration-census-keyed-on-the-payload-misses-every-consumer-that-pins-only-the-channel-18f3d0a.md`.

### 1.3 A second delivery source outside this repo's control

The parent workspace contributes an additional file that `print-applicable-rules.mjs`
structurally cannot see — it only ever reads `<repoRoot>/.claude/rules`
(`scripts/print-applicable-rules.mjs:157`):

```console
$ wc -c "$(dirname "$PWD")"/.claude/rules/parallel-sessions.md
5623
```

So the real delivered corpus is **175,584 bytes**, not 169,961. Any injected
replacement would reproduce only the 169,961-byte subset.

---

## 2. Rule-corpus breakdown

Produced by parsing each file's frontmatter through `parseGlobsFrontmatter()` from
`scripts/lib/rule-loader.mjs` (script in the session scratchpad; it only reads).

| Inclusion axis | Files | Bytes | Share |
|---|---:|---:|---:|
| **Always-on** (no `globs:` / `paths:`) | 12 | 109,169 | 64.2% |
| **Glob-scoped** (`globs:` present) | 14 | 60,792 | 35.8% |
| *of which carry `tier:`* | 15 | — | — |
| *of which carry `expires-at:`* | 11 | — | — |
| Frontmatter parse errors | 0 | — | — |

The five largest files carry **65.9%** of the whole corpus:

| Bytes | Share | File | Axis |
|---:|---:|---|---|
| 33,820 | 19.9% | `testing.md` | `globs: [tests/**, **/*.test.*, …]`, `tier: wave-only` |
| 33,377 | 19.6% | `loop-and-monitor.md` | always-on, `tier: coordinator-only` |
| 19,898 | 11.7% | `parallel-sessions.md` | always-on, `tier: always` |
| 16,713 | 9.8% | `security.md` | always-on, `tier: always` |
| 8,263 | 4.9% | `receiving-review.md` | always-on, `tier: always` |
| **112,071** | **65.9%** | **top 5 of 26** | |

The top **two** alone are 67,197 bytes = **39.5%**.

---

## 3. How much can scoping actually save?

Baseline for every row: **169,961 bytes** (what native delivery hands over today).
Each measurement used a throwaway scope file so the live `.claude/wave-scope.json`
was never touched:

```console
$ node scripts/print-applicable-rules.mjs --wave-scope <tmp>.json --context wave | wc -c
```

| `allowedPaths` set | Rules | Scoped bytes | Saved | Saved % |
|---|---:|---:|---:|---:|
| empty — matches nothing (the **floor**) | 8 | 69,024 | 100,937 | 59.4% |
| narrow — `scripts/lib/instruction-budget-guard.mjs` | 13 | 82,106 | 87,855 | 51.7% |
| medium — impl + test + doc (3 paths) | 14 | 115,932 | 54,029 | 31.8% |
| **broad — the live 20-path wave scope** | 18 | **122,875** | 47,086 | **27.7%** |
| match-all — a path hitting every glob | 25 | 168,156 | 1,805 | 1.1% |

### 3.1 The decomposition that decides the issue

Running the same scopes **without** `--context` isolates the glob axis from the tier
axis. The result is the sharpest finding in this document:

| `allowedPaths` set | Glob axis alone | Saved % | + tier axis | Tier's contribution |
|---|---:|---:|---:|---:|
| narrow | 122,360 | 28.0% | 82,106 | 40,254 |
| medium | 156,186 | 8.1% | 115,932 | 40,254 |
| **broad (live wave)** | **163,129** | **4.0%** | 122,875 | **40,254** |
| match-all | 168,156 | 1.1% | 168,156 | 0 |

Two things fall out:

1. **Glob scoping saves 4.0% on the real wave.** Not 40%, not 27% — 4.0%. The
   headline 27.7% in §3 is almost entirely the *tier* axis wearing the glob axis's
   clothes.
2. **The tier axis's contribution is a constant 40,254 bytes**, identical across every
   scope. It is not scope-dependent at all: it is exactly the four
   `tier: coordinator-only` files. Nothing about `allowedPaths` influences it.

The reason glob scoping under-delivers is structural: the largest glob-scoped file,
`testing.md` (33,820 bytes = 19.9% of the corpus), is scoped on `tests/**`. Under this
repo's test-first discipline essentially every wave has a test path in scope, so the
single biggest "scoped" rule is matched almost always. Compare the narrow row (no test
file → 28.0%) with the medium row (one test file added → 8.1%): adding one test path
costs 33,820 bytes and consumes three quarters of the glob axis's benefit.

### 3.2 Correction to the briefed figures

The task brief cited **117,732 bytes / 47 rules** for a 9-path scope. The byte figure
is plausible and close to my 20-path measurement of 122,875. **The rule count is not
reproducible**: the loader reads a single flat directory
(`readdirSync(rulesDir)`, non-recursive, `.md` only — `rule-loader.mjs:463-476`)
containing 26 files, so 47 cannot be produced by this CLI against this repo. My
reproduction of the live scope yields **18** rules. I could not re-measure the exact
9-path scope because `.claude/wave-scope.json` had already been overwritten with the
current wave's 20 paths. Treat the 47 as an artifact of a different measurement.

---

## 4. Is the native delivery path disableable?

**Partly answerable from the repo; the decisive part is not.**

### 4.1 What is established

- No repo-local mechanism performs the injection (§1), so the loading is Claude Code
  native behaviour keyed on the file location.
- The repo **already maintains a rules directory that is not auto-loaded**: `rules/`
  (10 files, 96,788 bytes) is the vendoring *library*, copied **into**
  `.claude/rules/` by `/bootstrap --sync-rules` to become active
  (`docs/rule-authoring.md:88-90`). Its existence demonstrates that "rules that live
  outside `.claude/rules/` are not delivered" holds in this codebase — the
  architectural option is real.
- The blast radius of relocating rules is measurable and large:

  ```console
  $ git grep -l "\.claude/rules/" | wc -l
  199
  $ git grep -c "\.claude/rules/" | awk -F: '{s+=$2} END {print s}'
  584
  ```

  199 tracked files carry 584 citations of the `.claude/rules/` path — agent
  definitions, skills, docs, validators (`check-rules.mjs`,
  `claude-md-drift-check`), the budget guard, and the vendoring contract that
  consumer repos depend on.
- One delivery source is **outside this repo entirely** (§1.3): the parent
  workspace's `.claude/rules/parallel-sessions.md`. Relocating this repo's rules
  would not suppress it.

### 4.2 What is NOT established — explicitly unbelegt

I found **no** artifact in this repo documenting Claude Code's auto-load rule for
`.claude/rules/*.md`: no settings schema, no upstream-doc excerpt, no ADR. Therefore
the following are **unverified inferences**, not findings:

- *that* `.claude/rules/` is the directory the native loader keys on (inferred from
  the "project instructions, checked into the codebase" labelling plus the absence of
  any other wiring);
- *whether* a settings key, env var, or `.claudeignore`-style mechanism can suppress
  native loading without moving files;
- *whether* an injected block and a natively-loaded file would be deduplicated.

Per the task's instruction, these are marked unbelegt rather than asserted. Any plan
that depends on them must verify them against upstream documentation first.

---

## 5. Recommendation

> ## RECOMMENDATION: Do **not** build a second delivery path. Shrink the corpus instead.
>
> **Because glob scoping saves 4.0% on the real wave (163,129 vs 169,961 bytes), while
> the five largest of 26 files carry 65.9% of the load — the payoff is in the editor,
> not in a delivery mechanism.**

Rationale, in the order the measurements produced it:

1. **Adding injection without disabling native delivery is strictly negative.** The
   scoped block for the live wave is 122,875 bytes. Injected alongside an
   undiminished 169,961-byte native load, the wave agent pays **292,836 bytes** —
   a 72% *increase*. This option is not merely unhelpful; it is harmful, and it is
   the option the issue's framing leads to by default.

2. **Disabling native delivery buys 27.7% at a cost of 199 files and an unverified
   premise.** It requires relocating rules out of `.claude/rules/`, rewriting 584
   citations, breaking the vendoring contract consumer repos rely on, and re-pointing
   `check-rules.mjs` / `claude-md-drift-check` / the budget guard — all resting on
   §4.2's unverified inference about what triggers native loading. It would also
   still leave the parent-workspace file (§1.3) in place.

3. **The 27.7% is mostly not the glob axis anyway.** 40,254 of the 47,086 saved bytes
   (85.5%) are the four `tier: coordinator-only` files. That is a *fixed* set, known
   without any scope computation — no `wave-scope.json`, no glob engine, no injection
   machinery is needed to identify it.

4. **The concentration makes editing the cheaper instrument.** `loop-and-monitor.md`
   is 33,377 bytes — 19.6% of the corpus, in every agent's context, and declared
   `tier: coordinator-only`, i.e. its own frontmatter says wave agents do not need it.
   `testing.md` is another 19.9%. Reducing those two files is a pure content decision
   with zero delivery-mechanism risk, zero blast radius, and it pays off under the
   delivery path that exists **today**.

5. **The enforcement instrument already exists.** `instruction-budget-guard.mjs`
   already measures the always-on byte load against a ceiling
   (`byte-ceiling: 114000`, live 108,589 — consistent with the 109,169 always-on bytes
   measured in §2, which include frontmatter the guard skips). Epic #929's enforcement
   goal is served by tightening that ratchet, not by adding a delivery path.

### 5.1 What to do instead (each independently landable)

| # | Action | Expected effect | Risk |
|---|---|---|---|
| 1 | Reduce `loop-and-monitor.md` (33,377 B). It is `tier: coordinator-only` yet reaches every agent; it is largely an upstream-feature changelog with 8 re-verify footers. | up to 19.6% of the corpus | none — content only |
| 2 | Reduce `testing.md` (33,820 B), the largest file and the one that defeats glob scoping (§3.1). | up to 19.9% | none — content only |
| 3 | Fix the false claim at `docs/rule-authoring.md:8` (§1.2). | correctness | none |
| 4 | Keep ratcheting `instruction-budget-guard`'s `byte-ceiling` downward as 1+2 land. | locks in the gains | none |

### 5.2 If a second delivery path is ever revisited

It becomes worth reconsidering only when **all** of these hold — none do today:

- upstream documentation confirms §4.2's suppression question affirmatively;
- the corpus has been shrunk first, so the remaining glob-axis saving is measured on a
  lean corpus rather than on `testing.md`'s bulk;
- `testing.md` has been split so its `tests/**` glob stops matching every wave;
- the 199-file / 584-citation migration is budgeted as its own epic with the consumer-
  repo vendoring contract versioned.

Wiring that changes every session-start of this repo belongs behind its own operator
decision, not inside a measurement task.

---

## 6. The projects-baseline ablation axis (GitLab #936, T3)

> This section aligns the instruction-ablation eval to the **fleet-wide** lever and
> pre-registers the decision rule. It builds the alignment, not a run — the run
> stays the operator's call because it burns real API budget.

### 6.1 Why the baseline is the lever, not this repo

§5 concludes: shrink the corpus, do not add a delivery path. §6 names *where* the
corpus lives. The `.claude/rules/` files reaching an agent are **not authored here** —
they are rolled out from `projects-baseline`. Measured 2026-07-30 (#936): **104,997
bytes are byte-identical across 14 repos**, all seeded from that baseline. A cut in
this repo's `.claude/rules/` is a single-repo fix that the next `/bootstrap
--sync-rules` can overwrite; a cut in the baseline propagates to every repo rolled
out from it.

This is consistent with §5's mechanism claim, not a new one: on Claude Code the
delivery path is native project-instruction loading (§1), so a baseline cut acts
purely through **corpus size, fleet-wide** — never through glob-scoping (which §3.1
measured at 4.0% on a real wave). The baseline axis is the same "editor, not delivery
mechanism" lever from §5, applied at the source that feeds 14 editors instead of one.

### 6.2 The one command (host-local, never hardcoded)

`evals/instruction-ablation/run.mjs` now accepts `--rules-source repo|baseline`
(default `repo`, byte-identical to before). With `baseline` it sources the rule
corpus from the host-local `projects-baseline` instead of this repo. The path is
resolved through the same precedence as `plan-baseline-path` in
`scripts/lib/config.mjs` — **`SO_BASELINE_PATH` env → owner.yaml `baselines:` match →
owner.yaml `paths.baseline-path`** — so no machine-specific path is committed.

```bash
# free — resolves the baseline, prints the corpus size + cost estimate, runs nothing
node evals/instruction-ablation/run.mjs --rules-source baseline --list

# the real run (operator's decision — ~USD 25 for these 14 cells)
node evals/instruction-ablation/run.mjs --rules-source baseline \
  --cases vbc-001-verify-before-claiming --variants v0-full,v2-no-rules --runs 7
```

`--list` reports which tier resolved the baseline, the corpus byte total (the
baseline corpus is larger than this repo's, so v0-full cells run a bigger context and
cost more than the repo axis), and refuses nothing. A real `--runs` against an
unresolved baseline exits `2` with a message pointing at `SO_BASELINE_PATH` /
`owner.yaml`, rather than silently falling back to the repo corpus. `CLAUDE.md` is
held constant (sourced from this repo) across both axes, so the rule corpus is the
only variable.

### 6.3 The decision rule — pre-registered BEFORE any run

The asymmetry that governs this axis: a wrong **cut** ships a behavioural regression to
14 repos at once; a wrong **keep** costs bytes. So the axis is fail-safe toward KEEP —
cutting requires a *positive* demonstration of no-effect, not merely the absence of a
significant one (n=7 cannot prove equivalence, only fail to reject it).

Run the candidate rule's case at `--runs 7`, `v0-full` (full baseline corpus) vs
`v2-no-rules` (empty corpus). Read the two pass rates against this table, fixed here
before the numbers exist so no result is rationalised after the fact:

| Outcome (v0-full vs v2-no-rules, n=7) | Reading | Baseline action |
|---|---|---|
| **Flat-identical** — 7/7 vs 7/7, or 0/7 vs 0/7 | the whole corpus's presence changed nothing this case can see | **CUT candidate, fleet-wide** — but per-section, never whole-file (see below) |
| **Clear separation** — v0 ≥ 5/7 **and** v2 ≤ 1/7 (Fisher p < 0.05) | the rule carries a real, fleet-wide behavioural effect | **KEEP in baseline** — it earns its 14-repo byte cost |
| **In-between** — e.g. 2/7 vs 0/7 (Fisher p ≈ 0.2), or any split not meeting the two rows above | signal, not significance (the #936-T2 zone) | **KEEP + raise n**, do not cut — under 14-repo blast radius, inconclusive defaults to keep |

Two guards carry over from the #936 Vorsession and bind here unchanged:

- **A case tests one claim, not a whole file.** `sec-007` passing proves only SQL
  parameterisation, not that `security.md` (SSRF, XXE, secrets, supply-chain) is
  cuttable. Even a flat-identical result makes a rule a **per-section cut candidate**,
  never a whole-file delete candidate.
- **`--runs 1` is a smoke test, never a result.** The pilot's non-monotonic n=1
  pattern (v1 FAIL while v2 PASS) inverted at n=3. Compare variants at n≥3, n=7 where a
  result is close.

### 6.4 The pre-registered expectation for `vbc-001`

`verification-before-completion.md` is the one rule that showed an effect (README:
2/3 vs 0/3 at the repo axis, Fisher p ≈ 0.2 — signal, not significance). It ships from
the baseline like the rest. **Stated before the baseline run:** we expect
`v0-full` ≥ 5/7 and `v2-no-rules` ≤ 1/7 — i.e. the effect is real and
`verification-before-completion.md` should be **KEPT** in the baseline. If instead the
two converge (both ≥ 6/7 or both ≤ 1/7), the repo-axis signal was an artifact and the
rule becomes a per-section cut candidate fleet-wide. Anything in between raises n; it
does not cut. Writing this down before the run is the point: it stops a
14-repo-affecting decision from being reverse-engineered out of whichever number
appears.

---

## 7. The learnings index is not a second delivery path (GitLab #1014)

> Measured **2026-08-13** at commit `c87102b`, branch `feat/memory-pipeline-1015-1014-1016`.
> `.claude/rules/` and `CLAUDE.md` were **clean at HEAD** for every measurement below
> (`git status --porcelain -- .claude/rules CLAUDE.md` → 0 lines); the dirty paths in the
> working tree were sibling agents' `scripts/` and `tests/` files, none of which this
> section measures.

§5 recommends against building a second delivery path, because injecting a scoped rule
block alongside undiminished native loading costs **+72%**. Issue #1014 then shipped an
injected block. This section exists to answer the obvious question — *is the learnings
index the thing §5 forbids?* — with numbers rather than with an assurance.

**It is not, by a factor of 92.** The forbidden path re-sends 122,875 bytes the agent is
already receiving. The index sends **1,405–1,727 bytes the agent receives nowhere else**:
**+0.79% to +0.97%** of the re-measured baseline.

> **⚠ Amendment, 2026-08-13 — every byte figure in §7 below is PRE-FRAMING.**
>
> §7 was measured at `c87102b`. A review panel then found that this block shipped
> agent-authored text with none of the neutralisation `<APPLICABLE-RULES>` had received in
> the same session — no fence, no wrapper-forgery rejection, no invisible-character
> stripping. The fix added a content-derived block fence and a framing preamble, at a
> **constant +320 B** independent of entry count.
>
> Re-measured by the coordinator after the fix (2 scopes, `wc -c` on the real CLI):
> `scripts/lib/reconcile/**` → **2,047 B** (was 1,727); `docs/**` → **1,234 B** (was 914).
>
> | | §7 as measured | after framing |
> |---|---:|---:|
> | band | 912–1,727 B | **1,234–2,047 B** |
> | share of the 178,096 B baseline | +0.51% – +0.97% | **+0.69% – +1.15%** |
> | ceiling (entry caps lifted) | 2,221 B / +1.25% | **2,541 B / +1.43%** |
>
> The 92× argument is unaffected — the comparison is against +122,875 B, and +320 B does not
> move it. `LEARNINGS_INDEX_MAX_CHARS = 2000` is likewise untouched: the framing sits outside
> the capped body, as the header and retrieval pointer already did.
>
> The per-scope table in §7.2 and the figures in §7.4 are left at their measured values rather
> than overwritten, so each keeps the SHA it was taken at. Read them as pre-framing.

### 7.1 The baseline, re-measured — and it did not drift

The wave-1 baseline was captured at `0fbea29`. Re-measuring at `c87102b` (3 commits later,
`git rev-list --count 0fbea29..HEAD` → `3`) gives a **byte-identical** rule corpus:

```console
$ find .claude/rules -name '*.md' | wc -l
29
$ find .claude/rules -name '*.md' -exec cat {} + | wc -c
165097
$ wc -c CLAUDE.md
9666
$ wc -c ~/.claude/CLAUDE.md
1220
$ sed -n '266,286p' skills/wave-executor/SKILL.md | wc -c   # the fenced memory.propose block
2113
```

| Component | Bytes @ `0fbea29` | Bytes @ `c87102b` | Drift | Fires |
|---|---:|---:|---:|---|
| `.claude/rules/**` (29 files) | 165,097 | 165,097 | 0 | every agent, native project-instruction loading |
| `CLAUDE.md` / `AGENTS.md` (root) | 9,666 | 9,666 | 0 | every agent |
| `~/.claude/CLAUDE.md` (user-level) | 1,220 | 1,220 | 0 | every agent on this host, outside repo control |
| `memory.propose` boilerplate | 2,112 | **2,113** | +1 | every Impl-Core / Impl-Polish / Quality agent |
| **TOTAL** | **178,095** | **178,096** | **+1** | per Impl-wave agent, before task text |

The corpus figures are reproducible from the git object store rather than from the working
tree, which is what makes the zero-drift claim checkable:

```console
$ git ls-tree -r --name-only 0fbea29 -- .claude/rules | grep '\.md$' \
    | while read f; do git cat-file blob "0fbea29:$f"; done | wc -c
165097
```

The single byte is the boilerplate's trailing newline: the block is lines 266–286 of
`skills/wave-executor/SKILL.md`, and wave 1 evidently measured it without the final `\n`.
Recording it rather than rounding it away is the point — a figure that reproduces to ±1
byte across two SHAs is a measurement; one that "matches" is an assertion.

**The rules corpus did not change this session.** The 100-record learnings corpus did. Those
are different corpora, and only the second one is what §7 adds.

### 7.2 What the index actually costs, per scope

Four **disjoint** agent file scopes, each naming real tracked files
(`git ls-files --error-unmatch` → TRACKED for all eight paths):

```console
$ echo '["hooks/pre-bash-destructive-guard.mjs","hooks/on-session-start.mjs"]' > /tmp/scope-hooks.json
$ node scripts/print-learnings-index.mjs --file-scope /tmp/scope-hooks.json --no-event | wc -c
1405
$ node scripts/print-learnings-index.mjs --file-scope /tmp/scope-hooks.json --no-event --json   # count + scopeMatched
```

| Agent file scope | Bytes | Entries | Scoped | Global fill | % of 178,096 |
|---|---:|---:|---:|---:|---:|
| `hooks/**` (2 files) | 1,405 | 7 | 3 | 4 | +0.789% |
| `scripts/lib/reconcile/**` (2 files) | 1,727 | 9 | 5 | 4 | +0.970% |
| `tests/**` (2 files) | 912 | 4 | 0 | 4 | +0.512% |
| `docs/**` (2 files — this agent's own scope) | 914 | 4 | 0 | 4 | +0.513% |
| *control:* `tests/**` naming two paths the corpus does carry | 1,240 | 6 | 2 | 4 | +0.696% |

The corpus behind these numbers, measured rather than quoted:

```console
$ wc -l < .orchestrator/metrics/learnings.jsonl
100
$ node -e '…JSON.parse each line; count Array.isArray(r.file_paths) && r.file_paths.length>0…'
total=100 with_file_paths=17 pct=17.0%
```

**17 of 100 records carry `file_paths`.** That fraction, not the CLI, is what governs the
scoped column — and the `tests/**` row is the honest demonstration. It returned **0 scoped
matches** even though the corpus holds 6 `tests/` path entries, because those 6 name
different files (`tests/lib/session-registry.test.mjs`,
`tests/scripts/gates/gate-helpers.test.mjs`, …) than the two a plausible agent declared.
The control row re-runs the same scope against two paths the corpus *does* carry and
recovers 2 scoped matches. Matching is exact-path; the 0 is correct behaviour, not a defect.

The practical reading: **at 17% `file_paths` coverage, a majority of scopes will fall back
entirely to the global fill.** The index degrades to "top 4 general learnings" rather than
to nothing, which is the right failure mode, but it is not yet per-agent for most agents.
The lever is `--file-paths` adoption at proposal time, not the selector.

### 7.3 The delta, and the comparison that settles the question

Absolute: **+912 to +1,727 bytes**, ceiling **+2,221** (§7.4). As a share of the
re-measured 178,096-byte baseline: **+0.51% to +0.97%**, ceiling **+1.25%**.

| Path | Added bytes | As % of baseline |
|---|---:|---:|
| §5's forbidden path — scoped rule block alongside native delivery | +122,875 | **+72.3%** |
| §7's learnings index — measured worst case of four scopes | +1,727 | **+0.97%** |

**92×.** Two structural facts produce that gap, and each is checkable:

1. **It rides a channel the repo already writes itself.** The index is prepended to the
   dispatch prompt — the same channel that already carries the task text and the 2,113-byte
   `memory.propose` boilerplate. It does not add a delivery mechanism; it adds a block to a
   prompt the coordinator was already composing. §5's +72% is entirely the cost of
   *duplicating* a channel that keeps delivering regardless.
2. **Learnings have no native delivery to duplicate.** `.orchestrator/metrics/learnings.jsonl`
   is not a `.md` file under `.claude/rules/`, and neither `CLAUDE.md` nor its Codex-CLI
   alias `AGENTS.md` imports it (`grep -c "^@" CLAUDE.md` → `0`, unchanged from §1). Nothing
   in the 178,096-byte baseline carries this content. The index is the *first* delivery of
   it, not the second.

#### 7.3.1 …except for 13 records, and the index does not exclude them

Fact 2 is true of the corpus but not of every record in it. `/reconcile` converts qualifying
learnings into `.claude/rules/*.md` files — which **are** natively delivered. Those rules
carry their source in provenance, so the overlap is measurable:

```console
$ grep -rlha "learning-id:" .claude/rules/*.md | wc -l
13
$ grep -rha "^- learning-id:" .claude/rules/*.md | sed 's/.*`\(.*\)`.*/\1/' > /tmp/rule-lids.txt
$ # then: for each scope, intersect the index's learning ids with /tmp/rule-lids.txt
hooks:   entries=7 already_a_rule=1
scripts: entries=9 already_a_rule=0
tests:   entries=4 already_a_rule=0
docs:    entries=4 already_a_rule=1
```

**13 of 100 learnings have already become natively-delivered rules, and the selector does
not filter them out.** In two of four scopes, one indexed entry was content the agent was
already receiving in full — a genuine, if small, second delivery of that record. The
duplicated unit is one ~150-byte index line against a multi-KB rule file, so the waste is
bounded and far below the measurement noise of §7.1; it does not change the +0.97% figure
or the 92× conclusion. But it is a real instance of the exact pattern §5 forbids, found by
looking for it, and it is cheap to close: the selector has each record's id and the rule
files carry theirs. **Filed as a follow-up rather than fixed here — this section's file
scope is documentation, and the fix is a change to `scripts/lib/learnings/select.mjs`.**

### 7.4 The 2,000-character cap is slack; the entry-count caps bind

`LEARNINGS_INDEX_MAX_CHARS = 2000` (`scripts/lib/learnings/select.mjs:89`) is a hard cap on
the rendered **body**. Under the shipped defaults it is never reached:

```console
$ node scripts/print-learnings-index.mjs --file-scope /tmp/scope-hooks.json --no-event | wc -c
1405
$ node scripts/print-learnings-index.mjs --file-scope /tmp/scope-hooks.json --no-event \
    --max-scoped 100 --max-global 100 | wc -c
2221
$ node scripts/print-learnings-index.mjs --file-scope /tmp/scope-hooks.json --no-event \
    --max-scoped 100 --max-global 100 --max-chars 100000 | wc -c
15588
```

| Constraint | Result | Binds? |
|---|---:|---|
| default caps (8 scoped / 4 global / 2,000 chars) | 1,405–1,727 B | entry caps bind |
| entry caps lifted, char cap at 2,000 | 2,221 B | **char cap binds** |
| both lifted (whole corpus as an index) | 15,588 B | nothing binds |

The binding constraint under defaults is **`--max-global 4`**, not the char cap. The
telemetry's `truncated: true` says so precisely: it is set at `select.mjs:389` by
`scoped.length > maxScoped || global.length > maxGlobal` — an **entry-count** overflow, not
a character overflow. Reading `truncated: true` on a 1,405-byte block as "the 2,000 cap bit"
would be wrong.

Slack, stated plainly: **816 bytes of body headroom on the `hooks` scope, 494 on `scripts`**
(the rendered block carries a 221-byte header outside the capped body, which is why the
lifted-caps run reports 2,221 rather than 2,000). The cap is a backstop against a corpus
that grows an order of magnitude — at 100 records it never fires. The number that would
make it fire is 15,588: the whole corpus rendered as an index is **7.8×** the cap, so the
cap is doing real work as a ceiling even while slack today.

### 7.5 The per-agent claim, verified empirically

Not read off the code — run, on two disjoint scopes, comparing the emitted subjects:

```console
$ # hooks scope
## Learnings Index (selected for your file scope)

7 entries (3 matched your declared file scope, 4 general). One line each — this is an INDEX, not the corpus.
Full text of any line: `grep -F '"subject":"<subject>"' .orchestrator/metrics/learnings.jsonl`

- anti-pattern/an inline @returns-never warn helper at a rule-loop warn site flips a later block to ALLOW: …
- anti-pattern/policy rule with a new type field must ship with its consuming hook branch in the same change: …
- anti-pattern/release() proof gate hinges on proof !== undefined — every call site must spread-guard: …
[4 more]

$ # scripts scope
## Learnings Index (selected for your file scope)

9 entries (5 matched your declared file scope, 4 general). One line each — this is an INDEX, not the corpus.
Full text of any line: `grep -F '"subject":"<subject>"' .orchestrator/metrics/learnings.jsonl`

- anti-pattern/A hardcoded expected value that coincides with a clamp/floor for one day is a green that proves nothing: …
- proven-pattern/security-floor policy loaders must merge, not first-hit-resolve: …
- recurring-issue/Eine Session ohne durchgelaufenes /close hinterlaesst unpushed Commits …
[6 more]
```

Set-compared rather than eyeballed:

```console
$ # intersect the two --json subject lists
hooks entries: 7 | scripts entries: 9
intersection: 2 | hooks-only: 5 | scripts-only: 7 | Jaccard: 0.143
```

**Two disjoint scopes share 2 of 14 distinct entries (Jaccard 0.143).** Both shared entries
are global fill; the scoped selections are fully disjoint. The block is genuinely
per-agent, not a constant wearing a scope's name — which is the claim §3.1 could *not* make
about glob-scoped rules, where the "scoped" saving turned out to be a constant 40,254 bytes
of tier filtering.

### 7.6 The telemetry answers "did the injector ever run?"

§1 could establish that `rule-loader.mjs` does not run at delivery time only by grepping for
the absence of a caller. That is an argument from silence, and §1.2 records how it failed:
a census keyed on the payload missed the prose call site entirely. The index does not
require that argument — it emits an event:

```console
$ grep -ac 'orchestrator.learnings.index.injected' .orchestrator/metrics/events.jsonl
1
$ node scripts/print-learnings-index.mjs --file-scope /tmp/scope-hooks.json > /dev/null
$ grep -ac 'orchestrator.learnings.index.injected' .orchestrator/metrics/events.jsonl
2
$ grep -a 'orchestrator.learnings.index.injected' .orchestrator/metrics/events.jsonl | tail -1
{
 "timestamp": "2026-08-13T05:53:29.824Z",
 "event": "orchestrator.learnings.index.injected",
 "count": 7,
 "scope_matched": 3,
 "global_count": 4,
 "candidates": 94,
 "truncated": true,
 "bytes": 1405,
 "scope_source": "file-scope"
}
```

The counter moves 1 → 2 on one invocation, and the record's `bytes: 1405` is independently
equal to this section's `wc -c`. "Did it run, on what scope, and how big was it" is now a
`grep` over `events.jsonl` instead of an inference. `candidates: 94` also shows the pool is
the 94 *active* records of the 100 on disk — 6 are filtered before ranking.

### 7.7 What is NOT established — explicitly unbelegt

Four gaps. Each would move the denominator, and none is closed by anything above.

- **Whether this Claude Code build loads a root `AGENTS.md`.** One exists on disk —
  `ls -la AGENTS.md` → 14,661 bytes, **untracked** (`git ls-files AGENTS.md | wc -l` → `0`).
  The coordinator of this session confirmed from its own context window that it is *not*
  delivered to the coordinator. **Whether a dispatched subagent receives it is unverified**,
  and this agent cannot settle it: a subagent introspecting its own context is the
  self-report §1.1 already flagged as corroborating-not-load-bearing. If subagents do
  receive it, the baseline is 192,757 rather than 178,096 and the index's share *falls* to
  +0.73%. Tracked as issue **#973**.
- **Whether the `<APPLICABLE-RULES>` block fires in practice.** `wave-loop.md` makes the
  pre-dispatch injection a SHOULD, not a gate. In **this** session it was deliberately
  skipped and logged as a deviation, so the 178,096 figure **excludes it**. If it fires, the
  denominator grows by up to the 122,875 bytes §3 measured for a live wave scope and the
  index's share falls correspondingly — to roughly +0.57%. Every percentage in §7.3 is
  therefore a *conservative* upper bound on the index's share: the honest reading is
  "≤1% under the smallest defensible denominator".
- **Whether 17% `file_paths` coverage is representative.** It is the coverage of a 100-record
  corpus, 11 of whose records were recovered from a data-loss incident. Whether the recovered
  records are systematically poorer in `file_paths` than organically-proposed ones was not
  measured, and it would bias the scoped column if so.
- **Whether the §7.3.1 rule/learning overlap grows.** Measured once, at 13/100, on four
  scopes. `/reconcile` promotes learnings into rules continuously, so this ratio rises by
  construction. Nothing currently measures it on a schedule.

### 7.8 Correction to §1.3

§1.3 records a second delivery source outside this repo — the parent workspace's
`.claude/rules/parallel-sessions.md`, 5,623 bytes — and concludes the real delivered corpus
is 175,584 rather than 169,961. **That file no longer exists on this host:**

```console
$ ls -la "$(dirname "$PWD")"/.claude/rules/
ls: /Users/…/Projects/.claude/rules/: No such file or directory
```

§7's baseline therefore does not carry a parent-workspace term. This is a host-local
observation about one machine at one date, not proof the mechanism is gone — the directory
could be recreated at any time, and §1.3's structural point (that
`print-applicable-rules.mjs` reads only `<repoRoot>/.claude/rules` and cannot see such a
file) stands unchanged.

---

## Reproducing this document

```bash
# corpus size
find .claude/rules -name '*.md' | wc -l
find .claude/rules -name '*.md' -exec cat {} + | wc -c

# no repo-local injector
grep -c "^@" CLAUDE.md
node -e 'const s=require("./.claude/settings.json");console.log(Object.keys(s))'
git grep -n "loadApplicableRules" -- '*.mjs' | grep -v '^tests/'

# scoped block for an arbitrary scope (never overwrite .claude/wave-scope.json)
echo '{"allowedPaths":["scripts/lib/x.mjs"]}' > /tmp/scope.json
node scripts/print-applicable-rules.mjs --wave-scope /tmp/scope.json --context wave | wc -c
node scripts/print-applicable-rules.mjs --wave-scope /tmp/scope.json | wc -c   # glob axis only

# blast radius
git grep -l "\.claude/rules/" | wc -l

# §7 — baseline re-measure, reproducible from the object store at any SHA
git ls-tree -r --name-only <sha> -- .claude/rules | grep '\.md$' \
  | while read f; do git cat-file blob "<sha>:$f"; done | wc -c
sed -n '266,286p' skills/wave-executor/SKILL.md | wc -c   # memory.propose boilerplate

# §7 — the learnings index for one agent scope (never writes; --no-event suppresses telemetry)
echo '["hooks/on-session-start.mjs"]' > /tmp/scope.json
node scripts/print-learnings-index.mjs --file-scope /tmp/scope.json --no-event | wc -c
node scripts/print-learnings-index.mjs --file-scope /tmp/scope.json --no-event --json

# §7.4 — which cap binds
node scripts/print-learnings-index.mjs --file-scope /tmp/scope.json --no-event \
  --max-scoped 100 --max-global 100 --max-chars 100000 | wc -c

# §7.6 — did the injector run?
grep -ac 'orchestrator.learnings.index.injected' .orchestrator/metrics/events.jsonl
```

## See also

- `scripts/lib/rule-loader.mjs` — `loadApplicableRules()`, the loader that does not run at delivery time
- `scripts/print-applicable-rules.mjs` — the CLI bridge; reads only `<repoRoot>/.claude/rules`
- `scripts/lib/instruction-budget-guard.mjs` — the existing measurement + ceiling instrument
- `docs/rule-authoring.md` — frontmatter contract (and the stale claim at line 8)
- `scripts/print-learnings-index.mjs` — §7's per-agent index CLI; emits `orchestrator.learnings.index.injected`
- `scripts/lib/learnings/select.mjs` — the selector; `LEARNINGS_INDEX_MAX_CHARS = 2000` at line 89, `truncated` at line 389
