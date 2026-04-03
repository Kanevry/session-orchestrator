# Discovery Probes Reference

This document defines all discovery probes used by the discovery skill. It is a reference
document -- not a skill. The main SKILL.md references probes by name and category.

Each probe specifies: activation conditions, exact detection commands, evidence format,
and default severity. All Grep patterns and Bash commands are copy-pasteable.

---

## Category: `code`

### Probe: hardcoded-values

**Activation:** Any project with source files.

**Detection Method:**

1. Hardcoded secrets:
```bash
# Grep for hardcoded secrets in source files (exclude tests, .env, config examples)
Grep pattern: (password|api_key|secret|token|api_secret)\s*[:=]\s*["'][^"']+["']
  --glob "!*.test.*" --glob "!*.spec.*" --glob "!.env*" --glob "!*.example"
  --glob "!*.sample" --glob "!**/test/**" --glob "!**/tests/**"
  --glob "!**/fixtures/**" --glob "!**/mocks/**"
```

2. Hardcoded URLs:
```bash
# Grep for hardcoded URLs in source files (exclude docs, configs, tests)
Grep pattern: https?://
  --glob "*.{ts,tsx,js,jsx,py,go,rs,java}" --glob "!**/test/**" --glob "!**/tests/**"
  --glob "!README*" --glob "!*.md" --glob "!*.config.*"
```

3. Magic numbers:
```bash
# Grep for magic numbers (numeric literals outside obvious contexts)
Grep pattern: [^a-zA-Z_]\b\d{4,}\b(?!\s*[;,\])}])
  --glob "*.{ts,tsx,js,jsx,py,go,rs,java}" --glob "!**/test/**"
```

**Evidence Format:**
```
File: <path> Line: <n>
Match: <matched_text>
Classification: secret | url | magic-number
```

**Default Severity:** Critical (secrets), High (URLs), Medium (magic numbers).

---

### Probe: orphaned-annotations

**Activation:** Any project with source files.

**Detection Method:**

```bash
# Grep for TODO/FIXME/HACK/XXX/TEMP/WORKAROUND annotations
Grep pattern: (TODO|FIXME|HACK|XXX|TEMP|WORKAROUND)[\s:()\-]
  --glob "*.{ts,tsx,js,jsx,py,go,rs,java,rb,swift,kt}"
```

For each match, check whether a corresponding VCS issue exists:
```bash
# Search for issue referencing the annotation text
gh issue list --search "<annotation text>" --limit 5
# or
glab issue list --search "<annotation text>" --per-page 5
```

Flag annotations with no corresponding issue.

**Evidence Format:**
```
File: <path> Line: <n>
Annotation: <TODO|FIXME|HACK|...>
Text: <annotation text>
Linked Issue: <#IID or NONE>
```

**Default Severity:** Low (TODO), Medium (FIXME/HACK/XXX/TEMP/WORKAROUND).

---

### Probe: dead-code

**Activation:** `package.json` exists (JS/TS projects).

**Detection Method:**

1. Unused exports:
```bash
# Find all export statements
Grep pattern: export\s+(default\s+)?(function|class|const|let|var|type|interface|enum)\s+(\w+)
  --glob "*.{ts,tsx,js,jsx}" --glob "!**/node_modules/**"

# For each exported name, check for importers
Grep pattern: import.*<exported_name>
  --glob "*.{ts,tsx,js,jsx}" --glob "!**/node_modules/**"

# Flag exports with 0 importers (exclude index files and entry points)
# Exclude: index.ts, index.js, main.ts, main.js, app.ts, app.js
```

2. Unused dependencies:
```bash
# List all dependencies from package.json
cat package.json | python3 -c "import json,sys; deps=json.load(sys.stdin).get('dependencies',{}); [print(d) for d in deps]"

# For each dependency, check if it is imported anywhere
Grep pattern: (import|require).*['"]<dependency_name>
  --glob "*.{ts,tsx,js,jsx}" --glob "!**/node_modules/**"
```

**Evidence Format:**
```
Type: unused-export | unused-dependency
Name: <export_name or dependency_name>
Defined In: <file_path>:<line>
Importers Found: 0
```

**Default Severity:** Low.

---

### Probe: ai-slop

**Activation:** Any project with source files.

