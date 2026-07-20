# Telemetry Claims — Provenance & Methodology

> **Not the opt-in usage-telemetry client.** This document explains the
> methodology behind the maintainer's **local, private** metrics aggregates
> (`.orchestrator/metrics/*.jsonl`, gitignored by design) used in marketing
> copy such as "645 orchestrated sessions." It is a separate data flow from
> the plugin's optional, strictly opt-in anonymous usage-telemetry client —
> see [docs/telemetry.md](../telemetry.md) for what that client collects,
> its kill switches, and where the data goes.

> Cross-repo aggregate over the maintainer's private session corpus as of 2026-06.
> Not independently auditable: the per-session records this aggregate is computed
> from are gitignored (privacy by default). This is a **snapshot, not a live
> counter** — re-running the math on a later date yields different numbers.

_As-of: 2026-06 (maintainer-reported)_

This document explains the telemetry figures used in public-facing material (e.g.
agenticbuilders.at) so the claim is verifiable in *method* even though the
absolute owner numbers cannot be reproduced from any public artifact. No marketing
copy lives here — only what each number means, where it comes from, and how it is
derived.

---

## Headline claim

> **645 orchestrated sessions · 1,680 documented learnings · 7,700+ agent runs
> (98.8% cleanly completed) · up to 34 parallel agents · 17 repos · as of 2026-06**

Every figure above is a **cross-repo aggregate** computed over the local,
**gitignored** JSONL metric files of several of the maintainer's private repos:

```
.orchestrator/metrics/sessions.jsonl
.orchestrator/metrics/learnings.jsonl
.orchestrator/metrics/subagents.jsonl
.orchestrator/metrics/events.jsonl
```

