---
name: grill
description: Use when the user wants a plan, design, or PRD stress-tested before any build — relentlessly interrogates one decision at a time, grounds every question in the codebase, hunts contradictions against the domain language and the code, and challenges the load-bearing assumptions. Triggered by "grill me", "stress-test this plan", "poke holes in my design". Composable — run standalone or as an adversarial pass before /plan feature.
user-invocable: true
argument-hint: "[file-path-or-topic]"
model: inherit
color: red
tools: Read, Grep, Glob, Bash, Write
---

# Grill Skill

> Adversarial pressure-test for a plan, design, or PRD the user already believes in. The complement to `/brainstorm`: brainstorm *narrows* an ambiguous design space cooperatively; grill *attacks* a settled-feeling plan to find what's wrong before it's built. Optionally writes `docs/specs/YYYY-MM-DD-<slug>-grill.md`. No HARD-GATE — composable by design.

## Invocation

Invoked as `/grill [file-path-or-topic]` with arguments: **$ARGUMENTS** (resolved in Phase 0).

The argument is optional and is either a file path to grill (a PRD, spec, `STATE.md`) or a topic/slug. If absent, grill the plan already present in the current conversation; if there is none, ask the user — via the question route of Phase 2, step 3 — to state it first.

- `/grill` — grills the plan in the current conversation context.
- `/grill docs/prd/2026-06-09-export.md` — grills a specific PRD file. <!-- path-check: example -->
- `/grill "partial order cancellation"` — grills the named idea, slug pre-set.

| Situation | Use |
|-----------|-----|
| A settled-feeling plan needs stress-testing before build | `/grill` |
| The design is still ambiguous and needs narrowing | `/brainstorm` |
| Scope is clear, need a formal PRD + issues | `/plan feature` |
| Adversarial pass before formalizing | `/grill` → `/plan feature` |

`/brainstorm`, `/plan feature`, `/write-executable-plan` and `/debug` are sibling skills of the full session-orchestrator plugin. Where they are not installed, every pointer to them in this file stays advice in plain words — narrow the design first, formalize the decisions, investigate the bug — and the grill itself depends on none of them.

## Soul Reference

Read `soul.md` in this skill directory before anything else. It defines WHO you are — the Interrogator, a staff engineer playing devil's advocate. The Six Tactics in soul.md (glossary conflict, sharpen fuzzy language, code contradiction, edge-case scenario, assumption audit, pre-mortem) are the substance of every grill; internalize them before Phase 0.

## When to use

- A plan, design, PRD, or `STATE.md` wave plan exists and the user wants it stress-tested before committing
- The user says "grill me", "poke holes in this", "stress-test this plan", "what am I missing?"
- A decision *feels* settled but rests on unverified assumptions about the codebase, appetite, or domain
- An adversarial pass is wanted between `/brainstorm` (or `/plan feature`) and implementation

## When NOT to use

- The design is still *ambiguous* rather than untested → use `/brainstorm` to narrow it first; there's nothing to grill yet
- The user wants a formal PRD + issues, not a challenge → use `/plan feature`
- Pure bug investigation → use `/debug`
- The user wants you to generate options → that's `/brainstorm`; grill attacks the option the user brought, it doesn't invent new ones

## Phase 0: Target Acquisition

Establish *what* you are grilling and ground yourself in the *code* before asking the user anything.

1. **Resolve the target.** Parse `$ARGUMENTS`:
   - A file path (e.g. `docs/prd/2026-06-09-export.md`, `STATE.md`, a spec) → read it in full. <!-- path-check: example -->
   - A topic/slug or empty → grill the plan or idea already present in the current conversation. If there is no plan in context, ask the user — via the question route of Phase 2, step 3 — to state the plan in one or two sentences before continuing.
2. **Ground in the codebase.** Read the project's domain language if present (`CONTEXT.md`, `.orchestrator/steering/*.md`, relevant `docs/adr/*`), then Grep/Glob the areas the plan touches. Build a short mental model of what the code *actually* does today. This is what lets you run the code-contradiction tactic.
3. **State the target back.** In 1–2 plain-text sentences, summarize what you understand the plan to be and what you've grounded it against. This catches a wrong target before you waste a grill on it.