**Detection Method:**

1. Slop patterns (reference `slop-patterns.md` for full pattern list):
```bash
# Filler phrases in comments
Grep pattern: (as you can see|it's worth noting|needless to say|it should be noted|obviously|of course|basically|essentially|simply|let's go ahead|let's proceed|moving on to)
  --glob "*.{ts,tsx,js,jsx,py,go,rs,java}"

# Over-documented trivial code (param docs repeating param name)
Grep pattern: @param\s+(\w+)\s+[-—]\s*(the\s+)?\1
  --glob "*.{ts,tsx,js,jsx}"

# Generic error messages
Grep pattern: catch.*throw new Error\(["'].*error occurred
  --glob "*.{ts,tsx,js,jsx,py}"

# Redundant type assertions
Grep pattern: as string(?=\s*[;,)\]])
  --glob "*.{ts,tsx}"
```

2. Hallucinated imports (verify every import resolves):
```bash
# Extract all relative imports and check they exist on disk
Grep pattern: from\s+["'](\.\.?/[^"']+)["']
  --glob "*.{ts,tsx,js,jsx}"

# For each match, verify the file exists:
# test -f <resolved_path>.ts || test -f <resolved_path>.tsx || test -f <resolved_path>/index.ts

# Extract package imports and verify against package.json
Grep pattern: from\s+["']([^./][^"']*)["']
  --glob "*.{ts,tsx,js,jsx}"
# Verify each package is in dependencies or devDependencies
```

**Evidence Format:**
```
Type: slop-pattern | hallucinated-import
File: <path> Line: <n>
Pattern: <matched_text>
Category: filler | over-doc | generic-error | redundant | hallucinated
```

**Default Severity:** Medium (slop patterns), High (hallucinated imports).

---

### Probe: type-safety-gaps

**Activation:** `tsconfig.json` exists.

**Detection Method:**

```bash
# any type usage
Grep pattern: :\s*any\b
  --glob "*.{ts,tsx}" --glob "!*.test.*" --glob "!*.spec.*" --glob "!**/test/**"

# Type assertion to any
Grep pattern: as\s+any\b
  --glob "*.{ts,tsx}" --glob "!*.test.*" --glob "!*.spec.*"

# TypeScript directive suppressions
Grep pattern: @ts-ignore|@ts-expect-error
  --glob "*.{ts,tsx}"

# Non-null assertions
Grep pattern: \w+!\.
  --glob "*.{ts,tsx}" --glob "!*.test.*" --glob "!*.spec.*"
```

**Evidence Format:**
```
File: <path> Line: <n>
Pattern: any-type | as-any | ts-ignore | ts-expect-error | non-null-assertion
Code: <matched_text>
```

**Default Severity:** Medium.

---

### Probe: test-coverage-gaps

**Activation:** Test infrastructure exists (test directory, test config, or test files present).

**Detection Method:**

```bash
# Find all source files
Glob pattern: src/**/*.{ts,tsx,js,jsx,py,go,rs}
  --glob "!*.test.*" --glob "!*.spec.*" --glob "!**/test/**" --glob "!**/tests/**"
  --glob "!**/fixtures/**" --glob "!**/mocks/**" --glob "!**/__mocks__/**"

# For each source file, check if a corresponding test file exists:
# JS/TS: <name>.test.ts, <name>.spec.ts, <name>.test.tsx, <name>.spec.tsx
# Python: test_<name>.py, <name>_test.py
# Go: <name>_test.go
# Rust: tests/<name>.rs or #[cfg(test)] in same file

# List source files with no test counterpart
```

**Evidence Format:**
```
File: <path>
Test File Expected: <expected_test_path>
Status: MISSING
```

**Default Severity:** Medium.

---

### Probe: test-anti-patterns

**Activation:** Test files exist.

**Detection Method:**

