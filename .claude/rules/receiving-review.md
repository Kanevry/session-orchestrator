---
tier: always
review-date: 2026-10-23
---

# Receiving Code Review (Always-on)

## RCR-001: The 6-Step Pattern
Every item, in order, no skipping: READ in full including nested details; UNDERSTAND by precise restatement (if unable, reread cited code); VERIFY current code/file/line; EVALUATE improvement/preference/misunderstanding, project rules and CLAUDE.md/AGENTS.md break ties; RESPOND per item accept/modify/push back with rationale (never silent acceptance); IMPLEMENT one item at a time, running verification after each per verification-before-completion.md.

## RCR-002: Forbidden Phrases
Never answer review with "You're absolutely right!", "Great point!", "Excellent feedback!", "Let me implement that now" before verification/evaluation, or "Thanks for catching that!"/"Thanks for [anything]" as analysis before confirming a catch. Replace with restatement, verification reference and decision.

## RCR-003: Source-Specific Handling
Human operator: trust AFTER understanding, restate/verify then implement. Session/persona reviewers (architect/qa-strategist/analyst): skeptical, verify current code before acceptance. Security reviewer: take seriously, verify scope (false negatives cost more). Inter-wave Quality-Lite: mechanical typecheck/lint failures are facts, fix them. External PR reviews: skeptical, push back if wrong. Default skeptical unless explicitly overridden.

## RCR-004: YAGNI Check (Especially for "Implement Properly")
For requests to implement properly/add validation/configurability: grep production usage (`git grep <function-name>`) and history (`git log -p -- <file>`); inspect whether caller passes triggering inputs. Unused: suggest REMOVAL. Used but impossible at callsite: push back with callsite analysis.

## RCR-005: Implementation Order
Clarify interdependent items FIRST: ask before partial implementation. Then blocking errors stopping wave, then independent simple items (batch), then complex items needing design discussion (AUQ first). Verify after each step.

## RCR-006: Push-Back Posture
Push back when wrong; cite codebase, project convention or concrete trade-off (surface without prevented failure), never preference alone.

## RCR-007: Four-Class Finding Triage
Classify EVERY finding into EXACTLY ONE class BEFORE patching:
- in-scope-blocker: introduced by this diff, same owner boundary, fixable without task contract change; fix this cycle.
- same-pattern-sweep: identical defect recurring only inside own file scope, no contract change; fix EVERY site this cycle.
- follow-up: real adjacent bug class/sibling surface; route via disposition table in `skills/session-end/SKILL.md`.
- stop-and-escalate: correct fix breaks frozen scope; NEVER patch however small; escalate.
Sweep needs ALL FOUR: identical pattern with one edit shape (not related bug class); every site inside scope; no contract-changing site (that site becomes stop-and-escalate and ENDS sweep); population ENUMERATED in quoted census of CALL SITES, not files or payload-key grep missing channel-only consumers (PSA-006). If not enumerable: suspicion, not sweep. Otherwise missing condition means follow-up; out-of-scope sites go follow-up with census.
Stop-and-escalate triggers EXACTLY FIVE: new protocol; new config surface; storage change; public-API contract; different owner boundary OR release-process change. Frozen-scope exceptions EXACTLY FIVE: active data loss; crash; broken install/upgrade; release blocker; concrete security exposure. Before escalating name the applicable trigger, show no in-scope-blocker subset resolves it without crossing boundary, and hand BOTH to operator. Escalation IS action, never workaround commit.

## RCR-008: Two-Cycle Reclassify
After TWO fix cycles without STRICT decrease in blockers: pause and reclassify EVERY remaining finding. Third cycle only if EVERY finding still in-scope-blocker; otherwise advance smallest safely-landable subset and route rest follow-up. No stacked or pushed fix commits while classification/focused proof open; edits stay local until proven in-scope.

## RCR-009: Depth, and the Reviewer's Authority
Report examined SOUND surfaces and suspicions MEASURED AWAY, not findings alone; confirmation alone is no review. Reviewer MAY REFUSE a measurably REFUTED instruction with measurement, never preference. Self-review required before handoff, never substitute for independent review; green gates also no substitute. Shape: `agents/session-reviewer.md` § Depth and Escalation Authority. Scoped mechanics: `review-mechanics.md`.

## See Also

development.md · testing.md · cli-design.md · ask-via-tool.md · parallel-sessions.md · verification-before-completion.md · quality-gates-autofix.md
