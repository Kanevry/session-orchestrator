# Distribution submission kit

Reviewed 2026-09-08 against the published 4.0.1 package and the live directories below. Drafts are ready for an operator to submit; this review did not send outreach or create third-party issues or pull requests. Track follow-through in #824.

## Current opportunities

| Channel | Verified status | Next action |
| --- | --- | --- |
| [Anthropic community marketplace](https://github.com/anthropics/claude-plugins-community/blob/main/.claude-plugin/marketplace.json) | Existing entry pins `fdb27d9261f6f9f24fd221db29cb86e573ec2d4d` (2026-04-07, 2.0.0-alpha.14); homepage also predates the current site. | Highest priority: request a revision and homepage refresh through the [official submission form](https://clau.de/plugin-directory-submission). Its repository does not accept listing PRs. |
| [Awesome Codex CLI](https://github.com/RoggeOhta/awesome-codex-cli) | No Session Orchestrator entry or prior submission found. Contributions accept PRs or issues; existing entries use star badges. | Add the entry below under **Session & Workflow Management**, following the current CONTRIBUTING.md. |
| [Awesome Claude Code #1611](https://github.com/hesreallyhim/awesome-claude-code/issues/1611) | Existing April submission remains open and describes an older pure-Markdown, no-runtime package. | Update the existing recommendation; do not create a duplicate. Its contribution policy requires a human recommendation through the web UI. |
| [Pi package gallery](https://pi.dev/packages/session-orchestrator) | Already lists 4.0.1. | No submission needed. Verify asynchronous indexing after releases. |
| [Claude Marketplaces](https://claudemarketplaces.com/) | No entry found across five sitemaps (30,498 URLs); expected detail URL returns 404. Earlier submission-repository URL is no longer publicly reachable. | Establish the current maintainer-supported submission route before sending anything. |
| [skills.sh](https://skills.sh/) | The expected package page returned 404. | Assess skill-only installation separately: a skill listing does not install the complete plugin runtime or hook adapters. |

Directory status is time-sensitive. Recheck immediately before submission. This kit does not imply acceptance or improved search ranking.

## Shared description

- **Name:** Session Orchestrator
- **Website:** https://session-orchestrator.com/
- **Repository:** https://github.com/Kanevry/session-orchestrator
- **Package:** https://www.npmjs.com/package/session-orchestrator
- **License:** MIT

Session Orchestrator structures AI coding work into repository discovery, planning, parallel execution waves, verification and a recorded handover. It supports Claude Code, Codex CLI, Cursor IDE and Pi. Enforcement depends on the harness: Claude Code has the complete hook integration; Cursor and Pi bridge supported events; Codex currently has no file-scope enforcement adapter. Node.js 24 or newer is required.

Avoid version-dependent counts in directory descriptions. Use the live website and README for the current inventory and installation instructions.

## Anthropic listing refresh draft

**Subject:** Refresh the existing Session Orchestrator community listing

The existing Session Orchestrator entry points to an April 2026 alpha revision. Please refresh it to the latest stable release at https://github.com/Kanevry/session-orchestrator/releases and update the homepage to https://session-orchestrator.com/.

The package now documents Node.js 24 prerequisites, installation and removal, telemetry controls, and the different hook capabilities of each supported harness. Its purpose remains repository discovery, planning, execution in parallel waves and verification before handover.

At submission time, include the exact latest release tag and commit SHA; do not copy a moving branch as an immutable revision.

## Awesome Codex CLI entry and PR draft

```markdown
- [Session Orchestrator](https://github.com/Kanevry/session-orchestrator) ![GitHub stars](https://img.shields.io/github/stars/Kanevry/session-orchestrator?style=flat) — Repository discovery, planning, parallel execution waves and verification for Codex CLI, Claude Code, Cursor and Pi, with persistent session handovers.
```

**PR title:** Add Session Orchestrator to Session & Workflow Management

Session Orchestrator provides generated Codex command skills for a repository workflow from discovery and planning through parallel work, verification and handover. The README includes Codex installation and refresh instructions, Node.js prerequisites and a platform capability matrix. The project is MIT-licensed and also supports Claude Code, Cursor and Pi.

The proposed entry belongs in Session & Workflow Management. Codex file-scope enforcement is currently unavailable and the project documents that limitation explicitly.

## Existing Awesome Claude Code issue update draft

Update to this recommendation: Session Orchestrator now ships a Node.js runtime and per-harness adapters, so the original “pure Markdown” and “no runtime dependency” description is outdated. The current installation requires Node.js 24 or newer. The project supports Claude Code, Codex CLI, Cursor and Pi; hook enforcement varies by platform.

Current links: https://session-orchestrator.com/ and https://github.com/Kanevry/session-orchestrator. The README covers installation, first session, upgrade, uninstall and data controls. Please assess the current release and documentation when reviewing the existing recommendation.

## Search and AI discoverability

The site already provides crawlable HTML, canonical and language links, a sitemap, visible FAQs with matching structured data and source links. Keep those surfaces accurate and synchronized with shipped capabilities. Google's [AI features guidance](https://developers.google.com/search/docs/appearance/ai-features) says that no special AI text file or additional schema is required for its AI search features. The maintained `llms.txt` files are a convenience for readers, not evidence of ranking or inclusion.

Measure indexing and referral traffic before claiming a discovery improvement. Search Console access, impressions and conversions were not available in this review.