```bash
# Tests with no assertions (assert-nothing)
# Find test functions/blocks, check for expect/assert within them
Grep pattern: (it|test)\s*\(
  --glob "*.{test,spec}.{ts,tsx,js,jsx}"
# Then verify each test block contains at least one:
Grep pattern: (expect|assert|should|toBe|toEqual|toMatch|toThrow|toHaveBeenCalled)
  # If absent in the same test block, flag as assert-nothing

# Excessive mocking (test-the-mock)
Grep pattern: (jest\.mock|vi\.mock|sinon\.stub|mock\()
  --glob "*.{test,spec}.{ts,tsx,js,jsx}"
# Flag files with >5 mock statements

# Flaky test indicators
Grep pattern: (setTimeout|sleep|delay|waitFor)\s*\(
  --glob "*.{test,spec}.{ts,tsx,js,jsx}"

# Snapshot abuse
Grep pattern: toMatchSnapshot|toMatchInlineSnapshot
  --glob "*.{test,spec}.{ts,tsx,js,jsx}"
# Flag files with >10 snapshot assertions

# Swallowed errors in tests
Grep pattern: catch\s*\([^)]*\)\s*\{\s*\}
  --glob "*.{test,spec}.{ts,tsx,js,jsx}"
```

**Evidence Format:**
```
File: <path> Line: <n>
Anti-Pattern: assert-nothing | test-the-mock | flaky-indicator | snapshot-abuse | swallowed-error
Code: <matched_text>
```

**Default Severity:** High.

---

### Probe: security-basics

**Activation:** Any project with source files.

**Detection Method:**

