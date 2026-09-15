# Research Evidence Contract

Use this contract when research informs a plan, audit, recommendation, or
research-agent handoff. Scale it to the decision: a trivial local lookup may be
one sentence; a comparison with several sources needs one record per material
claim. It does not require external research when repository evidence is enough.

## Record

For each finding that changes the recommendation, retain:

- **Source:** stable reference plus source revision or publication/update date.
  For repository evidence, prefer `SHA:path:line`; for changing external facts,
  include the observation date.
- **Basis:** label the finding `observed` for a measurement or source-code
  inspection (name which), `documented` for a source's claim, or `inference`
  when it follows from other evidence. A test found in source is not an
  executed test. Never present one class as another.
- **Local equivalent:** name the existing repository feature, dependency, rule,
  or workflow that already covers the need; use `none found` only after a search
  proportionate to the task.
- **Disposition:** `adopt`, `adapt`, `experiment`, `reject`, or
  `already stronger`, with one short reason. `Adopt` still means implement
  through the current repository's conventions; it does not authorize copying,
  installing, publishing, or another external mutation.
- **Next check:** state one falsifiable next step when uncertainty remains: what
  result would confirm or overturn the disposition.

Keep quoted text minimal. Record limitations that materially constrain the
claim. A source revision proves which artifact was inspected; it does not prove
that its documented behavior works.

## Private sources

Treat private/internal sources as evidence for an authorized private audience
only. Follow [Private capability context](private-capability-context.md) for
lookup and retention. Do not copy private identities, paths, excerpts, or
derived implementation details into a public plan or handoff. Re-establish a
public claim from an authorized public source, or omit it. Source access never
expands the task's implementation or external-action authority.

## Compact example

```text
Source: vendor guide, rev 3.2, observed 2026-09-15
Basis: documented — retries use exponential backoff; runtime behavior untested
Local equivalent: src/retry.mjs already provides capped linear retries
Disposition: experiment — compare failure recovery before changing the default
Next check: 100 replayed failures; reject if success rate does not improve
```
