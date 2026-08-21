# Host-Resource Signals (Always-on)

A host-resource warning exists to change a decision — shrink a wave, sequence a
session, stop before a freeze. A warning that fires on almost every session
changes nothing except how fast the operator learns to ignore it. This rule
exists because ours did exactly that for four months, and the correction was
never "raise the threshold" — it was "measure the right quantity".

Governing principle, one line:

> **A signal may only warn if it is rare.**

## HR-101: A Warning Class Above ~10% Is a Broken Instrument

Measured 2026-08-21 over **1477 `orchestrator.session.started` events across 18
repos** (2026-04-19 → 2026-08-21, `.orchestrator/metrics/events.jsonl` per repo):

| Rule as it stood | Fired on |
|---|---|
| `ram_free_gb < 2` (the **critical** threshold) | 84.0% |
| `claude_processes >= 5` | 93.6% |
| `cpu_load_pct > 80` | 15.6% |
| **any of the three** (= warn or worse) | **99.0%** |

Against 4884 recorded `orchestrator.session.stopped` events in the same window:
zero OOM markers, zero ENOSPC, and no exit code recorded at all.

When a class crosses ~10%, the response is to **re-aim the instrument, not to
obey it and not to silence it**. Both of the other two responses are failures:
obeying it caps every wave on noise, silencing it removes a protection whose
underlying hazard is real (2026-04-19: 8-session host freeze plus two worktree
OOMs; a separate repo recorded, conf 0.9, Chromium mis-painting under genuine
memory pressure).

## HR-102: Judge on the Best Signal Present, Never on a Worse One

Precedence is a property of the measurement, not a preference. For memory:

```
memory_pressure_pct_free   (the OS's own health verdict)   — highest
ram_available_gb           (free + inactive + speculative + purgeable)
ram_free_gb                (os.freemem)                    — last resort
```

`os.freemem()` on Darwin reports only `Pages free`. Median across the corpus:
**0.4 GB**; 53.8% of samples below 0.5 GB — on hosts with 24-128 GB installed.
Live on the reference host: `ram_free_gb 0.1` / `ram_available_gb 6.6` /
`memory_pressure 53% free`, machine fully responsive. The free number is not
merely pessimistic, it is off by more than an order of magnitude and always in
the same direction.

**A better signal REPLACES a worse one — it does not merely suppress it.** The
earlier half-fix (#667) only suppressed a free-RAM verdict when pressure was
*healthy*, which left the entire band "pressure present but below 30%" still
being judged on Pages-free. Suppression is a patch; precedence is the fix.

On Linux and Windows `os.freemem()` IS accurate, and there the fallback is
correct rather than a concession — the demotion is Darwin-specific by
construction, because only Darwin publishes the two better signals.

## HR-103: Check the Unit Before the Threshold

`concurrent-sessions-warn` is denominated in **sessions**. It was compared
against `claude_processes_count`. Measured ratio processes:sessions = **6.0**
(median over 1461 paired samples). Same threshold, right denominator:

```
claude_processes >= 5    93.6%      ← wrong unit
peer_sessions   >= 5      4.2%      ← right unit, same number
```

No threshold change would have fixed this, and any threshold change would have
hidden it. Before tuning a number, confirm the two sides of the comparison are
the same kind of thing. The live count comes from the session registry
(`detectPeers()` — self excluded, heartbeat-fresh), which is the same source the
`peer_count` event field already used.

## HR-104: Two Independent Signals Before Any Cap

- **hard signal** (memory pressure in the red band, or swap over the hard band
  *while memory is already unhealthy*) → `critical`, coordinator-direct.
- **two independent soft signals agreeing** → `warn`, cap agents at 2.
- **one soft signal** → report it in `reasons`, cap nothing.
- **none** → `green`.

One noisy axis must not decide wave size. Simulated on the same corpus:
`cpu>90 AND peers>=3` fires on 2.2%; `peers>=4` alone on 7.4%.

Two corollaries worth stating because both were live defects:

- **Cumulative counters are not live pressure.** macOS swap accumulates over
  uptime. The reference host showed 6.9 GB swap used with memory_pressure at 35%
  free and no thrash. Swap counts only when the memory signal is *already*
  unhealthy.
- **A transient is not a trend.** The 1-minute load average carries the decaying
  tail of the coordinator's own just-finished quality gate (measured: 96% → 75%
  within 36s). Judge CPU on `min(1m, 5m)`; a 1m-only spike is reported, never
  capped on (#943).

## HR-105: A Rule You Cannot Falsify Is Not a Rule

`resource_verdict` reached `sessions.jsonl` for **15 of 1734 sessions (0.9%)**,
all inside a single week in April 2026 — and the two fields it did persist were
the two misleading ones. So the 99% firing rate was unfalsifiable from stored
data for four months, while six repos independently wrote the false alarm into
their learnings store (one at confidence **1.0**, one recording "five
consecutive sessions wrongly capped at 2") where no threshold could ever read it.

Therefore:

- Every session-start persists the signals the verdict is **computed from** —
  `memory_pressure_pct_free`, `ram_available_gb`, `peer_sessions_count` — not
  only the human-readable ones.
- Re-run the firing-rate audit before changing any threshold. It is one command:

```bash
for d in ~/Projects/*/; do f="$d/.orchestrator/metrics/events.jsonl"; [ -f "$f" ] && \
  jq -c 'select(.event=="orchestrator.session.started")' "$f"; done | \
  jq -s 'length as $n | {n: $n,
    pressure_soft: ([.[]|select(.memory_pressure_pct_free != null and .memory_pressure_pct_free < 30)]|length),
    peers_over:    ([.[]|select((.peer_sessions_count // 0) >= 5)]|length),
    cpu_over:      ([.[]|select(.cpu_load_pct > 90)]|length)}'
```

A class above ~10% goes back to HR-101. A class at 0% across a few hundred
samples is equally suspect — it is either genuinely rare or silently broken, and
the two look identical from the outside.

## HR-106: The Banner Reports What the Rule Judges

Whatever number drives the verdict is the number the operator sees. A banner
printing `0.4 GB free` beside a verdict computed from `53% pressure free`
teaches the operator to distrust the verdict — and it was the banner, not the
verdict, that six repos wrote learnings about. One consequence is mechanical:
a Claude Code SessionStart hook surfaces only the **first** JSON object it
writes to stdout, so all banner lines must leave as **one** `systemMessage`
(measured 2026-08-21: five emitters, four stdout lines, one shown, and the two
lines warning that another session held this working copy were among the three
discarded).

## Anti-Patterns

- Raising a threshold that fires on 90% of samples instead of asking what it
  measures (HR-101).
- Adding a suppression clause on top of a signal that should have been replaced
  (HR-102).
- Comparing a count of processes against a threshold named for sessions — or any
  other unit mismatch that a threshold tweak would paper over (HR-103).
- Capping a wave on one axis, or treating a cumulative counter as live pressure
  (HR-104).
- Shipping a threshold whose firing rate nothing records (HR-105).
- A banner number that is not the number the rule judged (HR-106).

## See Also
parallel-sessions.md (PSA-001/002 — the peer axis this banner surfaces) ·
verification-before-completion.md · development.md § Guard & Threshold Design
(category separation over threshold raising) · test-value.md § TV-003 (the same
"measure it, don't re-derive it" discipline for the tests:src corridor) ·
`docs/session-config-reference.md` § resource-thresholds