```bash
# eval usage
Grep pattern: \beval\s*\(
  --glob "*.{ts,tsx,js,jsx,py}" --glob "!**/node_modules/**"

# Dangerous HTML injection (React)
Grep pattern: dangerouslySetInnerHTML
  --glob "*.{tsx,jsx}"

# innerHTML assignment
Grep pattern: innerHTML\s*=
  --glob "*.{ts,tsx,js,jsx}"

# SQL injection via template literals
Grep pattern: `[^`]*SELECT[^`]*\$\{
  --glob "*.{ts,tsx,js,jsx}" --glob "!**/test/**" --glob "!**/tests/**"

# Permissive CORS
Grep pattern: cors.*\*|Access-Control-Allow-Origin.*\*
  --glob "*.{ts,tsx,js,jsx,py,go,java}" --glob "!**/test/**"

# Insecure randomness in security contexts
Grep pattern: Math\.random\(\)
  --glob "*.{ts,tsx,js,jsx}" --glob "!**/test/**"
# Cross-reference with nearby security-related terms (token, secret, key, auth, session)
```

**Evidence Format:**
```
File: <path> Line: <n>
Vulnerability: eval | xss-dangerous | xss-innerhtml | sql-injection | cors-wildcard | insecure-random
Code: <matched_text>
Context: <surrounding lines>
```

**Default Severity:** High. Critical for SQL injection and XSS patterns.

---

## Category: `infra`

### Probe: ci-pipeline-health

**Activation:** CI config exists (`.gitlab-ci.yml`, `.github/workflows/`, `Jenkinsfile`, etc.).

**Detection Method:**

```bash
# GitLab: query recent pipeline status
glab pipeline list --per-page 10

# GitHub: query recent workflow runs
gh run list --limit 10

# Parse output for:
# - Repeated failures (same pipeline failing 3+ times in a row)
# - Long-running failures (pipeline failed >24h ago with no subsequent success)
# - Currently failing pipelines
```

**Evidence Format:**
```
Pipeline: <pipeline_id or run_id>
Status: failed | success
Duration: <time>
Failed Since: <timestamp>
Consecutive Failures: <count>
```

**Default Severity:** High. Critical if failed >24h with no fix.

---

### Probe: env-config-drift

**Activation:** `.env.example` exists.

**Detection Method:**

```bash
# Extract keys from .env.example
grep -E '^\s*[A-Za-z_][A-Za-z0-9_]*\s*=' .env.example | sed 's/=.*//' | sort > /tmp/env_example_keys

# Extract keys from .env (if exists)
grep -E '^\s*[A-Za-z_][A-Za-z0-9_]*\s*=' .env 2>/dev/null | sed 's/=.*//' | sort > /tmp/env_keys

# Extract keys from .env.local (if exists)
grep -E '^\s*[A-Za-z_][A-Za-z0-9_]*\s*=' .env.local 2>/dev/null | sed 's/=.*//' | sort > /tmp/env_local_keys

# Keys in .env.example but NOT in .env — missing config
comm -23 /tmp/env_example_keys /tmp/env_keys

# Keys in .env but NOT in .env.example — undocumented config
comm -13 /tmp/env_example_keys /tmp/env_keys
```

**Evidence Format:**
```
Key: <ENV_VAR_NAME>
Status: missing-from-env | undocumented | missing-from-env-local
Source: .env.example
```

**Default Severity:** Medium. High if key name contains SECRET, KEY, TOKEN, PASSWORD.

---

### Probe: outdated-dependencies

**Activation:** Package manager detected (`package.json`, `requirements.txt`, `Pipfile`, `Cargo.toml`, `go.mod`).

**Detection Method:**

```bash
# Node.js
npm outdated --json 2>/dev/null
npm audit --json 2>/dev/null

# Python
pip list --outdated --format=json 2>/dev/null
pip-audit --format json 2>/dev/null

# Go
go list -u -m all 2>/dev/null

# Rust
cargo outdated --format json 2>/dev/null
cargo audit --json 2>/dev/null
```

Parse JSON output. Flag:
- Major version bumps (current major != latest major)
- Known CVEs from audit output

**Evidence Format:**
```
Package: <name>
Current: <version>
Latest: <version>
Bump Type: major | minor | patch
CVE: <CVE-ID or NONE>
CVE Severity: <critical|high|medium|low|none>
```

**Default Severity:** Low (outdated minor/patch), Medium (outdated major), Critical (known CVE).

---

### Probe: deployment-health

**Activation:** `health-endpoints` configured in Session Config.

**Detection Method:**

```bash
# For each endpoint in health-endpoints:
curl -s -o /dev/null -w "%{http_code} %{time_total}" <endpoint>

# Flag:
# - Non-200 status codes
# - Response time > 2s
# - Connection timeouts
```

**Evidence Format:**
```
Endpoint: <url>
Status Code: <code>
Response Time: <seconds>s
Healthy: true | false
```

**Default Severity:** High.

---

## Category: `ui`

### Probe: accessibility-gaps

**Activation:** React/Vue/HTML files exist (`.tsx`, `.jsx`, `.vue`, `.html`).

**Detection Method:**

```bash
# Images without alt text
Grep pattern: <img(?![^>]*\balt\s*=)[^>]*>
  --glob "*.{tsx,jsx,vue,html}"

# Buttons without accessible text
Grep pattern: <button(?![^>]*aria-label)[^>]*>\s*<(?!span|text)
  --glob "*.{tsx,jsx,vue,html}"

# Links without accessible text
Grep pattern: <a\s(?![^>]*aria-label)[^>]*>\s*<(?!span|text)
  --glob "*.{tsx,jsx,vue,html}"

# Inputs without labels
Grep pattern: <input(?![^>]*aria-label)(?![^>]*aria-labelledby)[^>]*>
  --glob "*.{tsx,jsx,vue,html}"
# Cross-check: is there a <label for="..."> matching this input's id?

# Missing lang attribute
Grep pattern: <html(?![^>]*\blang\s*=)
  --glob "*.html"
```

**Evidence Format:**
```
File: <path> Line: <n>
Violation: img-no-alt | button-no-label | link-no-label | input-no-label | html-no-lang
Element: <matched_element>
WCAG Level: A | AA
```

**Default Severity:** Medium. High for WCAG Level A violations (img-no-alt, html-no-lang).

---

### Probe: responsive-issues

**Activation:** CSS/SCSS/Tailwind files exist.

**Detection Method:**

```bash
# Fixed widths on containers (>99px)
Grep pattern: width:\s*\d{3,}px
  --glob "*.{css,scss,less,sass}"

# Absolute positioning patterns (potential responsive issues)
Grep pattern: position:\s*absolute
  --glob "*.{css,scss,less,sass}"
# Cross-reference: check if parent has position:relative and explicit dimensions

# Missing viewport meta tag
Grep pattern: <meta[^>]*viewport
  --glob "*.html"
# Flag HTML files WITHOUT this pattern
```

**Evidence Format:**
```
File: <path> Line: <n>
Issue: fixed-width | absolute-position | missing-viewport
Code: <matched_text>
Value: <dimension if applicable>
```

**Default Severity:** Medium.

---

### Probe: design-drift

**Activation:** Pencil MCP configured in Session Config (`pencil: true` or design file path provided).

**Detection Method:**

Use Pencil MCP tools to compare design specifications against implementation:
1. `get_editor_state` -- check current design file
2. `batch_get` -- retrieve design node properties (colors, spacing, typography)
3. `get_screenshot` -- capture design frames for visual comparison

Compare against:
- CSS custom properties / design tokens in codebase
- Component prop values
- Layout dimensions

**Evidence Format:**
```
Component: <component_name>
Design Value: <expected>
Implementation Value: <actual>
Property: color | spacing | typography | layout
Drift: <description>
```

**Default Severity:** High.

---

## Category: `arch`

### Probe: circular-dependencies

**Activation:** Any project with import/require statements.

**Detection Method:**

```bash
# Build import graph from source files
# Step 1: Extract all import relationships
Grep pattern: (import\s+.*from\s+["']([^"']+)["']|require\s*\(\s*["']([^"']+)["']\s*\))
  --glob "*.{ts,tsx,js,jsx}" --glob "!**/node_modules/**"

# Step 2: Resolve relative paths to absolute
# Step 3: Build adjacency list
# Step 4: Detect cycles using depth-limited BFS (max depth: 10)

# Alternative for Node.js projects with madge installed:
npx madge --circular --extensions ts,tsx,js,jsx src/ 2>/dev/null
```

Algorithm (when madge unavailable):
1. Parse all import statements into `{source_file -> [imported_file]}` map
2. Resolve relative imports to absolute paths
3. For each file, BFS through imports with depth limit of 10
4. If BFS revisits the starting file, record the cycle path

**Evidence Format:**
```
Cycle: <file_a> -> <file_b> -> ... -> <file_a>
Length: <number of files in cycle>
Files Involved:
  - <file_path_1>
  - <file_path_2>
```

**Default Severity:** High.

---

### Probe: complexity-hotspots

**Activation:** Any project with source files.

**Detection Method:**

```bash
# Long functions (>50 lines)
# Count lines between function declarations and closing braces
# Heuristic: find function starts and measure to next function or file end
Grep pattern: (function\s+\w+|const\s+\w+\s*=\s*(async\s+)?\([^)]*\)\s*=>|def\s+\w+|func\s+\w+)
  --glob "*.{ts,tsx,js,jsx,py,go,rs}"

