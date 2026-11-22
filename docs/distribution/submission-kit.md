# Distribution submission kit

Reviewed 2026-11-21 against the published 5.20.0 package (GitHub tag `v5.20.0`, commit `e1fb7cb768ae4d926b6b50e96e65b0672188934e`) and the live directories below. Drafts are ready for an operator to submit; this review did not send outreach or create third-party issues or pull requests. Every submission is an outward action and needs the owner's approval for that one action. Track follow-through in the maintainers' issue tracker (GitLab #824).

## Current opportunities

| Channel | Verified status (2026-11-21 unless dated) | Next action |
| --- | --- | --- |
| [Anthropic community marketplace](https://github.com/anthropics/claude-plugins-community/blob/main/.claude-plugin/marketplace.json) | Existing entry still pins `fdb27d9261f6f9f24fd221db29cb86e573ec2d4d` (2026-04-07, 2.0.0-alpha.14). Its homepage is the page the project used before session-orchestrator.com, and its description names five typed waves. No entry in `anthropics/claude-plugins-official`. | Highest priority, and not a new submission. A submission from 2026-04-02 exists at https://claude.ai/directory/manage (status on 2026-11-21: Needs changes, nothing published). The Console form at platform.claude.com/plugins/submit no longer accepts submissions; they moved to claude.ai. Once a release that passes the directory scanner is on GitHub, the owner selects “Submit latest version” on the existing submission. The community repository does not accept listing PRs; its README says entries arrive through the claude.ai submission. See the resubmission notes below. |
| [Awesome Codex CLI PR #259](https://github.com/RoggeOhta/awesome-codex-cli/pull/259) | Submitted 2026-09-12 from the maintainer account, open, no merge conflict. The follow-up note below was posted on 2026-11-21. The list has no Session Orchestrator entry yet. | Do not open a second PR and do not comment again; wait for the maintainer. |
| [Awesome Claude Code #1611](https://github.com/hesreallyhim/awesome-claude-code/issues/1611) | Open since 2026-04-17, labels `validation-passed` and `resource-submission`, not updated since. It describes an older pure-Markdown, no-runtime package. | Update the existing recommendation; do not create a duplicate. Its contribution policy requires a human recommendation through the web UI. |
| [Pi package gallery](https://pi.dev/packages/session-orchestrator) | Lists 5.20.0. | No submission needed. Verify asynchronous indexing after releases. |
| [Claude Marketplaces](https://claudemarketplaces.com/) | Not rechecked on 2026-11-21. On 2026-09-08: no entry across five sitemaps (30,498 URLs), and the earlier submission-repository URL was no longer publicly reachable. | Establish the current maintainer-supported submission route before sending anything. |
| [skills.sh](https://skills.sh/) | Not rechecked on 2026-11-21. On 2026-09-08 the expected package page returned 404. | Assess skill-only installation separately: a skill listing does not install the complete plugin runtime or hook adapters. |

Directory status is time-sensitive. Recheck immediately before submission. This kit does not imply acceptance or improved search ranking.

## Shared description

- **Name:** Session Orchestrator
- **Website:** https://session-orchestrator.com/
- **Repository:** https://github.com/Kanevry/session-orchestrator
- **Package:** https://www.npmjs.com/package/session-orchestrator
- **License:** MIT

Session Orchestrator gives coding agents an agreed plan, a check after each round of changes and a handover to the next session. It supports Claude Code, Codex CLI, Cursor IDE and Pi. Enforcement depends on the harness: Claude Code has the complete hook integration; Cursor and Pi bridge supported events; on Codex the Edit/Write guards run on `apply_patch` since 5.18.0, and a subset of the other hooks is wired (see `docs/codex-setup.md`). Node.js 24 or newer is required.

Avoid version-dependent counts in directory descriptions. Use the live website and README for the current inventory and installation instructions.

## Anthropic directory resubmission notes

There is no form to fill in. The existing submission is scanned again whenever the owner selects “Submit latest version”, and the scanner also picks up new commits on its own schedule. Listing details recorded with the submission (homepage, privacy URL) are edited there; display name and short description follow the live version of `.claude-plugin/plugin.json`.

What the scanner reported up to 2026-11-22, and where each point stands:

- A line-ending rule in `.gitattributes` without `eol=lf` made it refuse every commit before scanning. Fixed in 5.21.0.
- `templates/python-uv/pyproject.toml` did not parse. Fixed in 5.21.0.
- The root `.mcp.json` declared the MCP server a second time, next to the inline declaration in `.claude-plugin/plugin.json`, and started it through a shell command that computes the program (13 findings, rule “Can’t confirm which code runs”). The file moved to `mcp/servers.json`, which only the Codex and Cursor manifests point at. Whether the scanner still reads the moved file as a declaration shows only in the next scan.
- The scan of 5.21.0 (2026-11-22) added a second blocking rule, “Plugin couldn’t be read completely” (1,643 files, 60.1 MB): the directory accepts a plugin it cannot read completely only from Verified organizations. The directory’s help page also names Verified status of the publishing organization as the condition for shipping command hooks and a local MCP server. Without it, no version of this plugin can be listed.
- Policy holds a reviewer decides for a Verified organization: dependencies installed from a lockfile, a text file over 256 KB (`CHANGELOG.md`), more than 512 files, `bin/`, hooks that can approve tool calls.

After every mirror push, read the scan of that commit back (Versions tab, then the commit) and record the fetch line, the policy result and the codes of blocking rules.

Suggested short description, for the manifest and anywhere a listing asks for one: Session Orchestrator gives your coding agents an agreed plan, a check after each round of changes and a handover to the next session. `/session` reads the repository and proposes the scope, `/go` runs it in waves of parallel agents with tests and typecheck after each wave, and `/close` checks every planned item and files the rest as issues. Free and MIT.

The package documents Node.js 24 prerequisites, installation and removal, telemetry controls, and the different hook capabilities of each supported harness.

Name a tag and its commit SHA wherever a revision is asked for; do not copy a moving branch as an immutable revision.

## Awesome Codex CLI follow-up note for PR #259 (posted 2026-11-21)

This PR is still current. The entry text matches the README, and the branch has no conflict with main. One fact has changed since September in the project's favour: since 5.18.0 the Edit/Write guards run on Codex `apply_patch`, documented in the [Codex setup guide](https://github.com/Kanevry/session-orchestrator/blob/main/docs/codex-setup.md). The entry text does not claim it, so nothing needs editing. Happy to adjust the category or the wording if that helps the review.

## Existing Awesome Claude Code issue update draft

Update to this recommendation: Session Orchestrator now ships a Node.js runtime and per-harness adapters, so the original “pure Markdown” and “no runtime dependency” description is outdated. The current installation requires Node.js 24 or newer. The project supports Claude Code, Codex CLI, Cursor and Pi; hook enforcement varies by platform. The original text also says “no telemetry”: usage telemetry now exists, is opt-in and stays off unless the user agrees to it.

Current links: https://session-orchestrator.com/ and https://github.com/Kanevry/session-orchestrator. The README covers installation, first session, upgrade, uninstall and data controls. Please assess the latest release and documentation when reviewing the existing recommendation.

## Search and AI discoverability

The site already provides crawlable HTML, canonical and language links, a sitemap, visible FAQs with matching structured data and source links. Keep those surfaces accurate and synchronized with shipped capabilities. Google's [AI features guidance](https://developers.google.com/search/docs/appearance/ai-features) says that no special AI text file or additional schema is required for its AI search features. The maintained `llms.txt` files are a convenience for readers, not evidence of ranking or inclusion.

Measure indexing and referral traffic before claiming a discovery improvement. Search Console access, impressions and conversions were not available in this review.