These files are listed in `.gitignore` by design (privacy by default). No public
commit, release, or CI artifact contains them, so the headline totals are
**maintainer-reported** and not independently auditable. What *is* reproducible is
the measurement recipe — see [Reproduce it yourself](#reproduce-it-yourself).

---

## Claims table

| Claim | Source file | What one record means | How aggregated | As-of |
| --- | --- | --- | --- | --- |
| 645 orchestrated sessions | `sessions.jsonl` | 1 line = 1 complete `/session` -> `/close` cycle | `wc -l` summed across all contributing repos | 2026-06 |
| 1,680 documented learnings | `learnings.jsonl` | 1 line = 1 extracted, confidence-scored learning (written by `/evolve`) | `wc -l` summed across repos | 2026-06 |
| 7,700+ agent runs | `subagents.jsonl` | 1 dispatched subagent run (see note below on `start`/`stop` pairing) | `wc -l` (or `start`-event count) summed across repos | 2026-06 |
| 98.8% cleanly completed | `subagents.jsonl` (+ `events.jsonl`) | completion status of a dispatched run | completed runs / total dispatched runs — *maintainer-reported, see methodology* | 2026-06 |
| up to 34 parallel agents | `subagents.jsonl` / `events.jsonl` | peak count of agents dispatched concurrently | max over time-windowed `start`/`stop` overlap | 2026-06 |
| 17 repos | n/a (corpus scope) | a repo that contributed at least one `sessions.jsonl` line | count of contributing repos | 2026-06 |

---

## In-repo test suite — the "10,000+ tests" badge

Distinct from the private-corpus figures above, the README **Tests** badge and the
"10,000+ vitest tests run on every commit" line count **this repository's own test
suite** — a **public, CI-verifiable** number, not a maintainer-reported aggregate.

| Claim | What it counts | How measured | As-of |
| --- | --- | --- | --- |
| 10,000+ vitest tests | executed test cases across `tests/**/*.test.mjs` | `npm test` prints the exact runtime total; the static floor is countable without running the suite (below) | 2026-06 |

Both numbers reproduce in a fresh checkout:

```bash
find tests -name '*.test.mjs' | wc -l                    # test files            -> 475
grep -rohE '\b(it|test)\(' tests | wc -l                 # static test defs      -> ~9,871
grep -rohE '\b(it|test|describe)\.each\b' tests | wc -l   # parameterized blocks  -> 93
```

The static `it(` / `test(` count (~9,871 across 475 files) is a **floor**: the 93
`it.each` / `test.each` parameterized blocks each expand to multiple executed cases
at runtime, so the **case count vitest reports on `npm test` is 10,000+**. Unlike the
private-corpus figures above, this one is fully auditable — run `npm test` in this
checkout and read vitest's summary line.

## Methodology

### Session / learning / agent-run counts

Each total is the sum of `wc -l` over the corresponding JSONL file across every
contributing repo:

```bash
# per repo, then summed by hand across the corpus
wc -l .orchestrator/metrics/sessions.jsonl    # -> orchestrated sessions
wc -l .orchestrator/metrics/learnings.jsonl   # -> documented learnings
wc -l .orchestrator/metrics/subagents.jsonl   # -> agent-run records
```

The JSONL format is append-only (one JSON object per line), so a line count is a
faithful event count. There is no de-duplication step across repos — each repo
contributes its own disjoint slice.

### "Up to 34 parallel agents"

This is the **peak** number of agents dispatched at the same time, not an average.
It is read off the time windows in `subagents.jsonl` / `events.jsonl`: each agent
run has a `start` and a `stop` record with timestamps; the peak is the maximum
number of runs whose `[start, stop]` intervals overlap at any instant. Structurally
this equals `agents-per-wave x concurrently-running waves` at the busiest moment of
the busiest session. The session config governing fan-out (`agents-per-wave`,
`waves`) lives in each repo's `CLAUDE.md` Session Config block.

> **Note (2026-07-03, refs #724):** the small-batch dispatch default (3–4 `Agent()`
> calls per message, `wave-loop.md § Dispatch Agents`) structurally lowers future
> instantaneous peaks — agents within a wave now start in staggered batches rather
> than a single simultaneous fan-out, so the overlapping-interval peak trends below
> the historical `agents-per-wave × waves` ceiling this figure was read off.

### "98.8% cleanly completed"

Defined as **runs that completed cleanly / all dispatched runs**, where a clean
completion is a run that reached its terminal `stop` with a `complete` status (as
opposed to `spiral`- or `failed`-classified outcomes the orchestrator records for
runs that loop or error out). This ratio is **maintainer-reported**: it is computed
over the owner's full private corpus, and the exact per-run status classification
is not present in every repo's local slice.

> **Caveat (verified against this repo's own slice):** in *this* public repo,
> `subagents.jsonl` records only `event: "start"` / `event: "stop"` markers (no
> per-run `status` field). The completion percentage therefore cannot be
> re-derived from this repo alone; it is an attribute of the owner's larger
> private corpus and is labelled maintainer-reported accordingly.

---

## Reproduce it yourself

Skeptics cannot reproduce the *owner's absolute totals* (the source records are
gitignored), but the **measurement pattern is fully reproducible** on your own
machine. After running N of your own sessions:

```bash
wc -l .orchestrator/metrics/sessions.jsonl    # your orchestrated sessions
wc -l .orchestrator/metrics/learnings.jsonl   # your documented learnings
wc -l .orchestrator/metrics/subagents.jsonl   # your agent runs
```

Each command returns *your* numbers using the exact same definitions in the claims
table above. As a worked example, this very repo's local slice at the time of
writing reports:

```
  29 .orchestrator/metrics/sessions.jsonl
  97 .orchestrator/metrics/learnings.jsonl
1796 .orchestrator/metrics/subagents.jsonl
```

(maintainer-reported, verifiable by running the commands above in this checkout).
The point is that the *method* is transparent and runs identically everywhere; only
the maintainer's aggregate magnitude stays private.

---

## Framing & limits

These figures are the **maintainer's own telemetry**. They are **not** Anthropic
benchmarks, not Anthropic-published limits, and not a claim about what Claude or any
model "can do" in general. They describe how this orchestrator was operated across
one maintainer's private repos.

In particular, **Anthropic does not document a hard parallel-agent limit**; the
"up to 34 parallel agents" figure is an observed peak of *this* tooling's fan-out,
not a platform ceiling. For readers who want vendor-side context on multi-agent
cost and design (cited only for orientation, not as a source for the numbers
above):

- Multi-agent token cost — "agents typically use about 4x more tokens than chat
  interactions, and multi-agent systems use about 15x more tokens." Anthropic,
  *How we built our multi-agent research system* (2025-06-13).
  <https://www.anthropic.com/engineering/built-multi-agent-research-system>
- The orchestrator-workers pattern this tool implements is described in Anthropic,
  *Building effective agents* (2024-12-19).
  <https://www.anthropic.com/engineering/building-effective-agents>

No other Anthropic claims are made or implied here.

---

## Privacy

What is **never published** from the source corpus:

- Absolute filesystem paths
- Hostnames (`.local` / `.lan` / `.internal`, etc.)
- Repository names and VCS URLs (org/repo paths)
- Prompts, session contents, or any free-form text
- Emails, git-author identities, tokens, IP addresses

Only aggregate counts and definitions leave the private corpus. This mirrors the
anonymization pattern already enforced for shared learnings by
`scripts/export-hw-learnings.mjs` (see also hardware-patterns; vault-archived; regenerated via `npm run share:hw-learnings`),
which strips paths, IPs, VCS URLs, hostnames, emails, git authors, and token-shaped
strings, and exports only structured fields — never free-form user text. The same
"counts out, records stay home" principle applies to every figure in this document.