# Deep nesting (>4 levels)
# Count leading whitespace indicating nesting depth
# For standard 2-space indent: >8 spaces = >4 levels
# For standard 4-space indent: >16 spaces = >4 levels
Grep pattern: ^(\s{16,}|\t{4,})\S
  --glob "*.{ts,tsx,js,jsx,py,go,rs}"

# Large files (>500 lines)
wc -l src/**/*.{ts,tsx,js,jsx,py,go,rs} 2>/dev/null | awk '$1 > 500 {print $0}'

# Functions with >5 parameters
Grep pattern: (function\s+\w+|def\s+\w+|func\s+\w+)\s*\([^)]*,[^)]*,[^)]*,[^)]*,[^)]*,
  --glob "*.{ts,tsx,js,jsx,py,go,rs}"
```

**Evidence Format:**
```
File: <path> Line: <n>
Hotspot: long-function | deep-nesting | large-file | many-parameters
Metric: <measured_value> (e.g., "73 lines", "6 levels", "612 lines", "8 params")
Threshold: <threshold_value>
```

**Default Severity:** Medium.

---

### Probe: dependency-security

**Activation:** Package manager detected (`package.json`, `requirements.txt`, `Pipfile`, `Cargo.toml`, `go.mod`).

**Detection Method:**

```bash
# Node.js
npm audit --json 2>/dev/null

# Python
pip-audit --format json 2>/dev/null

# Rust
cargo audit --json 2>/dev/null

# Go
govulncheck ./... 2>/dev/null
```

Parse JSON output for vulnerabilities. Focus on:
- Critical severity CVEs
- High severity CVEs
- Vulnerabilities with known exploits

**Evidence Format:**
```
Package: <name>
Version: <installed_version>
CVE: <CVE-ID>
Severity: critical | high | medium | low
Title: <vulnerability title>
Fix Available: <fixed_version or NONE>
```

**Default Severity:** Critical (critical CVEs), High (high CVEs).

---

## Category: `session`

### Probe: gap-analysis

**Activation:** Active session exists (session plan in CLAUDE.md or memory).

**Detection Method:**

```bash
# Step 1: Extract planned items from session plan
# Parse the wave plan for task descriptions and acceptance criteria

