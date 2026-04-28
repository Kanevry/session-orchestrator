# Lifecycle-sim v6 — enforcement vs stagnation rate

> **Status:** experiment, n=100 simulated sessions per mode, fixed RNG seed.
> **Verdict:** **inconclusive** — keep `enforcement: warn` as the current default.
> **Issue:** GL #86. Closes the directional question; the statistical question
> remains open and is correctly waiting on real telemetry from GL #84.

## Why a sim, not real runs

Issue #86 originally proposed three real n=1 deep-session runs across
`enforcement: off | warn | strict`. That branch is blocked: the stagnation
telemetry promised by GL #84 has not landed yet, so a real run cannot emit
the events the experiment wants to compare.

v6 substitutes a discrete-event simulation. It is intentionally crude — its
job is to surface whether the **mechanism** the issue worries about
("strict makes scope-friction cascade into stagnation") is mathematically
plausible under the parameter space we currently believe in. If the sim
already shows no signal, real runs are unlikely to produce one either, and
we should redirect effort.

## Method

The sim (`scripts/lifecycle-sim-v6.mjs`) walks a fixed number of synthetic
sessions per enforcement mode, with one shared RNG seed per run. Each
session:

1. Draws `planned_issues` from a clipped Gaussian (mean 12, σ 5, clamp [5, 25]).
2. Adds carryover from the previous session.
3. For every planned issue, rolls a Bernoulli trial against
   `scopeFrictionProb` (0.12). A friction event represents the agent
   tripping the scope hook (PSA-001/002 or PreToolUse/Edit).
4. Each friction event is then rolled against `blockConversionRate` to
   decide whether it becomes a permanent block. **This is where the modes
   diverge:**
   - `warn`: friction is logged but the agent retries; conversion 0.18,
     completion penalty 0.015 per event.
   - `strict`: friction hard-aborts the step, agent re-plans; conversion
     0.08, completion penalty 0.025 per event.
5. Effective completion = `baseCompletion (0.78) + jitter ± 0.08 −
   frictionEvents × penalty`, clamped to [0, 1].
6. Unfinished issues carry over (carryoverFraction 1.0 — worst-case).
7. A session is "stagnant" when its carryover ratio exceeds 0.5; a
   "stagnant streak" of length ≥ 3 is the bucket of interest.

The two penalty/conversion knobs encode the issue's hypothesis: strict
mode hurts per-event completion more (the agent loses work mid-flight)
but produces fewer permanent blocks (no partial-but-wrong artifacts to
clean up later).

## Results — primary run (seed 42, 100 sessions per mode)

| metric                 |  warn |  strict | delta (strict − warn) |
|------------------------|------:|--------:|----------------------:|
| total planned issues   |  1710 |    1582 |                  −128 |
| completed              |  1231 |    1161 |                   −70 |
| permanently blocked    |    40 |      19 |                   −21 |
| **completion ratio**   | 0.720 |   0.734 |                +0.014 |
| mean carryover ratio   | 0.276 |   0.263 |                −0.013 |
| p95 carryover ratio    | 0.375 |   0.375 |                 0.000 |
| **stagnation rate**    | 0.000 |   0.000 |                 0.000 |
| longest streak         |     0 |       0 |                     0 |

## Cross-seed sanity

Re-running with `--seed 7` and a 5× longer horizon (`--sessions 500
--seed 42`) keeps the qualitative picture intact: completion ratios
within ±0.02 of each other, carryover means within ±0.02, **stagnation
rate flat at 0.000 across every configuration tried.**

Determinism checked by running `--seed 42 --sessions 100 --json` twice;
byte-identical output.

## Interpretation

Two things to take away.

**1. The mechanism the issue worries about does not show up.** Under the
parameter space encoded here (which is generous to the worry — friction
prob 12%, full carryover, three-session streak threshold), neither mode
produces a single stagnant session. Stagnation is bounded above by
`(1 − completionRate − jitter)` and the system equilibrates near
~27% carryover, well below the 50% threshold the issue defines. The
intuition that "strict cascades scope-friction into stagnation" is not
mechanically supported by reasonable numbers.

**2. The strict-vs-warn gap is within seed-noise.** Strict converts
fewer events into permanent blocks (19 vs 40) and edges out warn on
overall completion (+1.4pp), but flips sign at seed 7 (warn ahead by
1.2pp at 500 sessions). With n=1 mode-pair per seed there is no honest
way to claim a winner.

**Verdict: inconclusive. Keep `enforcement: warn` as the documented
default in `CLAUDE.md` Session Config.** The sim provides no evidence
to flip; the issue's worry-mechanism is not reproduced; and the
strict-side improvement on permanent blocks is small enough that it
could plausibly be wiped out by a different friction model.

## Caveats

- **All parameters are guesses.** `scopeFrictionProb`, the two penalty
  knobs, and `blockConversionRate` are the author's best estimate; we
  have no instrumented data yet (that is GL #84). The sim is sensitive
  to these — bumping `scopeFrictionProb` to 0.40 and `carryoverFraction`
  to 1.0 produces non-zero stagnation in both modes but still no clear
  warn-vs-strict winner.
- **The sim does not model `enforcement: off`.** The original issue
  asked for off/warn/strict. Real runs should still capture all three;
  the sim drops `off` because without telemetry there is nothing to
  parameterise it from.
- **n=100 simulated sessions is not n=1 real session.** Real sessions
  have human-in-the-loop dynamics (you sometimes intervene to unblock
  a wave) that the sim cannot represent.

## Recommendations for the next experiment

1. **Unblock GL #84 first.** Real stagnation telemetry is the
   precondition; without it any v7 will be the same shape as v6.
2. **When real telemetry exists, run the original n=1 off/warn/strict
   triplet** as the issue specified. Use this report as the sim-side
   baseline so the real run is interpreted against pre-registered
   expectations rather than improvised hypotheses.
3. **Defer the `enforcement` default flip discussion** until at least
   one real triplet exists. Do not ship a default change on the basis
   of this sim.

## Reproducing

```bash
# Primary run reported above
node scripts/lifecycle-sim-v6.mjs --sessions 100 --seed 42

# Machine-readable
node scripts/lifecycle-sim-v6.mjs --sessions 100 --seed 42 --json

# Determinism check — second invocation must be byte-identical
node scripts/lifecycle-sim-v6.mjs --sessions 100 --seed 42 --json \
  > /tmp/sim.a.json
node scripts/lifecycle-sim-v6.mjs --sessions 100 --seed 42 --json \
  > /tmp/sim.b.json
diff /tmp/sim.a.json /tmp/sim.b.json   # exits 0
```

Closes #86.
