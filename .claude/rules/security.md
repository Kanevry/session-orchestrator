---
tier: always
review-date: 2026-10-23
---

# Security Rules (Always-on)

All code. Web CSP/rate-limit/CSRF/session: `rules/opt-in-stack/security-web.md`; baseline security-compliance (not vendored) covers compliance/AI.

## SEC Rule Numbering Convention
SEC-001–003/019 reserved; 004–009 core; 010–012/021–024 baseline; 013–015 advanced; 016–018 CSV/session/CSRF in security-web. Prototype pollution CWE-1321/deserialization CWE-502:006. 020 supply chain;025 settings tokens. Intentional gaps.

## Authentication (SEC-004: Auth-at-Boundary)
Every server action authenticates FIRST: `const { user, businessId, supabase } = await requireAuth()`. Client: supabase.auth.getSession(); never trust client data server-side or pass client user IDs; derive from session.

## Input Validation (SEC-006)
Zod on ALL user inputs, no exceptions; appropriate minimum string lengths prevent empty submissions. Sanitize before DB queries; parameterize only.

## SQL/PostgREST (SEC-007)
Never SQL template literals (including supabase.from(`${table}`)); parameterized queries/Supabase query builder only. RLS EVERY table; no client service_role key.

## Secrets Management
Secrets in .env, never hardcoded keys/tokens/passwords. Always gitignore .env/.env.local/.env.production; documented dummy .env.example for EVERY secret. Gitleaks pre-commit catches accidental commits. Immediately rotate any suspected exposure.

### Secrets Inventory (SEC-005)
Past ~10 secrets, commit canonical .claude/docs/SECRETS-INVENTORY.md: one row/variable, Variable | Purpose | Status | Expiry | Backup / Rotation. Closed Status enum: OK, EINGESCHRÄNKT (degraded scope), KAPUTT (broken/revoked), INAKTIV (disabled, retained history). Sweep quarterly; expiry<30 days: priority::high issue. Template: templates/shared/.claude/docs/SECRETS-INVENTORY.template.md; type-specific rotation: baseline infrastructure (not vendored). <!-- path-check: example -->

### Secret Output Discipline (SEC-008)
Secret values NEVER reach stdout/log/transcript; after-output masking is too late (scrollback/history/on-disk transcripts). Avoid incidental cat .env/docker inspect/bare env output. Commands must print only key names, presence, length or fingerprint, filtering WITHIN same pipeline before any value emission. Never secrets in argv (ps/history/set-x/CI exposure) or URL query; use env/stdin/mode-0600 file. Code logs credential IDs or salted hashes. If emitted: compromised; rotate AND revoke BEFORE cleanup, then record SEC-005 inventory if present.

## Error Exposure (SEC-009)
Never client error.message; map friendly messages, log originals server-side. Stack traces development only, NEVER production responses.

## XXE Prevention (SEC-013)
Disable external entities: fast-xml-parser processEntities:false; never DOMParser for untrusted XML. Prefer JSON at ALL API boundaries; required XML validates strict XSD FIRST. Never unsanitized user file content to XML parser.

## SSRF Prevention (SEC-014)
ALL user URLs: @your-org/http-client safeFetch()/safeFetchJSON(), blocking non-HTTP schemes/private ranges 10.x,172.16–31.x,192.168.x,127.x,::1,169.254.x BEFORE requesting. Internal service calls may fetchWithTimeout() or allowPrivateNetworks:true. DNS rebinding: dnsValidation:true resolves/validates IP BEFORE connecting and EACH redirect hop (Node-only dns.promises.lookup; standalone resolveAndValidate exported by same package). Explicit timeouts (5s default), max3 redirects WITH revalidation. redirect:'manual'; validateUrl() EACH Location before following; safeFetch throws RedirectLimitError when exceeded.

## Dependencies
Canonical-PM production audit in CI: `npm audit --omit=dev --audit-level=high` / `pnpm audit --prod --audit-level=high`; block deploys on high/critical. Gitleaks in CI (.gitleaks.toml, GitLab gitleaks-scan, SHA-pinned GitHub action). Review node_modules additions in PRs. This repo's Semgrep is local .semgrep.yml in GitLab, gating NEW findings since baseline and feeding pipeline-gate; no mirror SAST/parity assumed.