# Step 2: Get all changes in current session
git diff --name-only HEAD~<session_commit_count>
git diff --stat HEAD~<session_commit_count>

# Step 3: For each planned item, verify corresponding changes exist
# Match task descriptions against changed files and diff content
git diff HEAD~<session_commit_count> -- <relevant_files>

# Step 4: Check acceptance criteria
# For each acceptance criterion, verify it can be confirmed from the diff
```

**Evidence Format:**
```
Planned Item: <task description>
Status: completed | partial | missing
Evidence: <files changed or NONE>
Acceptance Criteria Met: <list of criteria with pass/fail>
```

**Default Severity:** High.

---

### Probe: hallucination-check

**Activation:** Active session exists.

**Detection Method:**

```bash
# Step 1: Read recent commit messages
git log --oneline -20

# Step 2: For each commit message, extract claims:
# "Added X" -> verify X exists in the codebase
Grep pattern: <claimed_addition>
  --glob "*.{ts,tsx,js,jsx,py,go,rs}"

# "Fixed Y" -> verify the fix is present in the diff
git show <commit_hash> -- <relevant_files>

# "Closes #N" -> verify acceptance criteria from issue #N are met
gh issue view <N> --json body -q '.body'
# or
glab issue view <N>

# Step 3: Cross-reference claims against actual changes
git diff <commit_hash>~1..<commit_hash>
```

**Evidence Format:**
```
Commit: <hash> <message>
Claim: <extracted claim>
Verification: confirmed | UNVERIFIED | contradicted
Evidence: <what was found or not found>
```

**Default Severity:** Critical.

---

### Probe: stale-issues

**Activation:** VCS configured (git remote exists).

**Detection Method:**

```bash
# GitLab: list open issues sorted by last update
glab issue list --per-page 100 | head -50

# GitHub: list open issues sorted by last update
gh issue list --limit 100 --json number,title,labels,updatedAt,assignees --jq '.[] | select(.updatedAt < "<30_days_ago_iso>")'

# Flag:
# - Issues with no activity in stale-issue-days (default: 30 days)
# - Issues assigned but with no associated branch
# - Issues labeled priority:high or priority:critical that are stale

# Check for associated branches:
git branch -r | grep -i "<issue_number>"
```

Session Config field: `stale-issue-days` (default: 30).

**Evidence Format:**
```
Issue: #<number> <title>
Last Updated: <date>
Days Stale: <count>
Assigned To: <assignee or UNASSIGNED>
Has Branch: true | false
Priority: <priority label or NONE>
```

**Default Severity:** Low. Medium if `priority:high` or `priority:critical` is stale.

---

### Probe: issue-dependency-chains

**Activation:** VCS configured (git remote exists).

**Detection Method:**

```bash
# GitLab: fetch issue descriptions and look for cross-references
glab api "projects/<project_id>/issues?state=opened&per_page=100" | python3 -c "
import json, sys, re
issues = json.load(sys.stdin)
for issue in issues:
    refs = re.findall(r'(blocks|depends on|relates to|blocked by)\s+#(\d+)', issue.get('description',''), re.I)
    if refs:
        print(f'#{issue[\"iid\"]}: {refs}')
"

# GitHub: fetch issue bodies and parse cross-references
gh issue list --limit 100 --json number,body --jq '.[] | {number, body}' | python3 -c "
import json, sys, re
for line in sys.stdin:
    issue = json.loads(line)
    refs = re.findall(r'(blocks|depends on|relates to|blocked by)\s+#(\d+)', issue.get('body',''), re.I)
    if refs:
        print(f'#{issue[\"number\"]}: {refs}')
"

# Build dependency graph from parsed relationships
# Detect:
# - Circular chains (A blocks B, B blocks A)
# - Deep chains (>3 levels: A -> B -> C -> D -> ...)
```

**Evidence Format:**
```
Chain: #<a> -> #<b> -> #<c> [-> ...]
Type: circular | deep-chain
Depth: <level count>
Issues Involved:
  - #<number>: <title>
```

**Default Severity:** Medium.
