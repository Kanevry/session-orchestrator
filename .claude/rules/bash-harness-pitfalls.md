---
globs:
  - "**/*.sh"
  - "**/*.bash"
  - scripts/**
  - tests/**
  - .husky/**
tier: wave-only
---

# Bash / Shell-Harness Pitfalls (Path-scoped)

Four recurring bash-harness failure classes, surfaced by a 2026-07-17 live run
of an external E2E-harness repo (ADR-referenced there, anonymized here). Each
one produces a **false-green** result — the harness reports success while the
underlying check silently failed — which is exactly the failure class
`verification-before-completion.md` exists to catch. Treat these as review
checklist items whenever you write or touch a bash script, test-runner shim,
or `.husky/` hook in this repo.

## 1. `grep -c || echo 0` double-print

`grep -c` prints `0` on **no match** AND exits `1` (non-zero exit ≠ nothing
printed). Chaining `|| echo 0` as a fallback then produces `"0\n0"` — two
lines where one number was expected — which silently breaks any numeric
comparison downstream (`[[ "$count" -eq 0 ]]` sees a multi-line string, not an
integer). Confirmed 2× independently in the same harness.

```bash
# BAD — prints "0\n0" on no-match, breaks numeric comparisons
count=$(grep -c "FAIL" report.log || echo 0)

# GOOD — suppress the exit-1 without duplicating grep's own zero-print
count=$(grep -c "FAIL" report.log || true)
```

## 2. stdout-capture pollution in value-returning bash functions

A bash function whose result is consumed via `$(...)` must write progress /
`ok()` / logging lines **only to stderr** (`>&2`). Any `echo` left on stdout
inside such a function contaminates the captured value with log lines —
observed producing a report of `"PASS (0 FAIL)"` despite 4 real FAILs and a
broken application path, because the log lines shifted what the caller parsed
as the verdict.

```bash
# BAD — ok() writes to stdout, polluting the caller's $(...) capture
ok() { echo "  ok: $1"; }
result=$(run_check)   # result now contains "ok: ..." lines, not just the verdict

# GOOD — progress goes to stderr, only the verdict reaches stdout
ok() { echo "  ok: $1" >&2; }
result=$(run_check)   # result is exactly the verdict, nothing else
```

## 3. Aggregate verdicts from files, not captures

Parse total-FAIL / total-PASS counts from a summary artifact written to disk
(e.g. `summary.json`) rather than from the stdout of a report-generating
function. A file is a single, inspectable source of truth; a captured stdout
string is one accidental `echo` away from silent corruption (see #2 above —
the two pitfalls compound).

```bash
# BAD — trusts a live capture that pitfall #2 can silently corrupt
verdict=$(generate_report)
[[ "$verdict" == *"0 FAIL"* ]] && echo "PASS"

# GOOD — read the aggregate from the artifact the report function wrote
generate_report > /dev/null
fail_count=$(jq -r '.fail_count' summary.json)
[[ "$fail_count" -eq 0 ]] && echo "PASS"
```

## 4. `perl -pi` / `-0pi` for multi-line or special-char script surgery

Using `perl -pi -e` (or `-0pi` for multi-line matches) to edit shell scripts
in place is dangerous: a replacement can smear onto foreign lines or leave
garbage before the shebang. One session corrupted 3 files this way, and
`bash -n` (syntax check) can be **blind to the corruption** when it happens to
parse as a comment.

- Use the `Edit` tool's exact-string match for script surgery instead of
  `perl -pi`/`sed -i` for anything beyond a single trivial one-line
  substitution.
- If a file is already corrupted, recover with `git show HEAD:<file> > <file>`
  — **not** `git checkout -- <file>`, which the destructive-command guard
  blocks (see `.claude/rules/parallel-sessions.md` § PSA-003).

## Anti-Patterns

- Piping a possibly-empty `grep -c` result straight into an `[[ -eq ]]` test without `|| true`.
- Any `echo`/`printf` inside a bash function that is ALSO consumed via `$(...)` elsewhere, without redirecting it to `>&2`.
- Trusting a live stdout capture as the sole verdict source for a test harness's PASS/FAIL summary.
- Reaching for `perl -pi`/`sed -i` on multi-line or special-character replacements in `.sh`/`.bash` files instead of an exact-string `Edit`.
- Trusting `bash -n` alone as proof a script edit didn't corrupt content — it only checks syntax, not semantic correctness.

## See Also
testing.md · cli-design.md · verification-before-completion.md · parallel-sessions.md · `skills/test-runner/SKILL.md`
