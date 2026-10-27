---
name: deepen
description: Make a task deeper, not bigger. Use when the user asks for a deeper or more ambitious version of a task (tiefer, geh tiefer, go deeper, ambitionierter, wie würde ein Profi das angehen) or hands over an outcome-shaped deliverable (Bericht, Auswertung, Analyse, Plan, Audit, Deck, Performance-Ziel) with no ceiling word, or types /deepen [task]. Not for single-step edits, short commands (run the tests, commit), bug fixes, prompt-wording rewrites, or any request carrying nur, bloß, schnell, just, only, quick.
user-invocable: true
argument-hint: "[task]"
model: inherit
---

# deepen

Same scope, better work: rawer inputs, sharper methods, a judge that is not the author. Never more deliverables.

## Invocation

Invoked as `/deepen [task]` with arguments: **$ARGUMENTS**, or by the model when the description matches. The task is `$ARGUMENTS`; if that is empty, the task is the operator's last request in this conversation. If there is none, say so and stop.

## Stage 1 — Intake

Quote the request verbatim. Then decide:

- **Bypass** when any of these holds:
  - a ceiling word: nur, bloß (bloss), schnell, just, only, quick;
  - a single-step edit (rename, one-line change, typo);
  - a short command (run the tests, commit, push, build);
  - a bug fix;
  - a request to reword a prompt or text;
  - the request arrived as a coordinator brief, or you run as a dispatched subagent: your scope was set upstream, so do the task and note a deeper version in one line.

  Print exactly one line `Ambition check: bypassed (<reason>)` and do the task as asked. Nothing else from this skill: no questions, no rewrite, no extra work (a dispatched agent adds only its one-line note).
- **Expand** otherwise. Print `Ambition check: expanding (<reason>)` and go to Stage 2.

## Stage 2 — Deepen

Answer the four questions of `skills/plan/prd-premortem-panel.md` § Brief B (Practice, Raw material, Methods and tools, Oracle) for this task, not for a PRD. Work them against the real material: open the files, list the directories, run cheap read-only commands. Never answer from memory what one `ls` would show. Pick the oracle per § Judge order in the same file.

Then emit this block:

```
### Ambition Rewrite
- Original request: <verbatim>
- Raw inputs to read: <files, data, logs, history, as found in Stage 2>
- Methods and instruments: <specific methods and tools>
- Target: <the operator's target, unchanged, is the bar>; stretch: <a harder number, if any>
  (no target given: proposed: <one checkable target>)
- Outside judge: <exact command, test, query or reviewer per § Judge order> | none available
- Out of scope / follow-ups: <everything that would make the task bigger>
- Cost and side effects: <time, tokens, money, writes, external effects>
```

## Stage 3 — Stop

Execute nothing yet. Ask the operator:

- Interactive session: `AskUserQuestion`, header `Deepen`, 2–3 options, recommendation first, each with reason, cost and consequence: run the rewrite (Recommended) / run the original as asked / narrow the rewrite.
- No `AskUserQuestion` (lead-led session, headless run, tool unavailable): end the turn with the block and wait for the instruction.

## Stage 4 — Execute and judge

Run what the operator chose. Then run the outside judge and paste its output unedited. If it fails, fix the work and rerun, at most three rounds; then report the remaining failure as it stands.

- Never edit the judge (test, query, threshold, rubric) to make it pass.
- No judge exists: the result line is `UNVERIFIED: kein Außenrichter (<what would provide one>)`. Carry it into the session summary section `### Unverified (kein Außenrichter)`.

## Never

- Add deliverables, audiences or systems. Bigger goes to Out of scope / follow-ups.
- Expand a request that carries a ceiling word.
- Speak in a persona voice.
- Dispatch subagents unless the operator agreed to it.

Method after Felix Rieseberg, "How to be more ambitious" (13 October 2026).