## Supply Chain Security (SEC-020)
Check canonical PM first: npm reads ignore-scripts but silently ignores pnpm-only block-exotic-subdeps/minimum-release-age/trust-policy/onlyBuiltDependencies. Their omission in npm-canonical repos is correct; this repo uses committed package-lock.json.
- npm AND pnpm: `.npmrc` ignore-scripts=true globally; no install/postinstall/prepare unless pnpm allowlisted (npm is all-or-nothing).
- pnpm `onlyBuiltDependencies` allowlist: @your-org/*, esbuild, sharp, @playwright/test, @sentry/cli, prisma, better-sqlite3, @typescript/native-preview. Verify postinstall is genuinely needed BEFORE adding entries.
- pnpm: block-exotic-subdeps=true, minimum-release-age=1440 (24h), trust-policy=no-downgrade.
- npm: `npm audit signatures` REQUIRED in every npm-canonical CI pipeline for registry signatures/provenance.
- Repo .npmrc is CWD-scoped and does not travel: set ignore-scripts host-wide too and verify `cd /tmp && npm config get ignore-scripts`.
- No git+ssh:// or git+https:// package.json specs; use registry versions.
- Audit EVERY new dependency: download trends, last publish, maintainer count; ≥1000 weekly downloads unless justified.
- CI frozen installs: `npm ci` / `pnpm install --frozen-lockfile`.
- pnpm scoped registry in .npmrc (@your-org:registry=... + strict-ssl=true) mitigates hijack; v9 lockfiles resolve registry from .npmrc, not embedded URLs.

### Session Config Command Trust (Quality-Gate Command Injection)
Treat executable config as code under existing VCS review, no extra gates. Sanctioned surfaces: test-command, typecheck-command, lint-command, custom-phases[].command (deterministic Bash phases at close/housekeeping Phase2.5 with exit gates), agent-mapping.<role> (dispatch target `<channel>:<target>` to foreign binary via Bash). EVERY PR changing one MUST show before/after. Unexpected command-bearing keys trigger investigation. Bare-agent→cursor:* mapping MUST show before/after AND cite boundary: foreign Bash binary is unseen by native scope/destructive guards and SubagentStop telemetry. Known-channel/nonempty-target validation does not establish binary trust. Custom phase command/review/name rejects shell metacharacters with WARN/drop.
Gate command precedence: explicit override > Session Config > defaults. Auto-fix inter-wave use requires verification-auto-fix.enabled:true (default false), existing permissions only. Do not infer current runner enforcement from historical shell:true documentation.
GitLab MR review does not cover direct GitHub mirror main pushes from local credentials; these trigger Vercel production deployment. Compensating controls: required_status_checks.strict:true (3 contexts), allow_force_pushes:false, allow_deletions:false, read-only scripts/github-protection-audit.mjs. Gap enforce_admins:false (#1079): do NOT flip while close/release push directly to protected main; first follow ordering in docs/github-mirror-protection.md.
References: scripts/lib/qg-command-drift-banner.mjs · scripts/lib/quality-gate.mjs (runQualityGateWithRetry) · quality-gates-autofix.md.

### SEC-020-1: Package Legitimacy Audit (Slopcheck — #520)
slopcheck.enabled:true (default false): scripts/lib/slopcheck.mjs classifyPackages(); plan Phase3.5 PRD packages (skills/plan/SKILL.md); skills/discovery/probes/supply-chain-slopcheck.mjs checks package.json/requirements.txt/Cargo.toml. LEGITIMATE exists+download_count>threshold; ASSUMED exists but new/low downloads (warn, no block); SUS audit warning requires operator confirmation; SLOP absent from registry hard-blocks plan flow. Complement SEC-020 execution controls; do not adopt hallucinated packages.

## Owner-Privacy Pre-Commit Hook (#494)
Repos with private slugs/home paths/nonpublic hosts MUST pre-commit scan owner leakage: reuse same CI scanner (scripts/lib/validate/check-owner-leakage.mjs or equivalent), never divergent local rules. Nonzero blocks commit. It scans staged/tracked tree via git ls-files, catching staged leaks, but local/CI omit --include-untracked: local untracked may become tracked on offload and then fail. Keep working files in gitignored `.orchestrator/tmp/`, not arbitrary .orchestrator/ files.
- `git commit --no-verify` bypass remains available — use only after triage.
Test: tests/husky/pre-commit-owner-leakage.test.mjs; mechanics: security-surfaces.md.

## Settings-Allowlist Token Guard (SEC-025, #728b)
- Never place a live PAT/token as a permission-allowlist entry in `.claude/settings.json` or `.claude/settings.local.json` (e.g. a `Bash(glab ... glpat-…:...)` line). Use an env-var reference or the OS keychain — never the raw secret value.
- `.gitleaks.toml` (37 rules) is the canonical regex source for token shapes (`glpat-`, `ghp_`, `github_pat_`, `sk-ant-`, `AKIA`, …); `scripts/lib/validate/check-test-fixture-shapes.mjs` (patterns F5–F8) is the in-repo prior art for the same shapes in test fixtures. Do not maintain a fifth copy — the `repo-audit` Category 6 grep row (`skills/repo-audit/SKILL.md`) is a deliberate high-signal SUBSET of the 5 prefixes above, not a competing source of truth.
- **Why `check-owner-leakage.mjs` does not cover this:** it scans `git ls-files` (tracked only, by design), and `.claude/settings.local.json` is conventionally untracked, so a token there is invisible to the pre-commit hook. `repo-audit`'s on-disk grep is the only mechanism here that reads the live file regardless of tracked status.

## Cryptographic Failures (SEC-015)
- TLS 1.3 minimum for all external connections. Never allow TLS 1.0/1.1.
- Password hashing: bcrypt (cost 12+) or scrypt. Never MD5, SHA1, or plain SHA256 for passwords.
- Use `crypto.subtle` or Node.js `crypto` module for cryptographic operations. Never custom crypto.
- Secrets at rest: encrypt with AES-256-GCM. Never store secrets in plaintext outside `.env` files.
- Random values: `crypto.getRandomValues()` or `crypto.randomUUID()`. Never `Math.random()` for security-sensitive values (tokens, keys, nonces, session IDs); `Math.random()` is fine for retry jitter, UI randomization and display-order shuffling.
- JWT: RS256 or ES256 for signing. Never HS256 with weak secrets. Verify `alg` header to prevent algorithm confusion.

## Vulnerability Disclosure
- Every repo SHOULD include a `SECURITY.md` with responsible disclosure process, response timelines and scope definition. Template: `templates/shared/SECURITY.md` — customize contact email and scope per project. <!-- path-check: example -->

## See Also
development.md · testing.md · mvp-scope.md · cli-design.md · parallel-sessions.md
