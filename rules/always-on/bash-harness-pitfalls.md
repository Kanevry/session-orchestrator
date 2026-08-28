<!-- source: session-orchestrator plugin (canonical: rules/always-on/bash-harness-pitfalls.md) -->
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

Six recurring bash-harness failure classes, each surfaced by a live run rather
than by review. Every one produces a **false-green** result — the harness
reports success while the underlying check silently failed — which is exactly
the failure class `verification-before-completion.md` exists to catch. Treat
these as review checklist items whenever you write or touch a shell script, a
test-runner shim, or a git hook.

## 1. `grep -c || echo 0` double-print

`grep -c` prints `0` on **no match** AND exits `1` (non-zero exit ≠ nothing
printed). Chaining `|| echo 0` as a fallback then produces `"0\n0"` — two
lines where one number was expected — which silently breaks any numeric
comparison downstream (`[[ "$count" -eq 0 ]]` sees a multi-line string, not an
integer). Confirmed twice independently in the same harness.

```bash
# BAD — prints "0\n0" on no-match, breaks numeric comparisons
count=$(grep -c "FAIL" report.log || echo 0)

# GOOD — suppress the exit-1 without duplicating grep's own zero-print
count=$(grep -c "FAIL" report.log || true)
```

Note also that `grep -c` counts matching **lines**, not matches — two hits on
one line count as one.

## 2. stdout-capture pollution in value-returning shell functions

A shell function whose result is consumed via `$(...)` must write progress /
logging lines **only to stderr** (`>&2`). Any `echo` left on stdout inside such
a function contaminates the captured value with log lines — observed producing
a report of `"PASS (0 FAIL)"` despite four real FAILs and a broken application
path, because the log lines shifted what the caller parsed as the verdict.

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
string is one accidental `echo` away from silent corruption (see § 2 — the two
pitfalls compound).

```bash
# BAD — trusts a live capture that pitfall 2 can silently corrupt
verdict=$(generate_report)
[[ "$verdict" == *"0 FAIL"* ]] && echo "PASS"

# GOOD — read the aggregate from the artifact the report function wrote
generate_report > /dev/null
fail_count=$(jq -r '.fail_count' summary.json)
[[ "$fail_count" -eq 0 ]] && echo "PASS"
```

## 4. In-place stream editors for multi-line or special-char script surgery

Using `perl -pi -e` (or `-0pi` for multi-line matches) to edit shell scripts in
place is dangerous: a replacement can smear onto foreign lines or leave garbage
before the shebang. One session corrupted three files this way, and `bash -n`
(syntax check) can be **blind to the corruption** when it happens to parse as a
comment.

- Use an exact-string edit for script surgery instead of `perl -pi`/`sed -i`
  for anything beyond a single trivial one-line substitution.
- If a file is already corrupted, recover with `git show HEAD:<file> > <file>`
  — **not** `git checkout -- <file>`, which discards a parallel session's
  uncommitted work (`parallel-sessions.md` § PSA-003).

## 5. `case` patterns inside `$( )` need a leading paren on bash 3.2

macOS `/bin/sh` is bash 3.2, and inside command substitution it parses the
closing paren of a `case` pattern as the end of the `$( )` unless the pattern
carries a **leading** paren. `bash -n` (bash 5) validates the broken form
silently — only `sh -n` catches it. For any `sh`-executed script or git hook
that puts a `case` inside a substitution, `sh -n` is a mandatory second syntax
proof alongside `bash -n`.

```sh
# BAD — bash 3.2 reads the `)` of `foo)` as closing the $( )
x=$(case "$v" in foo) echo a;; esac)

# GOOD — leading paren keeps the pattern unambiguous under bash 3.2
x=$(case "$v" in (foo) echo a;; esac)
```

Measured: an allowlist `case` block in a pre-commit hook where `sh -n` reported
a syntax error near `;;` while `bash -n` exited 0; the `(pattern)` form made
both linters green.

## 6. `${PIPESTATUS[0]}` is EMPTY in zsh — and an empty string reads as success

Agent shells are frequently **zsh**, not bash. zsh spells the array
`$pipestatus` and indexes it from **1**; `${PIPESTATUS[0]}` expands to the empty
string. The damage is not that it fails — it is the DIRECTION in which it
fails: an empty `EXIT=` beside a green-looking log reads as "exit 0", so a
verification step reports a pass it never measured. Fail-open, exactly the class
§ 1 and § 3 name.

```sh
# BAD — prints "EXIT=" (empty) in zsh; a reader sees no failure and moves on
npm test 2>&1 | tail -5; echo "EXIT=${PIPESTATUS[0]}"

# GOOD (portable) — redirect instead of piping, then read $? directly
npm test > /tmp/out.log 2>&1; rc=$?; tail -5 /tmp/out.log; echo "EXIT=$rc"

# GOOD (zsh-only, if you really want the pipeline's first stage)
npm test 2>&1 | tail -5; echo "EXIT=${pipestatus[1]}"
```

Reproduce it:

```
$ false | true; echo "PIPESTATUS[0]='${PIPESTATUS[0]}'  pipestatus[1]='${pipestatus[1]}'"
PIPESTATUS[0]=''  pipestatus[1]='1'
```

Measured: two agents hit this independently in one session, both while
reporting verification exit codes, and both caught it because the empty string
looked wrong rather than because anything failed.

Related but distinct from § 3: there the danger is trusting a live capture over
an artifact; here it is trusting a variable that does not exist in this shell.

## 7. An unquoted variable is NOT word-split in zsh

In bash, `git log -- $paths` splits `$paths` on whitespace into several
pathspecs. In zsh it does not: the whole value arrives as ONE pathspec
containing spaces, which matches nothing — and `git` exits **0** on a pathspec
that matches nothing. Same fail-open direction as § 6. Use an array
(`paths=(a b c); git log -- "${paths[@]}"` / `$paths` in zsh) or `${=paths}` to
opt into splitting explicitly.

## Anti-Patterns

- Piping a possibly-empty `grep -c` result straight into an `[[ -eq ]]` test without `|| true`.
- Any `echo`/`printf` inside a shell function that is ALSO consumed via `$(...)` elsewhere, without redirecting it to `>&2`.
- Trusting a live stdout capture as the sole verdict source for a test harness's PASS/FAIL summary.
- Reaching for `perl -pi`/`sed -i` on multi-line or special-character replacements in `.sh`/`.bash` files instead of an exact-string edit.
- Trusting `bash -n` alone as proof a script edit didn't corrupt content — it only checks syntax, not semantic correctness.
- Validating an `sh`-executed script or git hook with `bash -n` only when it contains a `case` inside `$( )` — bash 5 passes the bash-3.2-broken form; add `sh -n` (§ 5).
- Reporting a verification exit code through `${PIPESTATUS[0]}` — it is empty in zsh, and an empty `EXIT=` beside a green-looking log reads as a pass nobody measured (§ 6).
- Passing an unquoted multi-value variable as a `git` pathspec under zsh and reading the resulting exit 0 as "no matches, all clean" (§ 7).
- Timing an OLD version of a module by copying it to a temp directory and running it there: its relative imports do not resolve, so it dies instantly and the stopwatch reports "fast". Measured: 0.06 s for a crash vs 2.4 s for the real run, which turned a 2x cost into a claimed 40x regression.

## See Also

verification-before-completion.md · parallel-sessions.md · npm-quality-gates.md · test-value.md