Do NOT write code, scaffold, or commit in this phase or any phase. The only write a grill ever performs is the optional summary in Phase 4.

## Phase 1: Map the Decision Tree

Before interrogating, lay out the branches. Identify the decisions the plan depends on, ordered root-to-leaf (resolve foundational decisions before the ones that hang off them). Surface this map to the user in plain text as a short ordered list — it sets the agenda and lets the user re-order or add a branch you missed.

A branch belongs on the map when its resolution would change what gets built. Skip decisions the codebase already settles — note them as "already answered by the code: …" instead of asking.

**Coverage check before Phase 2.** The map must cover all four dimensions of a viable plan before you move on:
- [ ] Value — a branch tests whether this solves a real problem
- [ ] Usability — a branch tests whether the intended user can actually use it
- [ ] Viability — a branch tests business/appetite/cost fit
- [ ] Feasibility — a branch tests technical buildability

A missing dimension isn't a gap to silently fill — it's the first question of the grill.

## Phase 2: The Grill Loop

Walk the decision tree **one question at a time**. For each branch, in order:

1. **Try the code first.** If the question is answerable by reading the repo, read it and resolve the branch yourself — report the finding, don't ask.
2. **Apply a tactic.** Frame the question through whichever of the Six Tactics fits: a glossary conflict, a fuzzy term to sharpen, a code contradiction you found in Phase 0, an edge-case scenario, an assumption to audit, or a pre-mortem cause to sort into tiger/paper tiger/elephant.
3. **Ask one question.** Pose the challenge as a single question with your recommended resolution first. Two routes carry the same question, in this order:
   - **Question tool available** (Claude Code: `AskUserQuestion`): one call, as in the first example below. This route always comes first where the tool exists.
   - **No question tool** (Codex CLI, Cursor, ChatGPT, or any harness where none is available): render the same single question as a numbered Markdown list, as in the second example. Option 1 is the recommendation, labelled `(Recommended)`; every option states its reason, cost and consequence; the last option is `Other / describe below`. Ask for the reply by number (or, for `Other`, in the user's own words), then end the turn and wait for the answer. Never add a second question to the same turn.
   - **Nobody answers** (lead-guided or headless run): neither route; the session answers its own question as described in § Lead-guided runs: Selbst-Grill (after this phase).

```
AskUserQuestion({
  questions: [{
    question: "Your code cancels whole Orders, but the PRD says a customer can cancel one line item. Which is the real model?",
    header: "Cancel scope",
    options: [
      { label: "Line-item cancellation (Recommended)", description: "Matches the PRD intent. Cost: new partial-refund path + Order stays open after one item is voided." },
      { label: "Whole-order only", description: "Matches today's code. Cost: contradicts the stated user story — re-scope the PRD." },
      { label: "Both, behind a flag", description: "Defers the decision. Cost: two code paths to test and maintain." },
      { label: "Other / describe below", description: "Resolve it a different way — describe how." }
    ],
    multiSelect: false
  }]
})
```

The same question without a question tool:

```
Your code cancels whole Orders, but the PRD says a customer can cancel one line item. Which is the real model?

1. **Line-item cancellation (Recommended)** — Matches the PRD intent. Cost: new partial-refund path + Order stays open after one item is voided.
2. **Whole-order only** — Matches today's code. Cost: contradicts the stated user story — re-scope the PRD.
3. **Both, behind a flag** — Defers the decision. Cost: two code paths to test and maintain.
4. **Other / describe below** — Resolve it a different way — describe how.

Reply with a number.
```

> **Grill runs in the thread that talks to the user.** Every grill question needs the user's answer — through the question tool where the harness has one, as a numbered list where it does not. A dispatched subagent has neither route: it cannot reach the user (in Claude Code, `AskUserQuestion` does not exist inside a dispatched agent), so a subagent must not grill — its questions bubble to the thread that talks to the user. A lead-guided or headless run with nobody to answer does not ask either: it runs the Selbst-Grill below, which answers its own questions from the code and says that it is weaker than a grill with the owner. (So an "autonomous grill" exists only in that weaker, labelled form — a useful thing to surface if a plan under grill proposes one as a full substitute.)

**Question format rules (every question, both routes):**
- One question per turn. Option 1 is ALWAYS `(Recommended)`, with one sentence of reasoning stated in plain text *before* the question.
- Each option names a concrete cost or consequence — not just the choice, but what it commits you to.
- Always include `Other / describe below` so the user can resolve a challenge in a way you didn't anticipate.
- Single choice (`multiSelect: false` in the tool) unless the branch genuinely admits multiple simultaneous answers; in the numbered list, say so explicitly ("reply with one or more numbers").
- Decidable from the question alone: the facts the user needs stand in the question and its options, not in a file he would have to open first.

4. **Record and descend.** After each answer, append to the running summary (below) and let the resolved answer pick the next branch. If an answer contradicts an earlier one, surface the collision immediately and re-resolve before continuing.

Maintain a running summary, surfaced in plain text between questions:

```
## Resolved So Far
- Cancellation scope: line-item (was: whole-order in code → PRD wins, code needs a partial-refund path)
- Idempotency: caller-supplied key, rejected duplicates
- ...
## Still Open
- Rollback path under partial-ship race
```

**Termination.** Stop when every branch on the map is resolved, when the user calls it (e.g. "good enough"), or when remaining branches are genuine unknowns that need runtime data rather than a decision. Fewer, sharper questions beat exhaustive ones — the grill serves the plan, not thoroughness for its own sake.

## Lead-guided runs: Selbst-Grill

A run is lead-guided when any one of these holds: the system prompt carries a section headed `Steuerung dieser Session: Lead-geführt`; a question-tool call was refused because the session is lead-guided; the run is headless (`claude -p`, `codex exec`, a scheduled job); or the task brief says the session decides on its own. Then nobody answers, so the grill becomes a **Selbst-Grill** — never a turn that ends waiting:

1. **Same phases, own answers.** Phases 0–2 run unchanged up to the point of asking. At each question, take the option you would have marked `(Recommended)` only when the code, a document in the repo, or a stated domain fact backs it; cite that evidence. A question you cannot back that way is not answered: it goes to **Open questions** in Phase 3, phrased for the owner.
2. **Owner-class questions are never self-answered**, however well backed: external effect (publishing, sending, deploying, merging), money, accounts, deletion of something the run did not create, security (access rights, keys, weakening a control), a critical product decision (pricing, legal, public contract, dropping a feature). If the steering section names an owner-queue command, add the question there in exactly that form; otherwise list it under **Open questions** as an owner question. Never invent a command. Then continue with the branches that do not depend on it.
3. **One line per decision**, in the running summary and later in the recap:
   `Entscheidung (autonom, Lead-geführt): <question> → <chosen>; verworfen: <rejected options>; Grund: <evidence>`
4. **No target** (Phase 0 would ask the user to state the plan): say so in one line and end with that report; do not wait.
5. **Hand-off**: deliberately narrow the recommended Phase 4 option (summary plus planning) to the summary file alone, and record that narrowing as its own decision line; the file carries `Status: Selbst-Grill — decisions answered by the session, not by the owner` in its header line; start a planning step only when the brief asks for it, otherwise name it as the next step.
6. **The result says what it is.** The recap opens with `Selbst-Grill (Lead-geführt): weaker than a grill with the owner; every resolution below is the session's own, backed by the cited evidence`, lists every decision line under `### Autonome Entscheidungen`, and ends as a report, never a question.

## Phase 3: Resolved-Decisions Recap

Present a final plain-text recap before any hand-off:

- **Resolved decisions** — each branch and how it was settled.
- **Contradictions surfaced** — every collision the grill found (glossary, code, or internal), and its resolution. This is the grill's primary output; make it visible.
- **Open questions** — genuine unknowns that couldn't be settled here.
- **Assumptions audited** — load-bearing assumptions you challenged and where they landed (held / revised / flagged risky).

## Phase 4: Hand-off

Per the user's configured behaviour, the grill ends with a hand-off and an OPTIONAL summary file — never a forced artifact. Ask through the same question route as Phase 2, step 3 (tool first, numbered list without one). Where `/plan feature` is not installed, offer only the summary and the plain finish:

```
AskUserQuestion({
  questions: [{
    question: "Grill complete. How do you want to proceed?",
    header: "Hand-off",
    options: [
      { label: "Summary + /plan feature (Recommended)", description: "Writes the resolved decisions to docs/specs/ (a folder of markdown notes), then hands them to planning. Cost: one file." },
      { label: "Write grill summary only", description: "Same file, no planning step. The decisions keep, so you can hand them off later." },
      { label: "Hand off to /plan feature — no file", description: "Carries the decisions straight into planning. They then live only in this conversation." },
      { label: "Done — no file, no hand-off", description: "The grilling itself was the value. Nothing is written, nothing is handed on." }
    ],
    multiSelect: false
  }]
})
```

**If a summary is requested** (options 1 or 2), generate today's date via `date +%Y-%m-%d`, derive `<slug>` from the target (lowercase, hyphens), `mkdir -p docs/specs`, and write `docs/specs/YYYY-MM-DD-<slug>-grill.md`:

```markdown
# [Target Name] — Grill Summary

> Generated by /grill on YYYY-MM-DD. Status: decisions resolved, not yet planned.

## Target
[What was grilled — file path, PRD, or one-line plan description, and what it was grounded against.]

## Resolved Decisions
| Decision | Resolution | Rationale |
|----------|-----------|-----------|
| [Branch] | [How it was settled] | [Why — including any code/glossary evidence] |

## Contradictions Surfaced
- [Collision found] → [how it was resolved]
(If none: "No contradictions surfaced — the plan held under interrogation.")

## Assumptions Audited
- [Assumption] → held / revised / flagged risky — [note]

## Open Questions
- [Genuine unknown needing more info or runtime data]
(If none: "No open questions — every branch was resolved.")

## Out of Scope
- [Anything the grill explicitly pushed out of this plan]
```

Do NOT leave any section with "TBD", "TODO", or placeholder text. Genuine unknowns go in Open Questions.

**If handing off** (options 1 or 3), confirm the hand-off in plain text:

> "Decisions resolved. Run `/plan feature` — reference `docs/specs/YYYY-MM-DD-<slug>-grill.md` as the input brief." (omit the path reference for option 3)

## Anti-Patterns

- **Asking what the code can answer** — every question the repo could settle is a Phase 0 failure; Grep first, ask only what the code can't tell you
- **Batching questions** — a multi-question volley defeats the one-branch-at-a-time discipline and produces shallow answers
- **Neutral options** — every question, tool call or numbered list, must mark exactly one option `(Recommended)`; non-commitment undermines the grill
- **Silently skipping the question** — no question tool is never a reason to answer a branch yourself; fall back to the numbered list and wait. Only a run nobody answers answers its own questions, and only openly, as the Selbst-Grill above
- **Grilling an ambiguous design** — if there's no settled plan to attack, stop and recommend `/brainstorm`; you stress designs, you don't invent them
- **Swallowing a contradiction** — when an answer collides with the code or an earlier answer, surfacing it is the whole job; never let it slide to keep the conversation smooth
- **Forcing an artifact** — the summary file is opt-in per Phase 4; a grill that resolved everything in-conversation and the user says "done" leaves no file
- **Writing code or committing** — a grill resolves decisions; it never implements them

## See Also

Sibling skills of the full session-orchestrator plugin, when installed:

- `/brainstorm` — cooperative design narrowing; the sibling you recommend when the design is still ambiguous
- `/plan feature` — primary hand-off target; formalizes resolved decisions into a PRD + issues
- `/write-executable-plan` — alternative hand-off for direct execution

The posture grill embodies, stated here so it needs no other file: treat every claim — the plan's, the user's, your own first reading — as unverified until the code or the user's answer confirms it; verify before you accept, and never adopt a claim because it sounds plausible.
