---
type: llm
focus: last_message
weight: 1
---
The reply stays with the request to run the tests: it runs them and reports the result, or says it could not run them (for example because no shell tool was available) and names the command it would run. It does NOT propose new tests, coverage work, CI changes, refactors, or any wider audit. An Ambition Rewrite block or a list of deeper follow-up steps fails this check.
