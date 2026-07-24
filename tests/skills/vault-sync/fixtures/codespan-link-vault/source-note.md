---
id: codespan-source
type: note
created: 2026-07-24
updated: 2026-07-24
---

# Code-span wikilink handling (#852)

Inline code span containing a wikilink that must NOT be treated as a real
link (pedagogical prose about Obsidian conventions — #159 pattern): `[[no-such-target]]`

Fenced code block containing a wikilink that must NOT be treated as a real
link:

```
See [[also-no-such-target]] for the Obsidian wiki-link convention.
```

Falsifiable control: a link on the SAME line as an inline code span, whose
target intentionally does NOT exist — proves the link after the span is
actually extracted (not silently swallowed as part of the span) by producing
a real, checkable dangling warning rather than an ambiguous absence of one —
`some inline code` and also [[control-target]].

Negative twin: a genuinely dangling link OUTSIDE any code span must still be
reported: [[still-dangling]].
