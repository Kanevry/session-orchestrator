---
tier: always
review-date: 2026-10-23
---

# Ask Via Tool (Always-on)

A user decision has three legitimate forms. Pick the form first — asking is one of them, not the default.

**Write for someone who knows this project but has not seen what you just saw.** What he needs to decide stands in the text, not in the file it points at — in the AUQ payload and in every finding you post.

## AUQ-001: Route Before You Ask

Choose exactly one, in this order:

1. **Operator verb — preferred.** Name the finding, name the verb (`/go`, `/close`, `/details`), stop. Use it whenever nothing blocks while you wait; the operator acts when he picks. An AUQ here only costs an interrupt — 40% of interrupted tasks are never resumed (Parnin & Rugaber 2011), and a thoughtless prompt trains reflex confirmation (93% of Claude Code permission prompts are accepted unread).
2. **Derive and report.** The answer is in Session Config, STATE.md, git, or the filesystem. Read it, act, report in one line: `vcs: gitlab → using glab`. Never ask what you can read.
3. **AUQ.** Only when the session cannot proceed without the answer AND it is not derivable. Then it is the tool, never a prose list.

## AUQ-002: Decidability Gate

Before any AUQ: can the operator decide from what already stands in the chat, without opening a file? If not — lift the missing facts into the option descriptions, or do not ask.

## AUQ-003: Options Carry Reason, Cost, Consequence

```
AskUserQuestion({ questions: [{
  question: "…?", header: "…",
  options: [
    { label: "X (Recommended)", description: "Why + cost + what it commits to." },
    { label: "Y", description: "When Y applies + its cost." }
  ], multiSelect: false }]})
```

Weigh every realistic option, not just two: 2–4 options, 1–4 questions per call. Option 1 is the recommendation, labelled `(Recommended)`. Each description gives reason, cost and consequence; one that only restates its label is a rule break. One plain-words (eli5) sentence in the question or a description carries the core and drops no fact (AUQ-006).

- ✓ "Blocker for W3; ~20 min; freezes plan scope until it lands."
- ✗ "Fix the bug now."

Same standard as `skills/grill/SKILL.md` § AUQ format rules. Deferred tool: call `ToolSearch` with `select:AskUserQuestion` once per session before the first call.

## AUQ-004: Exceptions (Narrow, Exhaustive)

1. **Subagents.** `AskUserQuestion` does not exist inside dispatched `Agent()` calls. Bubble the decision to the coordinator; never put a prose question in a subagent.
2. **Harness without the tool (Codex CLI / Cursor IDE).** Render the same options as a numbered Markdown list, `(Recommended)` on option 1, reply-by-number (per `skills/session-start/presentation-format.md`). Not a licence to skip the tool where it exists.
3. **Single free-text field** ("What should the issue title say?") — still prefer 2–4 candidate titles via the tool first.
4. **Narration**, where the next step is determined and you are informing, not asking. Statements, not questions.

## AUQ-005: Anti-Patterns

- A numbered choice list in prose ending in "Welche Richtung?" — the operator skims past it; treat it as a forgotten tool call.
- "Proceed? (y/n)" / "Let me know if you want A or B" — either an operator verb (AUQ-001.1) or the tool.
- An AUQ whose answer sits in Session Config, STATE.md, or the filesystem (AUQ-001.2).
- An AUQ that blocks nothing — the operator was going to type `/go` anyway (AUQ-001.1).
- Options the operator can only judge by reading the code they describe (AUQ-002).

## AUQ-006: Plain Words, Real Things

Say plainly what happens; invent nothing. **Test:** delete every noun the system lacks — survives, no analogy; collapses, say what happens (not "like a level crossing"). Simplifying drops words, never facts: anything greppable stays, and `skills/session-start/soul.md` § "Never traded for brevity" wins.

Keep `header` at **12 codepoints** where the language allows — the tool's stated budget, a target, not a wall: no `.max(12)`, no truncating render path (bundle 2.1.268); 125 longer headers were accepted and answered (measured 2026-09-11), and 30 of 72 template questions exceed 12. A German compound at 13 or 14 ships; an abbreviation nobody reads does not. `scripts/auq-audit.mjs` holds templates to 12, where shortening costs nothing. Give an option a `preview` when the options differ in something literal — a diff, a title, a config block, a file list: if the answer puts that text somewhere, he sees it first.
