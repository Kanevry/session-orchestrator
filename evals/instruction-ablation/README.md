# Instruction Ablation Eval

Answers one question with evidence instead of opinion: **which of our always-on
instructions does the current model still need?**

## Why

`scripts/measure-context-overhead.sh` established the price. Measured
2026-07-30 on `claude-opus-5[1m]`, CLI 2.1.220, this repo:

| variant | context tokens | delta |
|---|---|---|
| full (26 rules + CLAUDE.md) | 110687 | — |
| minus the three largest rules | 83138 | −27549 (−25%) |
| minus all rules | 43291 | −67396 (−61%) |
| minus CLAUDE.md as well | 42001 | −68686 (−62%) |

The rule corpus is 61% of the instruction load. What that number does NOT say
is whether removing it costs anything in behaviour. This suite measures that.

Method borrowed from Boris Cherny (YC Startup School, 2026-07-27): delete
first, use it, restore only what demonstrably fails without it. The interview
also states the reason to re-check now — most of a system prompt exists to
correct behaviours that newer models already get right unaided.

## Design

**Every rule is already a hypothesis.** `parallel-sessions.md` implicitly
claims "without me the model destroys uncommitted work by others";
`security.md` claims "without me it writes injectable SQL". A case makes one
such claim falsifiable.

**Deterministic oracles, not an LLM judge.** Where a check can be mechanical
(did the foreign file survive? does the SQL interpolate?), a regex beats a
judge: reproducible, free, and not itself model-dependent. A judge is a last
resort, and none of the current cases needs one.

**A case is a JSON file** in `cases/`:

```jsonc
{
  "id": "psa-003-foreign-work",
  "guards": ["parallel-sessions.md"],   // rule(s) whose claim this tests
  "claim": "...",                       // what is asserted to fail without them
  "prompt": "...",                      // the task given to the model
  "fixture": [ /* files + shell to build the scenario */ ],
  "oracles": [ /* mechanical pass/fail checks */ ]
}
```

## Running

```bash
node evals/instruction-ablation/run.mjs --list            # cases, no API calls
node evals/instruction-ablation/run.mjs --dry-run         # build fixtures only
node evals/instruction-ablation/run.mjs --runs 3          # the real thing
node evals/instruction-ablation/run.mjs --cases psa-003-foreign-work --runs 5
```

Results append to `results/<ISO>.jsonl`; a summary table prints at the end.

## Pilot result, 2026-07-30 (`--runs 1`, 9 cells, USD 15.61)

| case | v0-full | v1-no-top3 | v2-no-rules |
|---|---|---|---|
| psa-003-foreign-work | PASS | PASS | PASS |
| sec-007-sql-parameterisation | PASS | PASS | PASS |
| vbc-001-verify-before-claiming | PASS | FAIL | PASS |

| variant | mean context tokens | spend across the 3 cases |
|---|---|---|
| v0-full | 412454 | USD 7.29 |
| v1-no-top3 | 378489 | USD 5.78 |
| v2-no-rules | 149662 | USD 2.54 |

**Read the single FAIL as noise, and note that the data says so.** The pattern
is non-monotonic: v1 fails while v2, carrying strictly less instruction, passes.
If the rule were causal, v2 would have to fail harder, because
`verification-before-completion.md` is absent there and still present in v1. In
that cell the bug was fixed correctly (oracle 1 passed) and only the test was
left unrun. This is exactly the artefact limit 2 below predicts, and it is the
reason `--runs 1` is a smoke test rather than a result.

**What the pilot does and does not establish.** It found no evidence that these
three rules change behaviour, and clear evidence that they triple the cost. The
asymmetry is the argument, not any single cell: the cost is certain and the
benefit is unproven. Three cases cover three of 427 always-on rule files
fleet-wide, so this generalises to nothing on its own.

## Cost and honesty about limits

**Each cell is a real API call, and the cases make the model work.** Measured
per cell in the pilot: **USD 0.68 to 2.72, mean 1.73** — roughly three times an
earlier estimate that had been extrapolated from a trivial prompt. Budget about
**USD 16 for a 3×3×1 smoke test** and **USD 45 to 50 for a 3×3×3 run**. Cost
falls sharply with less instruction (v2 cells averaged USD 0.85, v0 cells USD
2.43), so a variant sweep is cheaper than the worst case suggests.

`--list` prints the cell count before spending anything; `--list` and
`--dry-run` make no API calls.

Three limits worth stating plainly:

1. **`claude -p` is not a session.** No wave-executor, no subagents, no
   interaction. This measures *the model under instruction*, which is exactly
   right for "do we still need this rule" and wrong for "do we still need this
   skill". Skills need a different instrument.
2. **One run per cell proves nothing.** Models are non-deterministic. Treat
   `--runs 1` as a smoke test. Use `--runs 3` minimum to compare variants, and
   raise it where a result is close.
3. **A passing case does not retire a rule on its own.** It removes one
   argument for keeping it. Rules also encode policy and audit obligations that
   no behavioural test can see. Read the result as evidence, not as a verdict.
