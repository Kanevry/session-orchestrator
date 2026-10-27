# PRD Pre-Mortem Panel — Two Subagent Briefs

> Dispatched by SKILL.md Phase 4.5, after the PRD draft and before the PRD reviewer (Phase 5). Two read-only agents, one message, in parallel. Each receives its brief below verbatim plus the PRD path; neither sees the other's output.

## Why two briefs

Back-test 2026-10-19: three committed PRDs replayed in history-truncated clones against 43 surprises their later history recorded. The PRDs as shipped anticipated 0 of 43 (15 partially). A refute brief and a deepening brief each hit 7–8; together 11, because they find different classes. The refute brief hit security and structure (an unbounded command surface, generated mirrors missing from the file list). The deepening brief hit oracle gaps: a package census that was not the installed artifact, a run that was never measured and read as fixed, a lifecycle never exercised. Neither brief prevents the most frequent class on its own. Real-world acceptance stayed undone in 3 of 3 PRDs, so it is carried as structure (template § External Acceptance, SKILL.md § 6.1), not as a prediction.

**Relation to `/grill`:** `/grill` is the interactive counterpart, one question per turn with the operator defending the plan (`skills/grill/soul.md` Tactics 5–6). This panel is the non-interactive pass `/plan` always runs. A prediction the merge cannot settle without the operator is a `/grill` candidate, not a silent drop.

## Shared rules (both briefs)

- Read-only. No edits, commits, network writes, or issue comments. Read the code the PRD touches, and run cheap local commands (grep, the repo's own scripts, `--help`, `ps`).
- Every claim carries one evidence pointer: `file:line`, a command and its result, or the word `inference`. Never pass an inference off as a measurement (`skills/_shared/research-evidence.md` § Basis).
- At most 20 predictions, P1..P20, each ≤2 sentences, concrete and checkable: what will go wrong, which assumption fails, what work will be missing, or what will be found later. No generic advice.
- Return one Markdown report as your final message.

## Judge order

The one ranking of outside judges in this repo; Brief B step 4 and `/deepen` pick from it. Take the highest rung that can run:

1. An executable check that returns a result: a test, a type check, a benchmark, a query on the raw data, a reconciliation of totals.
2. A held-out check on data the work was not fitted on.
3. A reviewer with fresh context who sees only the output and the requirement.
4. The operator, with exact questions, only when (1) to (3) do not exist. A result judged only by the operator is reported as "accepted by the operator", never as "verified".

None of these available: `UNVERIFIED: kein Außenrichter (<what would provide one>)`.

## Brief A — Refute

You review the PRD at `<path>` as the engineer who will be paged when it fails. Assume it ships exactly as written. Find what breaks, using the repository rather than the text. In particular:

1. **Live path:** is the code path the PRD changes the one that runs in production? Census the callers and quote the grep.
2. **Input surfaces:** every value read from a file, manifest, register or argument that reaches `exec`, `kill`, the filesystem, a URL or argv. Ask what a hostile or corrupt value does.
3. **Declared-unchanged modules:** read each module the PRD calls "unchanged" or "reused" for the invariants the plan relies on.
4. **Consumers and mirrors:** who reads the new signal (events, rubrics, telemetry, reports), and which generated mirrors, inventories or counts must move with it.
5. **States:** for every read, what happens when the input is missing, unreadable or half-written, as distinct from empty.

Output: `## Predictions` (P1..P20).

## Brief B — Deepen

The operator wants a deeper version of these tasks, not bigger ones. Work the four steps against the actual material, and do each step rather than only naming it:

1. **Practice:** what would a top professional in this field do here that the PRD does not ask for? Name the field first.
2. **Raw material:** what is the rawest material they would start from instead of what has already been digested (the issue text, docs, a summary)? That means the installed artifact, the platform binary or contract, live process or event data, a real run's output, the git history of the area. Open it where it is reachable and report what it shows.
3. **Methods and tools:** name the specific methods and tools they would use, and apply them where it is cheap.
4. **Oracle:** what, other than the author or the operator, would show the result is right? Pick per § Judge order. For each acceptance criterion, name that judge and say whether the PRD uses it. The author's own unit test against a fake does not count.

Then rewrite the acceptance criteria to ask for exactly that: same scope, each criterion bound to its oracle. Name the criteria whose oracle cannot run inside an implementing session.

Output: `## (1) Practice` · `## (2) Raw material` · `## (3) Methods` · `## (4) Oracle` · `## Rewritten acceptance criteria` · `## Predictions` (P1..P20).

## Coordinator merge (SKILL.md Phase 4.5)

1. **Predictions:** a prediction with an observed pointer that the coordinator re-checks in one command enters § Risks with its pointer and a Triage value. A prediction resting on `inference` enters as `unverified`, or is dropped with a one-line reason. Duplicates across briefs merge. Re-check before adopting (RCR-003); a brief's word is a claim, not a measurement.
2. **Oracles:** every acceptance criterion gets an `Oracle:` line taken from Brief B, or `Oracle: n/a — <reason>`. A criterion whose oracle cannot run in the implementing session moves to § External Acceptance with an owner, a not-before date, a pass condition and a fallback.
3. **Premise:** a Brief B raw-material finding that contradicts § 1 goes to the operator via AUQ before the reviewer runs. It is a premise change, not a risk.
4. **Budget:** the panel deepens, it does not widen. A prediction that would add scope goes to Out-of-Scope or a follow-up, never silently into In-Scope.
