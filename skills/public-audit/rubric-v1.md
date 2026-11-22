# Public-audit rubric v1

Apply this rubric to stage-O observations from the configured manifest. There is no aggregate SEO score. The rubric explains what emitted checks establish, how findings are classified, and what remains unknown. Read [the measurement contract](references/measurement-contract.md) before interpreting partial evidence.

| Point | Emitted check IDs | Evidence and interpretation |
| --- | --- | --- |
| 1. HTTP and metadata | `http.chain`, `http.variant`, `page.http`, `page.metadata`, `page.links` | Record configured and final URLs, response/redirect statuses, title and description lengths, one-H1 expectation, language alternates and resolved canonical. Unsuccessful page GETs and invalid metadata/link requirements are errors; a canonical target differing from the fetched page is an opportunity. A successful redirect chain describes observed behavior only. |
| 2. Typed JSON-LD | `page.schema`, `page.schema.coverage` | Inspect JSON-LD objects, nested graphs and arrays of types. Distinguish invalid JSON from missing expected types and missing required/recommended fields. No JSON-LD or expected types leaves the check not-measurable. Unsupported types expose incomplete rule coverage; known violations remain findings. This is a type-specific requirements check, not full schema.org or search-engine validation. |
| 3. Sitemaps | `sitemap.traversal`, `sitemap.lastmod`, `sitemap.languages` | Report observed unique URLs, entry count, documents visited, newest valid observed lastmod, missing/invalid dates and language gaps. Invalid dates are errors; language gaps are opportunities. Only `complete: true` permits a complete traversal claim. Cycles, unsupported XML, limits and failed child requests keep traversal incomplete. |
| 4. Robots and crawler responses | `robots.policy`, `crawler.response` | Separate a parsed policy decision for the configured core URL from the actual GET of that same URL under each crawler User-Agent. Disallow/status findings are opportunities. Unsupported robots syntax is not-measurable. Identity records include operator, purpose, source, date and not-verified status. |
| 5. Head resources | `head.icon.presence`, `head.apple-touch-icon.presence`, `head.manifest.presence`, `head.og-image.presence`, `head.resource` | Check each resource kind independently per configured page type. Missing resources and unsuccessful GETs are opportunities; a linked icon does not satisfy OG or manifest presence. Resource status requires an actual GET. Links in the body do not satisfy head presence. |
| 6. Feeds | `feed.presence`, `feed.status` | Separate the presence of a supported alternate feed link in head from the result of fetching it. Missing links and unsuccessful GETs are opportunities; a link alone does not establish feed availability or validity. |
| 7. HTML and data bytes | `page.bytes`, `page.hydration` | Measure received entity bytes and inert JSON script bytes using UTF-8, with source evidence for counts and percentages. Hydration values explicitly use `scope: inert-json-only`. Exclude executable JavaScript and JSON-LD from the observed bytes; known unsupported embedded-data markers make the result not-measurable while retaining the observed subset. These are observations with no invented size threshold or performance score. |
| 8. Optional public files | `public.llms`, `public.security`, `public.indexnow` | Record successful public-file responses and neutral 404/410 absence. HTTP success does not validate file contents. No configured IndexNow path means unknown location, hence not-measurable; never guess keys or print key bodies/filenames. Root and localized llms paths are measured only when listed in the normalized manifest. |

The HTTP coordinator lives in [audit.mjs](../../scripts/lib/public-audit/audit.mjs).
The implemented measurement owners are [pages.mjs](../../scripts/lib/public-audit/pages.mjs), [resources.mjs](../../scripts/lib/public-audit/resources.mjs), and [files.mjs](../../scripts/lib/public-audit/files.mjs). Type rules are [schema-rules.json](../../scripts/lib/public-audit/schema-rules.json); crawler reference data is [crawler-identifiers.json](../../scripts/lib/public-audit/crawler-identifiers.json). Use the emitted state/category as the authority when a measurement has multiple conditions; do not turn an incomplete state into an error or opportunity solely to fill a report section.

## Typed requirements

| Type | Required fields | Recommended fields |
| --- | --- | --- |
| Person | `name` | `url`, `sameAs` |
| Organization | `name`, `url` | `logo`, `sameAs` |
| Article | `headline`, `author`, `datePublished`, `image` | `dateModified`, `publisher` |
| Product | `name`, `image` | `description`, `offers` |

Missing required fields and configured expected types are error findings. Missing recommended fields are opportunities. Valid JSON syntax alone does not establish these requirements, and these requirements do not establish complete JSON-LD semantics or rich-result eligibility.

Schema values list `supportedTypes`, `unsupportedTypes` and `complete`. Only declared rule keys count as supported; inherited object keys do not become rules. Unsupported-only types produce not-measurable, even if their expected type names are present. Mixed known and unsupported types preserve known findings and emit `page.schema.coverage` as not-measurable when a finding coexists with incomplete coverage. `complete` concerns the shipped rule coverage only, not complete schema.org validation.

Hydration values retain observed inert JSON bytes, script count, percentage and source provenance with `scope: inert-json-only`. Known Next Flight, initial-state or Nuxt assignment markers make `complete: false` and list `unsupportedRepresentations`; the state is not-measurable because executable embedded data was not measured. Do not describe these subset counts as a total hydration payload.

## Verdict and provenance

Keep four views: error findings, opportunity findings, successful observations, and explicit incomplete observations. Incomplete states are `unavailable`, `not-fetched`, and `not-measurable`. They cannot count as successful checks. HTTP 429/5xx and request failures remain unavailable; exhausted allowance remains not-fetched. Observed findings may coexist with unknown descendants or other incomplete checks.

Every numeric result needs source URL and ISO-UTC timestamp, including title lengths, counts, received bytes, percentages and request totals. The report's `budget` array contains `{host, requests, sources:[{url,timestamp}]}` records; it is not a separate check ID or permission to increase requests. Preserve report timestamp and manifest metadata without including raw response headers or bodies.

Exit `0` requires completeness and no error findings; opportunities may remain. Exit `1` means an error finding exists, including when other checks are incomplete. Exit `2` means invalid input/output. Exit `3` means incomplete without an error finding. A clean-looking subset is not a complete audit. Stage L and manual crawler-source verification remain open after a stage-O report.
