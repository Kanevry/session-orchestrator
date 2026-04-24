# Ask Via Tool (Always-on)

Whenever the coordinator (you — the top-level session agent) needs a user decision, a preference, a routing choice, or confirmation, present it via the **`AskUserQuestion` tool**. Inline markdown-list "choose 1/2/3" questions in chat prose are **not acceptable** in the established session flow — the user reliably misses them because the chat stream is dense and the questions are visually indistinguishable from narration.

## AUQ-001: Use the Tool, Not Prose

- **Every user decision goes through `AskUserQuestion`.** No exceptions for "simple" yes/no or "obvious" three-option picks. The tool renders a structured picker with keyboard navigation; prose questions scroll by invisibly.
- **The tool is a deferred tool** in the Claude Code harness. You must call `ToolSearch` with `"select:AskUserQuestion"` once per session to load its schema before the first call. Do this eagerly — don't skip the question to avoid the schema fetch.
- **If you catch yourself typing "Which option?", "Welche Richtung?", "1)…2)…3)…", or a numbered markdown list of choices followed by a question mark, stop.** Delete the prose, call `AskUserQuestion` instead.

## AUQ-002: Anti-Patterns (Never Do This)

```
✗ "Three options:
   1. Track 1 + Track 2 (Recommended)
   2. Track 1 only
   3. Downgrade to housekeeping
   Welche Richtung?"
```

This is a bug. It compiles cleanly in your head but the user will skim past it. Every time this pattern appears in chat prose, treat it as if you forgot to call a required tool.

Other disallowed forms:
- "Proceed? (y/n)" — use `AskUserQuestion` with two options.
- "Let me know if you want A or B." — use `AskUserQuestion`.
- "I'll do X unless you say otherwise." — if the decision matters, ask; if it doesn't, just do it.

## AUQ-003: Correct Pattern

```
AskUserQuestion({
  questions: [{
    question: "…?",
    header: "…",
    options: [
      { label: "X (Recommended)", description: "Why." },
      { label: "Y", description: "When Y applies." }
    ],
    multiSelect: false
  }]
})
```

Option 1 is always the recommendation, labelled `(Recommended)`. Each option carries a one-line `description` explaining the trade-off. Two to four options per question, one to four questions per call.

## AUQ-004: Exceptions (Narrow)

These are the **only** acceptable uses of inline prose questions:

1. **Subagents.** `AskUserQuestion` is not available inside dispatched `Agent()` calls. Subagents must bubble the decision back to the coordinator, which then asks the user. Never paper over this by putting a prose question in a subagent.
2. **Clarifying a single free-text field** where options don't make sense ("What should the issue title say?"). Even then, prefer offering 2–4 candidate titles via `AskUserQuestion` before falling back to prose.
3. **Error-recovery narration** where the next step is fully determined and you're informing, not asking ("Restored coordinator cwd; continuing Wave 3."). Statements, not questions.

If you think you have a fourth exception, you don't. Use the tool.

## AUQ-005: Why This Is Strict

- The Claude Code chat stream is monospace-dense and scrolls. Prose questions are visually camouflaged by the surrounding narration, especially after long thinking blocks or tool output.
- `AskUserQuestion` renders a distinct, focus-grabbing UI element the user cannot miss and can answer with one keystroke.
- In parallel-session and deep-session flows the user relies on tool-rendered prompts as the synchronization point with the coordinator. A missed prose question stalls the session silently.

Treat this rule with the same weight as PSA-003 (destructive-action safeguards): the default is the tool, and skipping it requires an explicit named exception above.
