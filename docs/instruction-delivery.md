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
```

## See also

- `scripts/lib/rule-loader.mjs` — `loadApplicableRules()`, the loader that does not run at delivery time
- `scripts/print-applicable-rules.mjs` — the CLI bridge; reads only `<repoRoot>/.claude/rules`
- `scripts/lib/instruction-budget-guard.mjs` — the existing measurement + ceiling instrument
- `docs/rule-authoring.md` — frontmatter contract (and the stale claim at line 8)
