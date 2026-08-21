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

When a class crosses ~10%, **re-aim the instrument — do not obey it, do not
silence it**. Obeying caps every wave on noise; silencing drops a protection
whose hazard is real (2026-04-19: 8-session host freeze plus two worktree OOMs).


## HR-102: Judge on the Best Signal Present, Never on a Worse One

Precedence is a property of the measurement, not a preference. For memory:

```
memory_pressure_pct_free   (the OS's own health verdict)   — highest
ram_available_gb           (free + inactive + speculative + purgeable)
ram_free_gb                (os.freemem)                    — last resort
```

`os.freemem()` on Darwin reports only `Pages free` — median **0.4 GB** across the
corpus, on hosts with 24-128 GB installed. It is off by an order of magnitude and
always in the same direction. On Linux/Windows it IS accurate, which is exactly
where nothing better is published, so the fallback there is correct rather than a
concession.

**A better signal REPLACES a worse one — it does not merely suppress it.** The
half-fix (#667) suppressed free-RAM only when pressure was *healthy*, leaving the
whole band "pressure present but below 30%" still judged on Pages-free.
Suppression is a patch; precedence is the fix.

## HR-103: Check the Unit Before the Threshold

`concurrent-sessions-warn` is denominated in **sessions**. It was compared
against `claude_processes_count`. Measured ratio processes:sessions = **6.0**
(median over 1461 paired samples). Same threshold, right denominator:

```
claude_processes >= 5    93.6%      ← wrong unit
peer_sessions   >= 5      4.2%      ← right unit, same number
```

No threshold change would have fixed this, and any would have hidden it. Before
tuning a number, confirm both sides of the comparison are the same kind of thing.
The live count comes from `detectPeers()` — self excluded, heartbeat-fresh.

## HR-104: Two Independent Signals Before Any Cap

- **hard signal** (memory pressure in the red band, or swap over the hard band
  *while memory is already unhealthy*) → `critical`, coordinator-direct.
- **two independent soft signals agreeing** → `warn`, cap agents at 2.
- **one soft signal** → report it in `reasons`, cap nothing.
- **none** → `green`.

One noisy axis must not decide wave size. Simulated on the same corpus:
`cpu>90 AND peers>=3` fires on 2.2%; `peers>=4` alone on 7.4%.

**Not every signal is eligible to be one of the two.** One that is essentially
always present is no second opinion — pairing it with any axis restores the
one-signal cap under a two-signal name. Zombies are the case: idle by definition
(so not causing the load they pair with) and a standing condition — 6, 13 and 9
in three readings minutes apart. They report, never count. Caught by the first
live run after the rebuild: `warn | cap 2 | soft: ["cpu","zombies"]`. Before
admitting a new axis, measure how often it is present; "usually" means report.

Three corollaries worth stating because all three were live defects:

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
all in one April week — and persisted the two misleading fields. The 99% firing
rate was therefore unfalsifiable for four months, while six repos independently
wrote the false alarm into their learnings store (one at confidence **1.0**)
where no threshold could read it.

- Session-start persists the signals the verdict is **computed from** —
  `memory_pressure_pct_free`, `ram_available_gb`, `peer_sessions_count`.
- Re-run the firing-rate audit before changing any threshold:

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

Whatever number drives the verdict is the number the operator sees. `0.4 GB free`
beside a verdict computed from `53% pressure free` teaches distrust of the
verdict — and it was the banner, not the verdict, that six repos wrote learnings
about. One consequence is mechanical: a Claude Code SessionStart hook surfaces
only the **first** JSON object on stdout, so all banner lines must leave as
**one** `systemMessage` (measured: five emitters, four lines, one shown — and the
two warning that another session held this working copy were among the discarded).

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
