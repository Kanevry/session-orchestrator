---
name: public-audit
description: Use this skill when the user requests a public website discoverability audit from an explicit manifest, including HTTP redirects, page metadata, typed JSON-LD requirements, sitemaps, robots policy, crawler responses, head resources, HTML bytes and optional public files. Runs bounded deterministic observations without login, browser automation, account integrations or ranking claims; search visibility and account data remain stage L.
user-invocable: true
argument-hint: "[--manifest <file>] [--json] [--out <file>] [--max-requests-per-host <1..5>]"
model: inherit
color: cyan
---

# Public Audit

> **Plugin root:** `${CLAUDE_PLUGIN_ROOT}`. Claude Code replaces this with the plugin's absolute path when it loads this file. Where it appears unreplaced — in a file this skill reads with the Read tool, or on Codex, Cursor or Pi — the plugin root is the directory that contains this skill's `skills/` folder (two levels above the folder of this SKILL.md). Write that absolute path literally into every command that starts a plugin script: the Bash tool has no plugin variable, and shell variables do not survive between tool calls.

Measure the public technical discoverability of the site explicitly configured by the user. Read [soul.md](soul.md) before execution and [rubric-v1.md](rubric-v1.md) when interpreting results. This skill implements stage O of #2108; stage L remains open.

## Input and execution

Use the existing manifest or the user's selected file. The default is `.orchestrator/public-audit.md`. <!-- path-check: example -->
Read [references/manifest.md](references/manifest.md) when preparing or correcting input. If no manifest exists, prepare the example with the user's known site and page types; obtain missing required values before making requests. Do not guess domains, discover pages by crawling, or infer IndexNow keys.

Run the deterministic CLI from the audited project, passing its manifest path. The implementation is `scripts/lib/public-audit/cli.mjs`. <!-- path-check: planned #2108 -->

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/public-audit/cli.mjs" --manifest <file> --json
```

Without `--json`, the CLI prints a readable report. `--out <file>` writes only the selected output path. The default request allowance is five per normalized hostname; `--max-requests-per-host` accepts integers from 1 through 5 and cannot increase that ceiling. `--help` prints usage without loading a manifest or making requests.

Keep configured homepage/schema and explicitly listed localized llms requests ahead of remaining page types and auxiliary resources, as implemented by the audit coordinator. Redirect hops, failed requests and changed User-Agent values consume the same host allowance. Budget exhaustion is an expected incomplete result; do not rerun or raise limits to disguise it.

## Interpretation and delivery

Read [references/measurement-contract.md](references/measurement-contract.md) for state, provenance and parser limits. Present error findings, opportunities, successful observations and incomplete observations separately. Preserve the report's URLs, timestamps, page types, reasons and source references. Label sitemap numbers as observed subsets when `complete` is false; a missing request is never a zero or a successful measurement.

CLI exits are: `0` complete without error findings (opportunities allowed), `1` error findings, `2` invalid input or output, and `3` incomplete without error findings. An error exit can coexist with incomplete observations. JSON stdout contains only JSON; diagnostics belong on stderr.

A successful GET under a crawler User-Agent is an observation of that request, not evidence of crawler identity, indexing or an AI recommendation. Shipped crawler source URLs are unverified references and must not be fetched by the skill.

## Boundaries

Use the shared transport and readers; do not substitute browser automation, global fetch, login, cookies, authorization headers, paid APIs, model calls or environment-file access. The transport uses Node HTTP(S), validates public DNS answers, and pins a validated address at every connection and redirect. Explicit allowed hosts do not permit private destinations.

Report findings without changing the site or creating issues. Invocation does not authorize a live acceptance campaign, browser tests, broader scanning or account connections. Search rankings, account analytics, actual indexation, rich-result eligibility, stage L, automatic sitemap bootstrap, comparisons between runs and metric ledgers remain outside this stage. No command-source file is needed: the existing generators derive adapters from this user-invocable skill.
