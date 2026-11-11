# Lead-guided mode — answering your own questions (#1976)

Shared contract for skills whose interactive form asks the operator (grill, ux-grill, deepen,
test-audit, discovery). It is a reference, **not a rule**: nothing under `.claude/rules/**` loads
it, so it costs no always-on directive budget. Each skill carries a short `## Lead-guided runs`
section that points here and states its skill-specific behaviour. Skills exported into the
skills-only package (grill, deepen) inline their part instead, because the package carries no
file outside the skill directory.

Interactive behaviour does not change: where a person answers, the question tool (or, without
one, the numbered list of `.claude/rules/ask-via-tool.md` AUQ-004 exception 2) stays the route.
That exception is for an interactive harness without the tool, where a person still replies.
Lead-guided means **nobody replies**, so a lead-guided run never ends its turn waiting for an answer.

## Detection — any one signal suffices

1. The system prompt carries a section headed `Steuerung dieser Session: Lead-geführt` (injected
   by a fleet coordinator's owner inbox; vocabulary in `skills/_shared/fleet-protocol.md`).
2. An `AskUserQuestion` call was refused with a message saying the session is lead-guided.
3. The run is headless or non-interactive (`claude -p`, `codex exec`, a scheduled job): no
   question tool exists and nobody reads a numbered list.
4. The task brief says so (lead-guided, autonomous, headless, "entscheide selbst").

No signal: the skill runs interactively, unchanged. A dispatched subagent is a separate case;
each skill states what it does there.

## The three duties

1. **Take your own recommendation.** At every question site, choose the option the skill would
   have marked `(Recommended)`, after doing the same grounding work (read the code, run the
   cheap read-only command). Never pick an option you would not have recommended.
2. **Park owner-class questions and continue.** When the question belongs to an owner class
   (below), do not decide it. If the steering section names an owner-queue CLI, add the question
   there with the class it names (for example `owner-queue add ... --class <klasse>`, in the exact
   form the steering section gives); otherwise record it as an open owner question in the issue
   or report. Never invent a CLI path. Then continue at the next point that does not depend on
   the answer; what does depend on it is skipped and named.
3. **Record every decision as one line**, in the issue the run works on or in the run's report,
   so the owner can review and correct them in bulk:

   ```
   Entscheidung (autonom, Lead-geführt): <question> → <chosen>; verworfen: <rejected options>; Grund: <one sentence, with the evidence>
   ```

   Parked questions use the same shape with `→ geparkt (<class>)`. The run's final output lists
   all lines together under `### Autonome Entscheidungen`. When the run works on an issue, the
   decision also goes into that issue as a comment ending with the steering rule's marker
   `autonom entschieden (Steuerung: autonomous)`, so a bulk search finds both forms.

## Owner classes — never decided autonomously

- **External effect**: posting, mail, messages, publishing, deploying, merging, pushing to a
  default or protected branch, anything a third party sees — including issues or comments on a
  public tracker. Pushing a work branch and opening a draft MR on the project's own tracker is
  ordinary work, not an external effect (the steering rule pushes via its own push command).
- **Money**: purchases, paid services, quota or plan changes.
- **Accounts**: creating, changing or deleting accounts, memberships and access rights.
- **Deletion**: removing data, files, branches or tests the run did not create, or skipping a
  suite. A deletion the skill only prepares for review (a ledger mark, an edit, a commit on a
  draft MR's branch) is not one; landing it on a shared branch is.
- **Security**: secrets, permissions, credentials, weakening a security control or a guard.
- **Critical product decision**: pricing, legal or compliance, public positioning, a breaking
  change to a public API or contract, dropping a feature.

## Ending a lead-guided run

The last output is the result plus `### Autonome Entscheidungen` and, when any, the parked owner
questions. It is a report, never a question to the reader and never "waiting for the
instruction". Write parked and open points as statements, one per line, in the form
`Offen: <topic> — <what is missing>, <who decides>`, never as a sentence ending in a question
mark: a coordinator that reads the tail of the reply takes a trailing question for a session that
waits (measured 2026-11-08: a lead-guided `/ux-grill` probe ended its report with two `Soll …?`
lines). If the run cannot continue at all (no target, every remaining step depends on a
parked question), it says so and ends; a fleet session then follows the report-back duty in
`skills/_shared/fleet-protocol.md` § Rücklauf an den Navigator.
