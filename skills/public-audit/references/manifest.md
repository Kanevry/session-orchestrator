# Manifest input

The manifest is Markdown with YAML frontmatter at the beginning and optional notes after the closing delimiter. The parser reads only frontmatter. Its implementation is [manifest.mjs](../../../scripts/lib/public-audit/manifest.mjs). The default project input is `.orchestrator/public-audit.md`. <!-- path-check: example -->

```yaml
---
base-url: https://example.org/
languages: [en, de]
pages:
  - type: home
    url: /
    expected-schema-types: [Organization]
  - type: person
    url: /en/person/
    expected-schema-types: [Person]
  - type: article
    url: /en/article/
    expected-schema-types: [Article]
  - type: product
    url: /en/product/
    expected-schema-types: [Product]
allowed-hosts: [www.example.org]
url-variants:
  - http://example.org/
  - https://www.example.org/
sitemap-url: /sitemap.xml
llms-paths: [/llms.txt, /en/llms.txt, /de/llms.txt]
security-paths: [/.well-known/security.txt]
indexnow-paths: []
---
```

The example paths are illustrative; include only the actual public URLs requested by the user. Order pages with the core homepage first: crawler requests compare that same first configured URL. The audit prioritizes the core page and explicitly configured localized llms paths before remaining pages and auxiliary resources.

| Input key | Requirement and default | Normalized key |
| --- | --- | --- |
| `base-url` | Required absolute HTTP(S) URL, without user information | `baseUrl` |
| `languages` | Required nonempty array of nonempty strings; exact duplicates removed | `languages` |
| `pages` | Required nonempty array of `{type, url, expected-schema-types?}` | `pages`, with `expectedSchemaTypes: []` when omitted |
| `allowed-hosts` | Optional hostname array, without schemes, ports or paths; base hostname always included | `allowedHosts` |
| `url-variants` | Optional URL array; default empty | `urlVariants` |
| `sitemap-url` | Optional URL; default `/sitemap.xml` | `sitemapUrl` |
| `llms-paths` | Optional URL/path array; default `[/llms.txt]` | `llmsPaths` |
| `security-paths` | Optional URL/path array; default `[/.well-known/security.txt]` | `securityPaths` |
| `indexnow-paths` | Optional public candidate URL/path array; default empty | `indexnowPaths` |

Every configured URL resolves against `base-url`, loses its fragment, and must use HTTP(S), omit credentials and match an allowed hostname. Normalized path arrays contain absolute URLs. Protocols and ports share the normalized-host request allowance. An explicitly allowed hostname must still resolve only to public addresses.

List localized llms paths explicitly; declaring `languages` does not add them. Empty optional path arrays disable those file requests. IndexNow paths are public candidates supplied by the user, not guessed keys. Never put credentials, cookies, authorization headers, key bodies or environment-file contents in the manifest. Notes and extra stage-L fields have no operational effect in stage O.

Expected schema types select presence expectations. The shipped type rules measure limited required/recommended fields, not all schema.org semantics. A fictional Person can use `{"@context":"https://schema.org","@type":"Person","name":"Example Person"}`; an Organization can use `{"@context":"https://schema.org","@type":"Organization","name":"Example Organization","url":"https://example.org/"}`. These minimal examples do not imply complete rich-result eligibility.
