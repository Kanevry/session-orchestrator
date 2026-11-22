# Measurement and transport contract

The deterministic interfaces are implemented in [`scripts/lib/public-audit/`](../../../scripts/lib/public-audit/). Measurement functions are `measurePage({page,response,manifest})`, `measureResources({manifest,pageResults,fetcher,clock?})`, and `measureFiles({manifest,pageResults,fetcher,clock?})`. Resource/file measurements are asynchronous. Each page result is `{page,response,html}`, with HTML read by the shared reader.

## Observation shape and states

A measurement carries `checkId`, `state`, `url`, ISO-UTC `timestamp`, and optional `value`, `reason`, `pageType`, `category` and `sources`. Findings use category `error` or `opportunity`; successful and incomplete states are kept separate. Every numeric value, including derived counts and percentages, retains `sources:[{url,timestamp}]`. Do not fabricate zero, null or success for an unmeasured value.

| State | Meaning |
| --- | --- |
| `ok` | The stated observation completed within its defined scope. Optional-file absence can be a neutral successful observation. |
| `finding` | Observed error or opportunity; category distinguishes them. |
| `unavailable` | Network/deadline failure, HTTP 429 or HTTP 5xx prevented observation. |
| `not-fetched` | The request allowance prevented a request. |
| `not-measurable` | Unsupported input, unknown location, parser/traversal limit or another stated measurement ceiling prevents a conclusion. |

Failures on one page propagate to that page's dependent measurements. A finding in an observed sitemap subset does not establish that unvisited descendants are valid. Sitemap values explicitly distinguish observed unique URLs, observed entries and visited documents; retain `complete: false` and the reason when any descendant remains unknown.

The report carries timestamp, manifest metadata, measurements and budget provenance. JSON output must not serialize raw responses, headers or bodies. IndexNow candidate paths may contain key material: display a generic redacted candidate location and never print key bodies or filenames. See [rubric-v1.md](../rubric-v1.md) for emitted IDs and interpretation.

## Requests and scope

Use [fetch.mjs](../../../scripts/lib/public-audit/fetch.mjs), whose `createFetcher` returns `{fetch,counts}`. The method name `fetch` is the bounded service interface, not permission to substitute global fetch. Its native transport uses `node:http`/`node:https` with a validated-address lookup. Every DNS answer must be public, including IPv4-mapped IPv6, and every redirect repeats validation before connecting. Host allowlisting never overrides public-address validation.

Each actual GET and redirect hop consumes one request from the normalized hostname allowance, across schemes, ports, failures and User-Agent values. The default and maximum are five; the CLI can lower the value to 1–5. Cache identity is URL plus User-Agent. Follow at most three redirects manually, with no retries, HEAD probes or follow-up requests hidden outside the allowance. A redirect body is not page content.

The default User-Agent is `PublicAudit/1.0`; do not add identifying operator names or email addresses. No credentials, cookies, authorization headers, logins, environment files, browser automation, paid APIs or model calls are part of the audit. Response limits are 2 MiB per entity, five seconds per request across DNS through body completion, and a 60-second audit deadline. Request identity content encoding; unsupported encodings, oversized bodies and unsupported decodes remain explicitly incomplete. Received entity bytes do not mean compressed wire bytes. Text bodies require a supported declared charset (UTF-8 or US-ASCII; omitted charset defaults to UTF-8) and valid bytes; fatal UTF-8 validation prevents replacement-character success. Recognized binary images, audio, video, fonts, octet-stream, PDF and ZIP retain HTTP status and `receivedBytes` with `bodyKind: binary` and an empty body; SVG remains text. Their payloads are not decoded or exposed, so an image GET does not fail merely because its bytes are not UTF-8.

The audit prioritizes the first configured core page and explicitly listed localized llms paths, then remaining pages and auxiliary resources. Five requests cannot establish a complete large-site inventory. Report the subset; do not trigger extra runs or additional discovery to fill gaps. Running this skill does not authorize a separate live acceptance campaign or site mutations.

## Reader and semantic ceilings

[readers.mjs](../../../scripts/lib/public-audit/readers.mjs) provides `readHtml` and `readSitemap`. It is a bounded deterministic reader, not a browser DOM or complete HTML5 recovery implementation. It does not execute JavaScript or expand entities. Entity-dependent metadata, unsupported XML declarations/content, malformed input and bounds violations remain explicit when they prevent measurement. Sitemap XML traversal is bounded and checks cycles; an index whose child could not be read is incomplete.

The HTML reader exposes head metadata and links, H1 count, JSON-LD and script bodies for measurement. Resource presence is derived from head only. A limited implicit head-to-body transition handles a non-head start tag or non-whitespace body text encountered without an explicit closing head tag, so later body links do not become head resources. This is not general HTML5 tree recovery; unsupported or ambiguous structures retain the reader ceiling. Malformed JSON-LD must be distinguished from valid JSON with missing type-specific fields. Traversing graphs and arrays of types establishes the shipped rules only, not complete JSON-LD semantics, schema.org validation, actual indexing or search-engine eligibility. Schema dictionary lookup uses declared own keys only. Values expose `supportedTypes`, `unsupportedTypes` and `complete`; unsupported-only rule coverage is not-measurable. Mixed coverage retains known violations and, when those violations produce a finding, adds a separate not-measurable `page.schema.coverage` observation. A type-name presence check is not evidence that unknown type requirements were assessed.

Hydration counts cover explicit inert JSON script data with `scope: inert-json-only`. Executable scripts and JSON-LD are excluded. Known Next Flight (`self.__next_f` push/initialization), `window.__INITIAL_STATE__` and `__NUXT__` assignments are unsupported embedded-data representations. Their detection makes `page.hydration` not-measurable with `complete: false` and `unsupportedRepresentations`, while retaining observed inert JSON bytes, script count, percentage and sources. No JavaScript parser, execution, arbitrary assignment analysis or total executable-data byte count is inferred. A complete inert-JSON observation concerns that stated scope only. Optional llms/security/IndexNow observations establish HTTP presence or neutral absence, not compliance with a document specification or an active submission service.

The deliberate ceilings are bounded HTML/XML parsing, prefix-only robots matching, bounded sitemap traversal and inert-JSON hydration identification. Revisit a ceiling when a real configured input cannot be represented: name the unsupported construct and its missing evidence before proposing parser or traversal changes. Do not silently relax the ceiling, treat unsupported syntax as absence, or add a dependency during an audit.

## Crawler references

The shipped [crawler identifiers](../../../scripts/lib/public-audit/crawler-identifiers.json) include User-Agent, operator, purpose, source URL, date and `not-verified` status. Source URLs are references only and are never fetched during this workflow. Robots policy uses the supported longest matching group/path subset; unsupported syntax is not-measurable. The actual crawler observation is a separate GET under that User-Agent against the same first configured core URL. A response does not authenticate the crawler or demonstrate search/AI inclusion.

Search/account integrations and other stage-L work, automatic sitemap bootstrap, comparisons between runs, metric ledgers and manual verification of crawler documentation remain open. This skill does not create issues or authorize that additional work.
