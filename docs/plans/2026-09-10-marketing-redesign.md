# Marketing redesign and launch review

Date: 2026-09-10. Status: implementation in progress.

## Intended result

Make each product understandable, recognisable and credible before increasing distribution. Session Orchestrator needs a clearer developer identity and a visible Plan / Go / Close workflow. TetherCam needs a shorter route to its two downloads. WalkAITalkie needs meaningful product evidence and accurate distinctions between its distribution channels.

Success means a visitor can explain what the product does, find the correct next action, and understand its relevant limitations. Counts of graphics, keywords, agents or completed waves are not success criteria.

## Design contract

Session Orchestrator: neutral graphite `#101113`, warm white `#F5F3EE`, secondary text `#BBC0C5`, acid-lime `#D5F478` as one deliberate action colour. Space Grotesk display, a readable sans-serif body and mono only for commands. Large editorial type, disciplined spacing, one original robotics illustration, a concrete session example. Avoid brown-on-brown, generic glowing blobs, a card around every sentence, decorative gates, and pretending all jobs always need five waves.

WalkAITalkie: the same typographic discipline, neutral graphite and warm white, controlled coral/copper `#FF7957`. Keep its existing icon and use the existing marketing Pencil document. Hero: “Say what you mean. Keep your voice.” / “Sprich deinen Gedanken. Schreib in deinem Stil.” Preserve uncertainty and meaning in every before/after example. Explain local mode and optional cloud mode where they affect a choice.

TetherCam: retain its existing identity and existing Pencil document. Give the product connection and two-step Mac/iPhone installation more space than supporting copy. Show real product evidence; label transport ping separately from end-to-end latency.

One authoritative Pencil document per product. Update current frames in place. Additional responsive and campaign frames belong in that same document. Generated artwork is illustration, never evidence of a working app. Public asset references must live in the consuming repository.

## Voice and claim contract

Direct, useful and personal. First-person singular for the maker's story. No corporate “we”, artificial urgency, unsupported superlatives or invented adoption statistics. No em dashes. Explain a real use case before an architectural term. Use German du consistently.

The maker describes a Notion prompt library with roughly 20–30 rows, copied between projects, which developed into Plan / Go / Close. This is his account of the prehistory. The repository's first visible commit is in April 2026; do not turn that into a claim that this public plugin has existed for two years. Plan a separate personal blog article around the progression and practical lessons.

Use the existing donation destination from TetherCam, `https://paypal.me/Kanevry`, as a quiet footer/repository support link. No modal or repeated request.

## Five waves

| Wave | Work | Owner | Acceptance |
|---|---|---|---|
| 1 Discovery | Three independent product/launch audits; live visuals, source and release checks, current community rules | TetherCam, WalkAITalkie, research agents; coordinator on Orchestrator | Findings have sources and distinguish live, local and planned |
| 2 Core | Pencil design, typography, hero/copy, meaningful demonstrations and factual SEO repairs | One writer per product; coordinator owns Pencil and generated artwork | Existing design documents updated; working local implementations |
| 3 Polish | Mobile, accessibility, actual download paths, metadata, social assets and copy consistency | Product writers, scoped independently | Correct CTAs, no overflow, readable contrast, working locale routes |
| 4 Quality | Independent cross-review and Humanize checks; automated checks appropriate to each changed site | Reviewers who did not author the target; coordinator verifies visuals | Findings fixed and rechecked; claims match shipped evidence |
| 5 Finalization | Reviewable previews, launch drafts/account preparation, concrete follow-up issues and final audit | Coordinator | Exact shipped/prepared/pending status with links and no speculative success claims |

Native runtime capacity: three child agents plus coordinator. Preserve selected models and reasoning. Repository/asset ownership separates concurrent writes. The Orchestrator implementation lives in an isolated worktree because the original checkout has a foreign session lock. Other repositories keep existing user changes intact.

## Release boundaries

Public posting and launch scheduling require a ready product and current channel eligibility. Product Hunt account preparation is authorised; inspect existing launch history before selecting a launch date. Community drafts are not posts. A rejected/filtered Reddit post is not successful distribution. Do not resubmit to bypass moderation or use a second product to evade a per-developer limit.

WalkAITalkie's private GitHub repository must stay private. Its currently shipped Direct binary and Store binary need separate release evidence; a green build of newer source does not prove either distribution has shipped it. Pricing and Store products are not changed by this marketing work.

## Verification

- Desktop and mobile visual checks, including a narrow 320px layout.
- Hero communicates audience, job and next action without reading the entire page.
- Before/after examples preserve facts, uncertainty and speaker intent.
- Visible copy, JSON-LD, social cards, llms.txt and README agree about supported modes/channels.
- Humanize: lexical scan actually applied to extracted prose, then semantic voice review. The existing speaker-kit CLI skips website paths, so its exit code alone is not evidence.
- Product builds/lint/targeted tests, broken-link and asset checks, then independent review.
- Current CI status recorded separately from local test results.

## Follow-up candidates

1. Measured, privacy-conscious acquisition and activation attribution, with clear metric definitions.
2. WalkAITalkie Direct binary release validation and Store/channel convergence before a broad launch.
3. Search-index refresh after metadata corrections; observe snippets after recrawl.
4. Personal blog: “Von 30 Notion-Prompts zu Plan, Go, Close”.
5. Scheduled community/launch work based on eligibility and readiness, not a fixed posting quota.

## Current evidence and review

The detailed internal audit, channel receipts and validation evidence are maintained in the session's marketing review directory. Public documentation intentionally excludes private host, account, traffic and customer data.
