import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, describe, expect, it } from 'vitest';
import { pathMatchesPattern } from '../../scripts/lib/scope-gate.mjs';
import {
  CD_SCRIPT,
  classifyAllOutward,
  collisionVerdict,
  findCollisions,
  findTraps,
  hasSecret,
  pushNeedsConfirm,
  pushRemote,
  redactDeep,
  redactText,
  GITLINKS_SCRIPT,
  gitlinksFromRun,
  REPO_CONFIG_READ,
  repoConfigEntries,
  scopeMatches,
  trapVerdict,
  UNKNOWN_DIR,
} from '../../mods/so-hud/hooks/rules.ts';

describe('Regel-Fallen', () => {
  // Catches: a trap from the rules goes undetected, is filed under the wrong class (a SEC-008 trap
  // filed as `regel` only warns on locker), or the recommended safe recipe is itself caught (then
  // the operator learns to bypass the mod).
  it.each([
    ['claude-p-oauth', 'regel', 'claude -p "fasse zusammen"', 'env -u ANTHROPIC_API_KEY claude -p "fasse zusammen"'],
    ['sec008-env-datei', 'sec008', 'cat .env.local', 'cat .env.example'],
    ['sec008-docker-inspect', 'sec008', 'docker inspect web', "docker inspect -f '{{.State.Status}}' web"],
    ['sec008-secret-argv', 'sec008', 'curl -H "Authorization: Bearer $API_TOKEN" https://api.example.test',
      `printf 'header = "Authorization: Bearer %s"' "$API_TOKEN" | curl --config - https://api.example.test`],
    ['sec008-token-in-url', 'sec008', 'curl "https://api.example.test/v4/user?private_token=$GL_TOKEN"', 'curl "https://api.example.test/v4/user?page=2"'],
    ['sec008-env-dump', 'sec008', 'printenv | grep TOKEN', 'env | cut -s -d= -f1 | sort'],
    ['sec008-echo-secret', 'sec008', 'echo $GITLAB_TOKEN', 'echo "${#GITLAB_TOKEN}"'],
    ['commit-discipline-add', 'regel', 'git add -A', 'git add src/a.ts src/b.ts'],
    ['zsh-pipestatus', 'regel', 'npm test | tail -5; echo "EXIT=${PIPESTATUS[0]}"', 'npm test > /tmp/out.log 2>&1; rc=$?; tail -5 /tmp/out.log; echo "EXIT=$rc"'],
    ['grep-c-echo-0', 'regel', 'n=$(grep -c FAIL log.txt || echo 0)', 'n=$(grep -c FAIL log.txt || true)'],
  ])('%s (%s): caught in the trap, not in its safe recipe', (id, klasse, trapped, safe) => {
    const hit = findTraps(trapped).find(t => t.id === id);
    expect(hit?.klasse).toBe(klasse);
    expect(hit?.fix).toBeTruthy();
    expect(findTraps(safe)).toEqual([]);
  });

  // Catches (#1551 review): a value-printing shape slips past a trap — a bare `$TOKEN`, a secret
  // echoed into a pipe that re-prints it, a `cut`/`awk` filter that keeps the value column, a .env
  // reader other than cat — or a trap fires where the rules' own recipe prints no value.
  it.each([
    ['sec008-env-dump', 'env'],
    ['sec008-env-dump', 'env | cut -d= -f1-'],
    ['sec008-env-dump', 'env | cut -d= -f1,2'],
    ['sec008-env-dump', "env | awk -F= '{print $1, $2}'"],
    ['sec008-echo-secret', 'echo "$TOKEN"'],
    ['sec008-echo-secret', 'echo $SECRET'],
    ['sec008-echo-secret', 'echo $GITLAB_TOKEN | base64'],
    ['sec008-env-datei', 'grep TOKEN .env'],
    ['sec008-env-datei', "awk -F= '{print $2}' .env.local"],
    ['sec008-env-datei', 'cut -d= -f2 .env'],
    ['sec008-env-datei', 'base64 .env'],
    ['sec008-env-datei', 'cat .envrc'],
    ['sec008-env-datei', 'cat deploy/prod.env'],
    ['sec008-env-datei', 'xxd .env-staging'],
    ['sec008-env-datei', 'bash -c "cat .env"'],
    // The class [--z] spans `=`, so the group reaches into the value.
    ['sec008-env-datei', "sed -n 's/^\\([--z]*\\)=.*/\\1/p' .env"],
    ['claude-p-oauth', 'cd x && claude --print hi'],
    // #1551 Opus review F1: a background `&` and an `if` condition hid the reader from the trap;
    // a quoted `&` (a URL) must not cut the segment and lose the token behind it.
    ['sec008-env-datei', 'if cat .env; then :; fi'],
    ['sec008-env-dump', 'true & env'],
    ['sec008-token-in-url', 'curl "https://api.example.test/x?page=2&private_token=$GL_TOKEN"'],
    // #1572 T1/T2: a reader between two comment lines that look like `eval '` … `'` was cut out as a quoted eval nobody
    // walked, and printenv was caught only with exactly one name.
    ['sec008-env-datei', "# eval '\ncat .env\n# '"],
    ['sec008-env-datei', 'flock /tmp/l bash -c "cat .env"'],
    ['sec008-env-dump', 'printenv "x&y" GH_TOKEN'],
    ['sec008-env-dump', 'printenv HOME GH_TOKEN'],
    // #1569 point 1 (W5-R1 F7/F8): a dump was read by word count, so an option, a group or another dumping
    // builtin slipped past; the keys-only filter counted from any later stage, and after `printenv NAME`
    // (which prints no `=`); a secret piped into any command not on the old re-print list passed as consumed.
    ['sec008-env-dump', 'env -0'],
    ['sec008-env-dump', '(env)'],
    ['sec008-env-dump', 'FOO=1 env'],
    ['sec008-env-dump', 'export'],
    ['sec008-env-dump', 'set'],
    ['sec008-env-dump', 'declare -x'],
    ['sec008-env-dump', 'typeset -p'],
    ['sec008-env-dump', 'typeset GITLAB_TOKEN'],
    ['sec008-env-dump', 'printenv GITLAB_TOKEN | cut -d= -f1'],
    ['sec008-env-dump', 'env | tee /dev/stderr | cut -d= -f1'],
    ['sec008-echo-secret', 'echo $TOKEN | perl -pe1'],
    ['sec008-echo-secret', 'echo $TOKEN | python3 -c "import sys; print(sys.stdin.read())"'],
    ['sec008-echo-secret', 'echo $TOKEN | gzip | base64'],
    ['sec008-echo-secret', 'echo $TOKEN | tee /dev/stderr | sha256sum'],
    ['sec008-echo-secret', 'cat <<< "$TOKEN"'],
    ['sec008-echo-secret', 'printf %s "$TOKEN"'],
    ['sec008-env-datei', 'paste .env'],
    ['sec008-env-datei', 'jq -Rr . .env'],
    ['sec008-env-datei', 'tr a b < .env'],
    ['sec008-env-datei', 'cat .env*'],
    ['sec008-env-datei', 'cat .env_prod'],
    // W3 review F1/F2: a login flag on any command (`xargs echo --password-stdin`) counted as a silent consumer, and so
    // did a stage whose last stdout target was /dev/null although stderr (`xargs ls`) or zsh MULTIOS (`>&2 >/dev/null`) printed it.
    ['sec008-echo-secret', 'echo "$GITLAB_TOKEN" | xargs echo --password-stdin'],
    ['sec008-echo-secret', 'echo "$GITLAB_TOKEN" | xargs echo login --stdin'],
    ['sec008-echo-secret', 'xargs echo --password-stdin <<< "$GITLAB_TOKEN"'],
    ['sec008-echo-secret', 'echo "$GITLAB_TOKEN" | xargs ls >/dev/null'],
    // second review: an fd-3 copy writes past /dev/null; bash printf prints a bad %d argument on stderr.
    ['sec008-echo-secret', 'echo "$GITLAB_TOKEN" | awk "{print > \\"/dev/fd/3\\"}" 3>&1 >/dev/null 2>&1'],
    ['sec008-echo-secret', 'printf "%d" "$GITLAB_TOKEN" >/dev/null'],
    ['sec008-echo-secret', 'echo "$GITLAB_TOKEN" >&2 >/dev/null'],
    ['sec008-echo-secret', 'echo "$GITLAB_TOKEN" | cat >&2 >/dev/null'],
    ['sec008-echo-secret', 'echo "$GITLAB_TOKEN" | sh -c "cat >/dev/tty" >/dev/null 2>&1'],
    // #1649: the pipeline split cuts a group or loop at its `;`, so the silent first command (`true >/dev/null`, `read`)
    // stood for the whole compound and the `cat` / `echo "$l"` behind it printed the value; a stage whose stdout goes
    // to stderr feeds the pipe nothing.
    ['sec008-echo-secret', 'echo "$T_TOKEN" | { true >/dev/null 2>&1; cat; }'],
    ['sec008-echo-secret', 'echo "$T_TOKEN" | while read -r l; do echo "$l"; done'],
    ['sec008-echo-secret', 'echo "$T_TOKEN" | { read -r x; echo "$x"; }'],
    ['sec008-echo-secret', 'echo "$TOKEN" >&2 | sha256sum'],
    // #1695/#1697: zsh runs the last pipeline stage in the current shell, so a `read` there keeps the value in its
    // variable (and a here-string `read` does in every shell); printing that variable later prints the secret.
    ['sec008-echo-secret', 'echo "$T_TOKEN" | read -r x && echo "$x"'],
    ['sec008-echo-secret', 'echo $T_TOKEN | IFS= read -r l; echo $l'],
    ['sec008-echo-secret', 'echo "$T_TOKEN" | command read -r x; echo "$x"'],
    ['sec008-echo-secret', 'echo "$T_TOKEN" | read -r a b; echo "$b"'],
    ['sec008-echo-secret', 'echo "$T_TOKEN" | read; echo "$REPLY"'],
    ['sec008-echo-secret', 'read -r y <<< "$T_TOKEN"; echo "$y"'],
    ['sec008-echo-secret', 'echo "$T_TOKEN" | read -r x; echo "$x" | read -r y; cat <<< "$y"'],
    // #1696 (pre-existing on main): zsh MULTIOS writes to the file AND the pipe; bash `1<&2` points fd 1 back at stderr.
    ['sec008-echo-secret', 'echo $T_TOKEN >/dev/null | cat'],
    ['sec008-echo-secret', 'echo $T_TOKEN >/dev/null 1<&2'],
    // #1695: the outer shell expands `$x` inside `sh -c "…"` before the call, and eval runs in the current shell.
    ['sec008-echo-secret', 'echo "$T_TOKEN" | read x; sh -c "echo $x"'],
    ['sec008-echo-secret', 'echo "$T_TOKEN" | read x; eval "echo $x"'],
    // #1699: print forms the reader did not know — zsh `print`, a value carried through plain assignments, a function
    // body, `builtin echo`, zsh parameter flags, a read name printed by printenv/declare -p/typeset -p, and an
    // exported read name a single-quoted child prints.
    ['sec008-echo-secret', 'print -r -- $T_TOKEN'],
    ['sec008-echo-secret', 'echo "$T_TOKEN" | read x; print $x'],
    ['sec008-echo-secret', 'x=$T_TOKEN; echo $x'],
    ['sec008-echo-secret', 'x="$T_TOKEN"; y=$x; echo "$y"'],
    ['sec008-echo-secret', 'f() { echo $T_TOKEN; }; f'],
    ['sec008-echo-secret', 'builtin echo "$T_TOKEN"'],
    ['sec008-echo-secret', 'echo ${(U)T_TOKEN}'],
    ['sec008-echo-secret', 'echo ${=T_TOKEN}'],
    ['sec008-echo-secret', 'echo ${~T_TOKEN}'],
    ['sec008-echo-secret', 'echo ${^T_TOKEN}'],
    ['sec008-env-dump', 'echo "$T_TOKEN" | read x; printenv x'],
    ['sec008-env-dump', 'echo "$T_TOKEN" | read x; declare -p x'],
    ['sec008-env-dump', 'echo "$T_TOKEN" | read x; typeset -p x'],
    ['sec008-echo-secret', "echo \"$T_TOKEN\" | read x; export x; sh -c 'echo $x'"],
    // #1706 item 1: curl prints what it was given on stdin when it is verbose or writes out (`%{url}`).
    ['sec008-echo-secret', 'echo "header = $T_TOKEN" | curl -v -K - https://x.test'],
    ['sec008-echo-secret', 'curl --trace-ascii - -K - <<< "header = $T_TOKEN"'],
  ])('%s: %s is caught', (id, command) => {
    expect(findTraps(command).map(t => t.id)).toContain(id);
  });

  it.each([
    "sed -n 's/^\\([A-Z_][A-Z0-9_]*\\)=.*/\\1/p' .env",
    'test -n "${API_TOKEN:-}" && echo "API_TOKEN: set"',
    'printf %s "${API_TOKEN:-}" | shasum -a 256 | cut -c1-12',
    'claude --version',
    "env | awk -F= '{print $1}'",
    "grep -q '^API_TOKEN=' .env",
    'cat .env.template',
    // #1569 point 1: option settings, assignments and commands run under env print no value; the
    // allow-listed consumers read the secret without printing it.
    'set -e',
    'set -euo pipefail',
    'export FOO=bar',
    'env FOO=1 node app.js',
    'declare -i n',
    'echo "$TOKEN" | docker login --password-stdin -u ci registry.example.test',
    'echo "$GH_TOKEN" | gh auth login --with-token',
    'echo "$GL_TOKEN" | glab auth login --stdin',
    'echo $TOKEN | wc -c',
    'echo $TOKEN >/dev/null',
    'sha256sum <<< "$TOKEN"',
    'echo "$TOKEN" | cat >/dev/null 2>&1',
    'echo "$TOKEN" | podman login --password-stdin -u ci registry.example.test',
    'echo "$TOKEN" | helm registry login registry.example.test -u ci --password-stdin',
    'echo "$TOKEN" | crane auth login registry.example.test -u ci --password-stdin',
    // #1649: a bare `read` stage and a silenced plain command stay allowed; a heredoc written into a file prints
    // nothing (guards this common form against a future heredoc reader without a file allowance); `>&1` moves no output.
    'echo "$T_TOKEN" | read -r x',
    'echo "$T_TOKEN" | sha256sum >/dev/null 2>&1',
    'cat > ~/.npmrc <<EOF\n//registry.npmjs.org/:_authToken=${NPM_TOKEN}\nEOF',
    'tee .env >/dev/null <<EOF\nAPI_KEY=$MY_API_KEY\nEOF',
    'cat <<EOF > config.env\nTOKEN=$T_TOKEN\nEOF',
    'echo "$T_TOKEN" 1>&1 | sha256sum',
    // #1695: a read variable that is never printed, read in a middle stage (a subshell in zsh too), or only hashed.
    'git log | while read -r l; do echo "$l"; done',
    'echo "$T_TOKEN" | read -r x; echo "${#x}"',
    'echo "$T_TOKEN" | read -r x | cat; echo "$x"',
    'echo "$T_TOKEN" | read -r x; printf %s "$x" | sha256sum',
    'echo "$T_TOKEN" >/dev/null | sha256sum',
    // #1695: a single-quoted `sh -c` reads `$x` in the child, which never got the unexported variable.
    "echo \"$T_TOKEN\" | read x; sh -c 'echo $x'",
    // #1696: `0<&2` reopens stdin, not stdout; the /dev/null still swallows the echo.
    'echo $T_TOKEN >/dev/null 0<&2',
    // #1699: the new print forms, assignments and function bodies without a secret in them.
    'print hello',
    'x=1; echo $x',
    'f() { ls; }; f',
    'x=$T_TOKEN; echo "${#x}"',
    'echo "$T_TOKEN" | read x; export x; sh -c \'echo "${#x}"\'',
    // #1706 item 1: a quiet curl reads its config from stdin and prints none of it.
    'echo "header = $T_TOKEN" | curl -s -K - https://x.test',
  ])('%s is no trap', command => {
    expect(findTraps(command)).toEqual([]);
  });

  // Catches: only the first trap is returned, so on locker the rule trap in front masks the SEC-008
  // trap behind it and the .env file prints into the transcript.
  it('locker: a rule trap in front does not let a SEC-008 trap through', () => {
    const traps = findTraps('git add -A && cat .env');
    expect(traps.map(t => t.id)).toEqual(['commit-discipline-add', 'sec008-env-datei']);
    const verdict = trapVerdict(traps, 'locker');
    expect(verdict.aktion).toBe('ablehnen');
    expect(verdict.text).toContain('sec008-env-datei');
    expect(verdict.text).toContain('Stattdessen: ');
  });

  // Catches: the profile table drifts from PRD §4 (SEC-008 refuses everywhere, rule traps warn only on locker).
  it.each([
    ['locker', 'git add -A', 'warnen'],
    ['ausgewogen', 'git add -A', 'ablehnen'],
    ['streng', 'git add -A', 'ablehnen'],
    ['locker', 'cat .env', 'ablehnen'],
    ['locker', 'git status', 'laufen'],
  ])('%s + %s → %s', (profil, command, aktion) => {
    expect(trapVerdict(findTraps(command), profil).aktion).toBe(aktion);
  });

  // Catches (#1696): a heredoc with an unquoted delimiter expands a secret into its body and the reader prints it —
  // measured in zsh 5.9 and macOS bash with T_TOKEN=s3cret. Each row is one shape the reverted attempt (2026-10-20)
  // or its two security reviews missed: several heredocs per line, no closing line, delimiters that are no name,
  // quote tracking derailed by `$'…\'…'` or `"${x:-'y'}"`, an unbalanced quote (fail-closed), `<<` decoys in
  // quotes / arithmetic / comments that would swallow the real body, file exemptions reached through a device path,
  // zsh MULTIOS and `1<&2`; plus the bypasses found in self-review (`<<-`, CRLF, `$(…)`, `bash -c`, `read`, taint).
  it.each([
    ['plain', 'cat <<EOF\n$T_TOKEN\nEOF'],
    ['braced', 'cat <<EOF\nx=${T_TOKEN}\nEOF'],
    ['piped into a printer', 'cat <<EOF | base64\n$T_TOKEN\nEOF'],
    ['two on one command, secret in B', 'cat <<A <<B\na\nA\n$T_TOKEN\nB'],
    ['two commands on one line, secret in B', 'cat <<A; cat <<B\na\nA\n$T_TOKEN\nB'],
    ['no closing line', 'cat <<EOF\n$T_TOKEN'],
    ['delimiter 1', 'cat <<1\n$T_TOKEN\n1'],
    ['delimiter .E', 'cat <<.E\n$T_TOKEN\n.E'],
    ['delimiter @', 'cat <<@\n$T_TOKEN\n@'],
    ['delimiter END!', 'cat <<END!\n$T_TOKEN\nEND!'],
    ['escaped quote in $\'…\'', "echo $'a\\'b'; cat <<A\n$T_TOKEN\nA"],
    ['single quote in "${x:-\'y\'}"', `echo "\${x:-'y'}"; cat <<A\n$T_TOKEN\nA`],
    ['unbalanced single quote (fail-closed)', "echo 'oops; cat <<A\n$T_TOKEN\nA"],
    ['unbalanced double quote (fail-closed)', 'cat <<A "x\n$T_TOKEN\nA'],
    ['decoy <<\'B\' in double quotes', `echo "x <<'B'"; cat <<A\n$T_TOKEN\nA\nB`],
    ['decoy in $((…))', `: $((1<<'B')); cat <<A\n$T_TOKEN\nA\nB`],
    ['decoy in $[…]', `: $[1<<'B']; cat <<A\n$T_TOKEN\nA\nB`],
    ['decoy in a comment', `true # <<'B'\ncat <<A\n$T_TOKEN\nA\nB`],
    ['file exemption via //dev/stdout', 'cat >//dev/stdout <<EOF\n$T_TOKEN\nEOF'],
    ['file exemption via ./../dev/stdout', 'cat >./../dev/stdout <<EOF\n$T_TOKEN\nEOF'],
    ['file exemption via ~/../../dev/fd/1', 'cat >~/../../dev/fd/1 <<EOF\n$T_TOKEN\nEOF'],
    ['file exemption via //proc/self/fd/1', 'cat >//proc/self/fd/1 <<EOF\n$T_TOKEN\nEOF'],
    ['tee //dev/stderr', 'tee //dev/stderr >/dev/null <<EOF\n$T_TOKEN\nEOF'],
    ['tee without a silenced stdout', 'tee .env <<EOF\n$T_TOKEN\nEOF'],
    ['zsh MULTIOS: file and pipe', 'cat >o <<EOF | cat\n$T_TOKEN\nEOF'],
    ['bash 1<&2 after a file', 'cat >o 1<&2 <<EOF\n$T_TOKEN\nEOF'],
    ['/dev/stdout target', 'cat <<EOF >/dev/stdout\n$T_TOKEN\nEOF'],
    ['$-target', 'cat <<EOF >"$OUT"\n$T_TOKEN\nEOF'],
    ['<<- with tabs', 'cat <<-EOF\n\t$T_TOKEN\n\tEOF'],
    ['CRLF line ends', 'cat <<EOF\r\n$T_TOKEN\r\nEOF\r\n'],
    ['inside $(…)', 'echo "$(cat <<EOF\n$T_TOKEN\nEOF\n)"'],
    ['inside bash -c \'…\'', "bash -c 'cat <<EOF\n$T_TOKEN\nEOF'"],
    ['read from the heredoc, printed later', 'read -r x <<EOF\n$T_TOKEN\nEOF\necho "$x"'],
    ['a read-tainted variable in the body', 'echo "$T_TOKEN" | read x; cat <<EOF\n$x\nEOF'],
    ['a shell runs the body (prints the value as an error)', 'bash <<EOF\n$T_TOKEN\nEOF'],
    ['a case pattern `)` inside "$(…)"', 'echo "$(case x in x) cat <<A;; esac\n$T_TOKEN\nA\n)"'],
    ['a body line continued past its closing word', 'cat <<EOF\nfoo\\\nEOF\n$T_TOKEN\nEOF'],
    ['a name split by a body line continuation', 'cat <<EOF\n$T_TO\\\nKEN\nEOF'],
    ['a line continuation inside the delimiter word (no quote)', 'cat <<EO\\\nF\n$T_TOKEN\nEOF'],
    ['a literal body without closing line (fail-closed)', "cat <<'EOF'\n$T_TOKEN"],
    // Fix cycle 1 (REFUTE review, measured in bash and zsh): an arithmetic frame closed by `) )`, a raw `{` in
    // `${…}`, `esac` as an argument, `$(` in a delimiter word, `<<-` tabs before the continuation join, and the file
    // exemption reached through `cd` or a `HOME=` assignment.
    ['M1 $((…) ) holds a command, not arithmetic', 'echo $((cat <<EOF\n$T_TOKEN\nEOF\n) )'],
    ['M1 ((…) ) holds a command, not arithmetic', '((cat <<EOF\n$T_TOKEN\nEOF\n) )'],
    ['M2 a raw { inside "${…}"', 'echo "${x:-{}"; cat <<EOF\n$T_TOKEN\nEOF\necho "}"'],
    ['M2 a raw { inside ${…}', 'echo ${x:-{}; cat <<EOF\n$T_TOKEN\nEOF\necho }'],
    ['M3 esac as an argument', 'echo "$(case y in x) echo esac;; y) cat <<EOF\n$T_TOKEN\nEOF\n;; esac)"'],
    ['M3 a nested case right after a pattern', 'echo "$(case z in x) case y in y) echo;; esac;; z) cat <<EOF\n$T_TOKEN\nEOF\n;; esac)"'],
    ['M4 $( in the delimiter word', 'cat <<$(x)\n$\n$T_TOKEN\n$(x)'],
    ['M5 <<- tabs stripped per logical line', 'cat <<-EOF\n\tEO\\\n\tF\n$T_TOKEN\nEOF'],
    ['R2 <<- after a continued line that was only a backslash', 'cat <<-EOF\n\\\n\tEOF\n$T_TOKEN\nEOF'],
    ['M6 file exemption after cd', 'cd /dev; cat > stdout <<EOF\n$T_TOKEN\nEOF'],
    ['M6 file exemption after cd &&', 'cd /dev/fd && cat >1 <<EOF\n$T_TOKEN\nEOF'],
    ['M6 file exemption after HOME=', 'HOME=/dev; cat > ~/stdout <<EOF\n$T_TOKEN\nEOF'],
    // #1706: a verbose or writing-out curl prints its stdin config, a file written and then read back, and a
    // substitution in a body that prints.
    ['#1706.1 curl -v --config -', 'curl -v --config - <<EOF\nheader = "Authorization: Bearer $T_TOKEN"\nEOF'],
    ['#1706.1 curl -K - -w', 'curl -K - -w "%{url}" <<EOF\nurl = "https://x.test/?t=$T_TOKEN"\nEOF'],
    ['#1706.2 a written file read back', 'cat > .npmrc <<EOF\n//registry/:_authToken=${NPM_TOKEN}\nEOF\ncat .npmrc'],
    ['#1706.3 $(printenv …) in a printed body', 'cat <<EOF\n$(printenv T_TOKEN)\nEOF'],
    // #1706 item 6: a plain `cd` keeps the exemption now, so the device directory must still be told apart behind `.`.
    ['#1706.6 cd /./dev', 'cd /./dev; cat > stdout <<EOF\n$T_TOKEN\nEOF'],
    // Fix cycle W2 (REFUTE review): APFS reads `/DEV` as `/dev`, zsh `cd old new` swaps a part of the cwd, CDPATH
    // turns a relative `cd` into a device directory, and `source` runs the written file it names.
    ['W2 cd /DEV (case-insensitive device root)', 'cd /DEV && cat > stdout <<EOF\n$T_TOKEN\nEOF'],
    ['W2 cd /Dev/Fd (case-insensitive device root)', 'cd /Dev/Fd && cat > 1 <<EOF\n$T_TOKEN\nEOF'],
    ['W2 zsh cd old new', 'cd /tmp && cd tmp dev && cat > stdout <<EOF\n$T_TOKEN\nEOF'],
    ['W2 CDPATH redirects a relative cd', 'CDPATH=/dev cd fd && cat > 1 <<EOF\n$T_TOKEN\nEOF'],
    ['W2 export CDPATH', 'export CDPATH=/dev; cd fd && cat > 1 <<EOF\n$T_TOKEN\nEOF'],
    // Sourced, the body line runs and prints the value as `command not found: <value>`.
    ['W2 a written file sourced', 'cat > x.sh <<EOF\n$T_TOKEN\nEOF\nsource x.sh'],
    ['W2 a written file run by .', 'cat > x.sh <<EOF\n$T_TOKEN\nEOF\n. ./x.sh'],
    ['W2 curl -w with a variable format', 'curl -K - -w "$FMT" <<EOF\nurl = "https://x.test/?t=$T_TOKEN"\nEOF'],
    ['W2 curl -w from a file', 'curl -K - -w @fmt.txt <<EOF\nurl = "https://x.test/?t=$T_TOKEN"\nEOF'],
    ['W2 curl --write-out=%{json}', 'curl -K - --write-out=%{json} <<EOF\nurl = "https://x.test/?t=$T_TOKEN"\nEOF'],
    ['W2 curl -sw%{url_effective}', 'curl -K - -sw%{url_effective} <<EOF\nurl = "https://x.test/?t=$T_TOKEN"\nEOF'],
    ['W2 curl -w %header{…} beside a quiet variable', 'curl -K - -w "%{http_code} %header{x}" <<EOF\nurl = "https://x.test/?t=$T_TOKEN"\nEOF'],
    // Fix cycle W3: zsh's `cdpath` array is tied to CDPATH, `${CDPATH:=…}` assigns while it expands, and curl 8.x
    // takes `--expand-write-out` for `--write-out`.
    ['W3 zsh cdpath array', 'cdpath=(/dev); cd fd && cat > 1 <<EOF\n$T_TOKEN\nEOF'],
    ['W3 ${CDPATH:=…} assigns while expanding', ': ${CDPATH:=/dev}; cd fd && cat > 1 <<EOF\n$T_TOKEN\nEOF'],
    ['W3 curl --expand-write-out %{url_effective}', 'curl -K - --expand-write-out "%{url_effective}" <<EOF\nurl = "https://x.test/?t=$T_TOKEN"\nEOF'],
  ])('heredoc: %s is caught', (_name, command) => {
    expect(findTraps(command).filter(t => t.klasse === 'sec008').map(t => t.id)).toEqual(['sec008-echo-secret']);
  });

  // Catches (#1696): the heredoc reader blocks a common file write on every profile (trapVerdict), or reads a literal
  // body (quoted delimiter), a length `${#…}`, an escaped `\$` or a silent consumer as printing the value.
  it.each([
    'cat > ~/.npmrc <<EOF\n//registry.npmjs.org/:_authToken=${NPM_TOKEN}\nEOF',
    'tee .env >/dev/null <<EOF\nAPI_KEY=$MY_API_KEY\nEOF',
    'cat <<EOF > config.env\nTOKEN=$T_TOKEN\nEOF',
    'cat >> ./out/app.env <<EOF\nTOKEN=$T_TOKEN\nEOF',
    "cat <<'EOF'\n$T_TOKEN\nEOF",
    'cat <<"EOF"\n$T_TOKEN\nEOF',
    'cat <<\\EOF\n$T_TOKEN\nEOF',
    "cat <<'A' <<'B'\n$T_TOKEN\nA\n$T_TOKEN\nB",
    'cat <<EOF\n${#T_TOKEN}\nEOF',
    'cat <<EOF\n\\$T_TOKEN\nEOF',
    'cat <<EOF | sha256sum\n$T_TOKEN\nEOF',
    'cat <<A <<B\nx\nA\ny\nB',
    `echo "x <<B"; echo $((1<<2)); echo $'a\\'b' "\${x:-'y'}" # it's`,
    // #1706: a quiet curl, a written file no other command names, and a `cd` into a plain directory (item 6).
    'curl -K - <<EOF\nheader = "Authorization: Bearer $T_TOKEN"\nEOF',
    'cat > .npmrc <<EOF\n//registry/:_authToken=${NPM_TOKEN}\nEOF\nnpm whoami',
    'cat > ~/.npmrc <<EOF\n//registry/:_authToken=${NPM_TOKEN}\nEOF\nchmod 600 ~/.npmrc',
    'cd ~/repo && cat > .env <<EOF\nT=$T_TOKEN\nEOF',
    // Fix cycle W2: a `-w` / `--write-out` whose format prints only status and timing reads the config silently —
    // 11 of 28 new corpus traps after #1706 were this recipe.
    'printf "header = a: %s" "$S_TOKEN" | curl -s -K - -o /dev/null -w "%{http_code}" https://x.test',
    "curl -s -K - --write-out '%{time_total}\\n' https://x.test <<EOF\nheader = \"a: $T_TOKEN\"\nEOF",
    'curl -s -K - -o /dev/null -w "%{http_code} %{size_download} %%" https://x.test <<EOF\nheader = "a: $T_TOKEN"\nEOF',
    'curl -s -K - -o /dev/null --expand-write-out "%{http_code}" https://x.test <<EOF\nheader = "a: $T_TOKEN"\nEOF',
  ])('heredoc: %j is no trap', command => {
    expect(findTraps(command)).toEqual([]);
  });
});

// The push configuration of a repository nobody configured for pushing (#1569): every read ran, nothing set.
const STANDARD_CONFIG = { push: [], remotePush: [], remoteMirror: null, remotePushDefault: null, branchPushRemote: null, submoduleRecurse: null };

describe('Außenwirkung', () => {
  // Catches: a merge, push, publish, release or deploy slips through unclassified, or a read-only
  // command / a --dry-run is held as if it acted outside.
  it.each([
    ['glab mr merge 54 --squash', 'merge'],
    ['gh release create v1.0.0', 'release'],
    ['git -C ~/Projects/x push origin main', 'push'],
    ['pnpm publish --no-git-checks', 'publish'],
    ['cargo publish', 'publish'],
    ['npx vercel --prod', 'deploy'],
    ['supabase db reset --linked', 'deploy'],
    ['fly deploy', 'deploy'],
    ['railway up', 'deploy'],
    ['git push --dry-run origin main', null],
    ['pnpm publish --dry-run', null],
    ['glab mr list', null],
    ['supabase migration list --linked', null],
    ['vercel ls', null],
    // #1551 review: ordinary shapes that hid the action from the parser.
    ['git \\\npush origin main', 'push'],
    ['git --git-dir /x/.git push origin main', 'push'],
    ['git --work-tree /x --namespace n push origin main', 'push'],
    ["sh -c 'git push origin main'", 'push'],
    ['zsh -lc "nice -n 5 git push origin main"', 'push'],
    ['eval "git push origin main"', 'push'],
    ['eval git push origin main', 'push'],
    ['gh api -X PUT repos/o/r/pulls/1/merge', 'merge'],
    ['glab api --method put projects/1/merge_requests/2/merge', 'merge'],
    ['gh api repos/o/r/pulls/1/merge -f merge_method=squash', 'merge'],
    ['gh api repos/o/r/pulls/1/merge', null],
    ["gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'", 'merge'],
    ['npm -w pkg publish', 'publish'],
    ['npm --workspace=pkg publish', 'publish'],
    ['pnpm --filter x publish', 'publish'],
    ['pnpm -F x publish', 'publish'],
    ['yarn workspace x npm publish', 'publish'],
    ['yarn workspace x publish', 'publish'],
    ['npm help publish', null],
    ['npx --yes npm publish', 'publish'],
    ['npx -y vercel --prod', 'deploy'],
    ['timeout -s KILL 5m git push origin main', 'push'],
    // #1551 cycle 3: a later --no-dry-run (or -n as an option's value) turns the dry run off again.
    ['git push --dry-run --no-dry-run origin HEAD:main3', 'push'],
    ['git push -o -n origin main', 'push'],
    ['npm publish --dry-run --no-dry-run', 'publish'],
    ['git-push origin main', 'push'],
    ['gh api -X POST repos/o/r/merges -f base=main -f head=feat', 'merge'],
    ['gh api graphql -F query=@mutation.graphql', 'merge'],
    ['gh api graphql --input body.json', 'merge'],
    ['gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc', 'push'],
    ['gh api repos/o/r/git/refs -f ref=refs/heads/main -f sha=abc', 'push'],
    // #1551 Opus review F1: a background `&`, `|&`, a control-flow keyword or a redirection in front
    // of the command hid the action behind it.
    ['true & git push origin main', 'push'],
    ['sleep 0 & git push origin main', 'push'],
    ['true & npm publish', 'publish'],
    ['true & gh pr merge 1', 'merge'],
    ['true |& git push origin main', 'push'],
    ['if git push origin main; then :; fi', 'push'],
    ['while git push origin main; do :; done', 'push'],
    ['until git push origin main; do :; done', 'push'],
    ['if false; then :; elif git push origin main; then :; fi', 'push'],
    ['git 2>/dev/null push origin main', 'push'],
    ['>/dev/null git push origin main', 'push'],
    // F3: glab's alias of `mr merge`.
    ['glab mr accept 5', 'merge'],
    // F2: a contents/commits write with the field branch=main lands on the default branch.
    ['gh api repos/o/r/contents/f -X PUT -f branch=main -f message=x -f content=eA==', 'push'],
    ['glab api -X POST projects/1/repository/commits -f branch=main', 'push'],
    ['gh api -X PUT repos/o/r/contents/f -F branch=refs/heads/main', 'push'],
    // F5: caffeinate runs the command it is given; -t takes a value.
    ['caffeinate -i git push origin main', 'push'],
    ['caffeinate -t 5 git push origin main', 'push'],
    // #1569 L2: a leading input redirection (or one between git and push) hid the command: no hit at all.
    ['</dev/null git push origin main', 'push'],
    ['< /dev/null git push origin main', 'push'],
    ['0<in git push origin main', 'push'],
    ['<<<x git push origin main', 'push'],
    ['<>f git push origin main', 'push'],
    ['3<&0 git push origin main', 'push'],
    ['git </dev/null push origin main', 'push'],
  ])('%s → %s', (command, kind) => {
    expect(classifyAllOutward(command)[0]?.kind ?? null).toBe(kind);
  });

  // Catches (#1551 cycle 3): a push hidden in a shape the word reader cannot read runs unasked —
  // command substitution, a function, a shell by path or with options before -c, xargs, an alias,
  // ANSI-C quoting, a subcommand from a variable — or a readable safe push in front masks it.
  const facts = { current: 'feat/x', upstream: 'origin/feat/x', remote: 'origin', remoteUrlKnown: true, tagRefs: [], pushConfig: STANDARD_CONFIG, sourceRefs: ['refs/heads/feat/x'] };
  it.each([
    'out=$(git push origin main 2>&1); echo "$out"',
    'echo $(git push origin main)',
    'echo `git push origin main`',
    'f() { git push origin main; }; f',
    "/bin/bash -c 'git push origin main'",
    "/usr/bin/env bash -c 'git push origin main'",
    'bash -euo pipefail -c "git push origin main"',
    'bash -c -- "git push origin main"',
    "xargs -n1 bash -c 'git push origin main' _",
    "git -c alias.x='push origin HEAD:main2' x",
    "git $'\\x70ush' origin main",
    'p=push; git $p origin main',
    'ssh host git push origin main',
    'git push origin feat/x && echo $(git push origin main)',
  ])('unreadable %s asks', command => {
    expect(classifyAllOutward(command).some(hit => pushNeedsConfirm(hit, facts))).toBe(true);
  });

  // Catches (#1570, #1572): an outward action behind a wrapper or option the walker does not know, a `-c` shell that is
  // not the first word, a shell fed on stdin, another interpreter, or a `case` branch formed no hit at all, so it ran
  // unasked (measured 2026-10-12 against real bare remotes). The fallback asks for an outward word no hit was formed for.
  it.each([
    'time -p git push origin main',
    'command -p git push origin main',
    'exec -a x git push origin main',
    'nohup -- git push origin main',
    'env -P /usr/bin git push origin main',
    'xcrun git push origin main',
    'doas git push origin main',
    'stdbuf -o0 git push origin main',
    'script -q /dev/null git push origin main',
    'coproc git push origin main',
    'noglob git push origin main',
    'trap "git push origin main" EXIT',
    'flock /tmp/l bash -c "git push origin main"',
    'stdbuf -o0 bash -c "git push origin main"',
    "sh <<<'git push origin main'",
    'echo git push origin main | sh',
    "python3 -c \"import subprocess; subprocess.run(['git', 'push', 'origin', 'main'])\"",
    "node -e \"require('child_process').execSync('git push origin main')\"",
    'lockf /tmp/l npm publish',
    'stdbuf -o0 vercel --prod',
    'doas glab mr merge 5',
    "# bash -c '\ngit push origin main\n# '",
    'case x in a|x) git push origin main;; esac',
    'case x in x) supabase db push;; esac',
    'case x in x) railway up;; esac',
  ])('fallback: %s asks', command => {
    expect(classifyAllOutward(command).some(hit => pushNeedsConfirm(hit, facts))).toBe(true);
  });

  // Catches (#1574, the fallback's price): text that only mentions an outward action — a commit message, Claude Code's
  // own `$(cat <<'EOF' … EOF)` recipe, a heredoc body, a comment, a grep pattern, an analysis script — asking on every
  // call, so the gate gets clicked through unread. Measured over 228,541 transcript commands: see the PR.
  const runFacts = { ...facts, hooks: false, repoConfig: [], gitlinks: false };
  it.each([
    'git commit -m "docs: explain why git push asks" && git push origin feat/x',
    "git commit -m \"$(cat <<'EOF'\nfix: gate\n\nnpm publish and git push origin main are documented\nEOF\n)\" && git push origin feat/x",
    "git commit -F - <<'EOF'\nfix: x\n\n- git push origin main stays held\nEOF\ngit push origin feat/x",
    "gh pr create --title x --body \"$(cat <<'EOF'\nmerge after vercel --prod\nEOF\n)\"",
    'echo "run git push origin main later"',
    "grep -E 'git push|vercel --prod' log.txt | head",
    '# deploy notes: npm publish later\ngit status',
    "node -e \"const a = []; a.push('git'); console.log(a)\"",
    "python3 - <<'EOF'\nprint('git push origin main')\nEOF",
    'pnpm install --prod',
    'npm ci --production',
    './deploy.sh --help',
    'npm help publish',
    'supabase db push --dry-run',
  ])('%s still runs', command => {
    expect(classifyAllOutward(command).some(hit => pushNeedsConfirm(hit, runFacts))).toBe(false);
  });

  // Catches (#1574): the data readings above reaching a body that runs — an unquoted delimiter with `$(…)`, a shell or
  // interpreter reading the heredoc, a substitution with a second command, `cat` piped into a shell, a quoted pipe
  // feeding a shell, an interpreter on a line that can start a process.
  it.each([
    'git commit -F - <<EOF\n$(git switch main)\nEOF\ngit push origin feat/x',
    "bash <<'EOF'\ngit push origin main\nEOF",
    "git commit -m \"$(cat <<'EOF'\nmsg\nEOF\ngit switch main)\" && git push origin feat/x",
    "cat <<'EOF' | sh\ngit push origin main\nEOF",
    'echo "git push origin main|x" | sh',
    "node - <<'EOF'\nrequire('child_process').execSync('git push origin main')\nEOF",
    'bash -c "$(cat <<\'EOF\'\ngit push origin main\nEOF\n)"',
    // eval parses its words again: the message, and a quoted word behind it, are code.
    "eval git commit -m \"$(cat <<'EOF'\nx; git push origin main\nEOF\n)\"",
    "eval git commit -m 'a; flock /tmp/l git push origin main'",
    // git subcommands that run the shell command they are given.
    "git rebase -x 'flock /tmp/l git push origin main' HEAD~1",
    "git submodule foreach 'git push origin main'",
    // a heredoc written to a file and run on the same line.
    "cat > /tmp/p.sh <<'EOF'\nflock /tmp/l git push origin main\nEOF\nsh /tmp/p.sh",
  ])('a body that runs still asks: %s', command => {
    expect(classifyAllOutward(command).some(hit => pushNeedsConfirm(hit, runFacts))).toBe(true);
  });

  // Catches (#1571): a variable set without `NAME=` — a zsh element `HOME[1,-1]=`, `env -u HOME` — or a command or git
  // subcommand built from a variable (`${X}t`, `git ${X}sh`) passed the variable allowlist and the walker: the push ran.
  it.each([
    'HOME[1,-1]=/tmp/x git push origin feat/x',
    'path[1]=/tmp/x git push origin feat/x',
    'env -u HOME git push origin feat/x',
    'X=gi; ${X}t push origin feat/x',
    'X=pu; git ${X}sh origin feat/x',
  ])('%s asks', command => {
    expect(classifyAllOutward(command).some(hit => pushNeedsConfirm(hit, runFacts))).toBe(true);
  });
  // Catches (#1571): `read`, `printf -v`, `mapfile` and a nameref set GIT_CONFIG_* or HOME by name; today the command in
  // front of the push asks on its own, so the push records the name to stay held if that rule ever relaxes.
  it.each([
    ['set -a; read -r GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 <<< "1 x"; git push origin feat/x', 'GIT_CONFIG_COUNT'],
    ['printf -v HOME %s /tmp/x; git push origin feat/x', 'HOME'],
    ['mapfile -t GIT_DIR < f; git push origin feat/x', 'GIT_DIR'],
    ['declare -n r=HOME; r=/tmp/x; git push origin feat/x', 'HOME'],
  ])('%s records %s as set', (command, name) => {
    expect(classifyAllOutward(command).at(-1)?.gitConfig).toContain(name);
  });

  it.each([
    'grep -rn "git push" docs/',
    'git log --oneline $(git merge-base HEAD origin/main)..HEAD',
    'echo "$(date)"',
    'git diff --name-only | xargs npx eslint',
    // #1551 Opus review: `>&`, `&>` are no background `&`; a branch field other than main, or a GET, writes nothing.
    'npm test 2>&1 | tail -5',
    'cmd &> log.txt',
    'gh api repos/o/r/contents/f -X PUT -f branch=feat/x -f message=x',
    'glab api -X POST projects/1/repository/commits -f branch=feat/x',
    'gh api -X GET repos/o/r/contents/f -f branch=main',
  ])('%s holds no outward action', command => {
    expect(classifyAllOutward(command)).toEqual([]);
  });

  // Catches: the push is measured in the session folder instead of the one `cd` / `-C` moved to,
  // or a skippable first push hides a second one to main (review R1).
  it('keeps the folder and every hit of the line', () => {
    expect(classifyAllOutward('cd ../repo && gh pr merge 12 --auto')[0]?.dir).toBe('../repo');
    expect(classifyAllOutward('git -C ~/Projects/x push origin main')[0]?.dir).toBe('~/Projects/x');
    expect(classifyAllOutward('git push origin feat && git push origin main')).toHaveLength(2);
  });

  // Catches (#1569 H2): a `cd` that may not have run, or ran in a subshell, background job, pipeline stage,
  // `||` branch, quoted string or behind a prefix, still moved the folder the facts are measured in — the
  // facts came from ../other (feat/x) while git pushed HEAD -> main from the session folder. Such a folder
  // is UNKNOWN_DIR, which no `cd` resolves (the push asks); a plain `cd` keeps working.
  it.each([
    ['(cd ../other && git status >/dev/null) && git push origin HEAD', UNKNOWN_DIR],
    ['( cd ../other ) ; git push -u origin HEAD', UNKNOWN_DIR],
    ['cd ../other & git push origin HEAD', UNKNOWN_DIR],
    ['cd ../other || cd ../third; git push origin HEAD', UNKNOWN_DIR],
    ['(git status; cd ../o) && git push origin HEAD', UNKNOWN_DIR],
    ['(git status; cd ../o; git log) && git push origin HEAD', UNKNOWN_DIR],
    ['test -d x && cd x; git push origin HEAD', UNKNOWN_DIR],
    ['cd ../o || echo no; git push origin HEAD', UNKNOWN_DIR],
    ['cd ../o | cat; git push origin HEAD', UNKNOWN_DIR],
    ['x="; cd ../other;"; git push origin feat/x', UNKNOWN_DIR],
    ['if true; then cd ../o; fi; git push origin HEAD', UNKNOWN_DIR],
    ['pushd ../o >/dev/null; popd; git push origin HEAD', UNKNOWN_DIR],
    ['true || eval "cd ../o"; git push origin HEAD', UNKNOWN_DIR],
    // Depth is not tracked (`(echo }; cd x)` would end a group early), so any `(`/`{` before a cd keeps it unsure.
    ['(cd ../o) && cd sub && git push origin feat/x', UNKNOWN_DIR],
    ['(cd ../o); cd /abs; git push', UNKNOWN_DIR],
    ['cd sub && git push origin feat/x', 'sub'],
    ['cd sub; git push', 'sub'],
    ['test -d x && cd x && git push origin HEAD', 'x'],
    ['cd x && git push origin feat/x &', 'x'],
    ['true & cd /abs; git push', '/abs'],
  ])('%s measures in %s', (command, dir) => {
    expect(classifyAllOutward(command).at(-1)?.dir).toBe(dir);
  });
  it('UNKNOWN_DIR lies below a device, so no cd can enter it', () => {
    expect(UNKNOWN_DIR.startsWith('/dev/null/')).toBe(true);
  });

  // #1673: each linear-time case does 10+ runs of a 50k/100k-character input, so its WALL time — not its
  // growth ratio — is what host load stretches; at load5 40-49 cases hit the default 10 s testTimeout. The
  // verdict stays the growth bound 32 and the 5 s per-run cap below; this only stops the clock from killing a
  // correct measurement. NAMED CEILING (BV-004): 30 s is the testing.md per-test maximum; revisit if a case
  // needs more (then the input sizes, not the timeout, should shrink).
  const LINEAR_TIMEOUT_MS = 30_000;

  // Catches: an unanchored construct regex retrying from every character of a long word — quadratic,
  // 1524 ms on 50k chars (Lead review of !132, P1); the hook budget is 10 s and a timeout refuses the call.
  // Ceiling 250 ms instead of the measured 0.2 ms so a loaded CI host stays green.
  // The coverage job measured 393 ms against the former 250 ms ceiling (main pipeline 28940, 2026-10-16);
  // judged by growth like the cases below, so instrumentation and load no longer decide.
  it('reads a 50k-character word in linear time', { timeout: LINEAR_TIMEOUT_MS }, () => {
    const lineOf = (n) => `echo ${'a'.repeat(n - 10)}`;
    expect(growth(lineOf, 50000, (line) => classifyAllOutward(line))).toBeLessThan(32);
  });

  // Growth ratio instead of a wall-clock ceiling (#622 class): under a parallel full suite on a loaded host
  // the linear cases measured 341-704 ms against a 250 ms ceiling (m5-remote gate, 2026-10-16), and a 4x
  // growth ratio under 10 still flaked at load 41-63 (17.9). Every quadratic regression named below grows
  // ~64x when the input grows 8x, a linear case ~8x; the bound 32 leaves a factor 4 either side. Small and
  // big runs alternate so both sizes see the same load (#1673: measured one after the other, a burst during
  // the big runs alone read 33.3); each size keeps its best run across rounds, and a round of five pairs
  // repeats only while the ratio is still >= 32 — quadratic code stays >= 32 in every round. The 1 ms floor
  // keeps a sub-millisecond small run from inflating the ratio; the 5 s cap stays below the 10 s hook
  // budget whatever the ratio says. NAMED CEILING (BV-004): 4 rounds; revisit if a linear case still reads
  // >= 32 after all 20 pairs — then the load is steady, not a burst, or the code is no longer linear.
  const growth = (lineOf, n, run) => {
    const small = lineOf(n / 8);
    const large = lineOf(n);
    const time = (line) => {
      const started = performance.now();
      run(line);
      return performance.now() - started;
    };
    let bestSmall = Infinity;
    let bestBig = Infinity;
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 5; i++) {
        bestSmall = Math.min(bestSmall, time(small));
        bestBig = Math.min(bestBig, time(large));
      }
      if (bestBig >= 5000 || bestBig / Math.max(bestSmall, 1) < 32) break;
    }
    expect(bestBig).toBeLessThan(5000);
    return bestBig / Math.max(bestSmall, 1);
  };
  const classifyLine = (line) => { for (const hit of classifyAllOutward(line)) pushNeedsConfirm(hit, facts); };

  // Catches: every `$(` or backtick re-reading the whole line — quadratic, about 12 s at 50k characters
  // (317 ms at 8k), past the hook budget, so the gate itself failed and refused the call.
  it.each(['$(', '`', 'xargs ', 'bash ', 'git tag -l && ', 'echo $(git status) && '])('reads 50k characters of %j in linear time', { timeout: LINEAR_TIMEOUT_MS }, unit => {
    const lineOf = (n) => unit.repeat(Math.floor(n / unit.length)) + 'git push origin HEAD';
    expect(growth(lineOf, 50000, classifyLine)).toBeLessThan(32);
  });

  // Catches (#1570/#1574): the fallback, the data view and the quote owners re-reading a growing prefix per unit — a
  // reader judged per `$(cat <<'E' …)` in one quoted word, a terminator search per heredoc, a pipe target per quoted cut.
  it.each(['flock /tmp/l ', '"a|b" ', '# c\n', "cat <<'E'\nE\n", 'x"\n', 'gh api ', 'read -r A ', '"$(case '])('fallback reads 50k characters of %j in linear time', { timeout: LINEAR_TIMEOUT_MS }, unit => {
    const lineOf = (n) => unit.repeat(Math.floor(n / unit.length)) + 'git push origin HEAD';
    expect(growth(lineOf, 50000, classifyLine)).toBeLessThan(32);
  });
  it('the data view reads 50k characters of substitutions in one quoted word in linear time', { timeout: LINEAR_TIMEOUT_MS }, () => {
    const lineOf = (n) => `git commit -m "${"$(cat <<'E'\nE\n)".repeat(Math.floor(n / 15))}" && git push origin HEAD`;
    expect(growth(lineOf, 50000, classifyLine)).toBeLessThan(32);
  });

  // Catches (#1569 M3): a shift() per word in the option skipper, a head regex re-scanning its run to the
  // end (find/env/case), a trailing-group regex retried from every blank — quadratic: at 100k characters
  // 639 ms (x=1) to 15 s (blanks) on 5904a25d, past the hook budget.
  it.each([
    ['npx', ' -y'], ['env', ' -i'], ['', 'env -i '], ['', 'find '], ['', 'case '], ['echo a', ' '], ['x=1', ' x=1'],
  ])('reads 100k characters of %j + %j in linear time', { timeout: LINEAR_TIMEOUT_MS }, (prefix, unit) => {
    const lineOf = (n) => prefix + unit.repeat(Math.floor(n / unit.length)) + ' git push origin HEAD';
    expect(growth(lineOf, 100000, classifyLine)).toBeLessThan(32);
  });

  // Catches (#1649): the group-opener count re-reading the stage per `{` — quadratic on attacker-controlled length.
  it.each(['{ ', '| read -r a ', 'echo "$T_TOKEN" | read -r a; echo "$a"; ', 'x=$T_TOKEN; export x; y=$x; '])('the SEC-008 reader takes 50k characters of %j in linear time', { timeout: LINEAR_TIMEOUT_MS }, unit => {
    const lineOf = (n) => 'echo "$T_TOKEN" | ' + unit.repeat(Math.floor(n / unit.length)) + '\ncat';
    expect(growth(lineOf, 50000, findTraps)).toBeLessThan(32);
  });

  // Catches (#1696): the heredoc reader re-reading the line or the bodies per operator — the reverted attempt took
  // 14.5 s at 50k characters of `cat` + k× `<<A` + k bodies with a secret (quadratic). Every shape must still trap or
  // stay allowed as at full size: past the operator cap fail-closed, below it each body read once.
  it.each([
    ['k operators then k bodies', (k) => 'cat ' + '<<A '.repeat(k) + '\n' + '$T_TOKEN\nA\n'.repeat(k), true],
    ['k two-heredoc lines, quoted', (k) => "cat <<'A' <<'B'\n$T_TOKEN\nA\nB\n".repeat(k) + 'cat <<C\n$T_TOKEN\nC', true],
    ['k file writes', (k) => 'cat >f <<A\n$T_TOKEN\nA\n'.repeat(k), false],
    ['k quotes and decoys', (k) => `echo "<<'B'" $((1<<2)) '"' # <<'B'\n`.repeat(k) + 'cat <<A\n$T_TOKEN\nA', true],
    // #1706: the cd judgement, the read-back name count and the printenv substitution read once, not per heredoc.
    ['k file writes after a cd, printenv and flags in the body', (k) => 'cd a\ncat >f <<A\n$(printenv T_TOKEN) ${(U)T_TOKEN}\nA\n'.repeat(k), false],
  ])('the heredoc reader takes 50k characters of %s in linear time', { timeout: LINEAR_TIMEOUT_MS }, (_name, build, trapped) => {
    const lineOf = (n) => build(Math.max(1, Math.floor(n / 24)));
    expect(findTraps(lineOf(50000)).some(t => t.klasse === 'sec008')).toBe(trapped);
    expect(growth(lineOf, 50000, findTraps)).toBeLessThan(32);
  });
});

describe('pushNeedsConfirm', () => {
  // hooks: false, repoConfig: [], gitlinks: false — measured: no hook can run, no repository key names a program
  // and no submodule can be walked into, so a commit before the push is judged on its words alone.
  const base = { current: 'feat/x', upstream: 'origin/feat/x', remote: 'origin', remoteUrlKnown: true, tagRefs: [], pushConfig: STANDARD_CONFIG, hooks: false, repoConfig: [], gitlinks: false, sourceRefs: ['refs/heads/feat/x'] };
  // Catches: a dangerous push skips the confirmation, an unmeasured fact fails open, or the plain
  // feature-branch push (the everyday case) is held for nothing.
  it.each([
    ['git push', {}, false],
    ['git push origin feat/x', {}, false],
    ['git push origin main', {}, true],
    ['git push', { current: 'main', upstream: 'origin/main' }, true],
    ['git push', { upstream: 'origin/main' }, true],
    ['git push --force', {}, true],
    ['git push --force-with-lease origin feat/x', {}, true],
    ['git push --force-if-includes', {}, true],
    ['git push -uf origin feat/x', {}, true],
    ['git push origin +feat/x', {}, true],
    ['git push --tags', {}, true],
    ['git push --follow-tags', {}, true],
    ['git push origin v1.0', { tagRefs: ['v1.0'], sourceRefs: ['refs/heads/v1.0'] }, true],
    ['git push origin refs/tags/v1.0', {}, true],
    ['git push --delete origin feat/x', {}, true],
    ['git push -d origin feat/x', {}, true],
    ['git push origin :feat/x', {}, true],
    ["git push origin 'feat/*'", {}, true],
    ['git push', { current: null }, true],
    ['git push', { current: 'HEAD' }, true],
    ['git push', { upstream: null }, true],
    ['git push', { remoteUrlKnown: false }, true],
    ['git push', { tagRefs: null }, true],
    ['git switch main && git push', {}, true],
    // #1574: git diff can write the index and fire post-index-change (measured, git 2.56), so a measured hook asks.
    ['git diff && git push origin feat/x', { hooks: true }, true],
    ['git diff --stat && git push origin feat/x', { hooks: null }, true],
    ['git diff && git push origin feat/x', {}, false],
    ['glab mr merge 1', {}, true],
    // #1551 review: shapes reproduced to push main unasked while the facts named feat/x.
    ['git push origin @', {}, true],
    ['git push origin HEAD:heads/main', {}, true],
    ['git push origin refs/for/main', {}, true],
    ['git push origin tag v1', {}, true],
    // cycle 3: a refspec with `:` always asks (allowlist), so this everyday-looking rename now asks too.
    ['git push origin feat/x:refs/heads/feat/y', {}, true],
    ['git push -o merge_request.merge_when_pipeline_succeeds origin feat/x', {}, true],
    ['git push --push-option=ci.skip origin feat/x', {}, true],
    ['git -c remote.origin.push=HEAD:refs/heads/main push origin HEAD', {}, true],
    ['git -c core.quotepath=off push origin feat/x', {}, false],
    ['GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.push GIT_CONFIG_VALUE_0=HEAD:refs/heads/main git push origin HEAD', {}, true],
    ['git --git-dir ../other/.git push origin HEAD', {}, true],
    ['git switch main && git push origin HEAD', {}, true],
    ['bash -c "git switch main && git push origin HEAD"', {}, true],
    ['git tag v2 && git push origin v2', {}, true],
    ['git push --prune', {}, true],
    ['git push --branches', {}, true],
    // #1551 cycle 3, allowlist: options other than -u/-q/-v/--progress, abbreviations, `:`/HEAD
    // refspecs, extra positionals, a URL remote, quote-split words, and git calls before the push ask.
    ['git push --no-verify origin feat/x', {}, true],
    ['git push --no-dry-run origin feat/x', {}, true],
    ['git push --mirr origin', {}, true],
    ['git push --al origin', {}, true],
    ['git push --delet origin feat/x', {}, true],
    ['git push --push-o=x origin feat/x', {}, true],
    ['git push --forc origin feat/x', {}, true],
    ['git push --tag origin feat/x', {}, true],
    ['git push origin HEAD:main3', {}, true],
    ['git push origin feat/x extra', {}, true],
    ['git push git@host:o/r.git feat/x', {}, true],
    ['git push origin "HEAD:ma"in', {}, true],
    ['bash -c "git push origin "main', {}, true],
    ['eval "git push" origin main', {}, true],
    ['git branch -M main && git push', {}, true],
    ['git config branch.feat/x.merge refs/heads/main && git push', {}, true],
    ['git symbolic-ref HEAD refs/heads/main && git push', {}, true],
    ['git -c core.sshCommand=x push origin feat/x', {}, true],
    ['git --exec-path=/tmp/x push origin feat/x', {}, true],
    ['git push -u origin feat/x', {}, false],
    ['git push -q --progress origin refs/heads/feat/x', {}, false],
    ['git status && git branch --show-current && git push origin feat/x', {}, false],
    ['git -c user.name=x -c color.ui=always push origin feat/x', {}, false],
    // #1569 M1: `cat` inside the substitution is a command that is not git, so the bare push now asks.
    ['git add a.ts && git commit -m "$(cat msg.txt)" && git push', {}, true],
    // #1551 Opus review: a redirection is no refspec, a quoted ">" is one; caffeinate is transparent.
    ['git push origin feat/x 2>&1', {}, false],
    ['git push origin feat/x ">" main', {}, true],
    ['caffeinate -i git push origin feat/x', {}, false],
    // #1569 point 3: the usual first push of a branch asked for nothing (usability bug); HEAD is the
    // measured branch, so on main, detached, as a tag name or after a branch move it still asks.
    ['git push origin HEAD', {}, false],
    ['git push -u origin HEAD', {}, false],
    ['git push origin HEAD', { current: 'main', upstream: 'origin/main' }, true],
    ['git push -u origin HEAD', { current: 'master', upstream: null }, true],
    ['git push origin HEAD', { current: 'HEAD' }, true],
    ['git push origin HEAD', { current: null }, true],
    ['git push origin HEAD', { tagRefs: ['feat/x'] }, true],
    ['git push origin refs/heads/HEAD', {}, true],
    ['git checkout main && git push origin HEAD', {}, true],
    // #1569 point 3: HEAD is the measured branch only when every earlier command is a local git call — a
    // command that is not git (here, in a child shell, inside a substitution) may have moved it unseen.
    ['gh pr checkout 5 && git push origin HEAD', {}, true],
    ['./switch.sh && git push origin HEAD', {}, true],
    ['glab mr checkout 3; git push -u origin HEAD', {}, true],
    ['git status && ./switch.sh && git push origin HEAD', {}, true],
    ['echo $(./switch.sh) && git push origin HEAD', {}, true],
    ['bash -c "./switch.sh" && git push origin HEAD', {}, true],
    ['bash -c "./switch.sh && git push origin HEAD"', {}, true],
    ['x=$(y=$(z=$(./switch.sh))) && git push origin HEAD', {}, true],
    // A command after an assignment whose substitution the word reader splits, or one it cannot bound.
    ['h=$(echo x) git switch main && git push origin HEAD', {}, true],
    ['x=$(echo "(") ./switch.sh ")" && git push origin HEAD', {}, true],
    // MR !133 HOCH 2: any command that is not git may write the push config before the push runs
    // (`printf … >> .git/config` mapped feat/x to main), so a named branch asks too; `cd` (measured as
    // the push's folder) and a bare assignment run no command.
    ['npm test && git push origin feat/x', {}, true],
    ["printf '[remote \"origin\"]\\n\\tpush = refs/heads/feat/x:refs/heads/main\\n' >> .git/config; git push origin feat/x", {}, true],
    ['cd sub && x=1 && git push origin HEAD', {}, false],
    // macOS reads `head` as HEAD (measured: `git push origin head` on main printed `head -> main`).
    ['git push origin head', { current: 'main', upstream: 'origin/main' }, true],
    ['git push origin Main', {}, true],
    // Listing tags and restoring files are local steps; creating or deleting a tag, or a checkout
    // that can switch the branch, still asks.
    ['git tag -l && git push origin feat/x', {}, false],
    ['git tag --list && git push origin HEAD', {}, false],
    ['git checkout -- f && git push', {}, false],
    ['git checkout -- a.ts b.ts && git push origin HEAD', {}, false],
    ['git tag v1 && git push origin feat/x', {}, true],
    ['git tag -d x && git push origin feat/x', {}, true],
    ['git tag -l x; git tag y; git push origin feat/x', {}, true],
    ['git tag -l v1 && git push origin feat/x', {}, true],
    ['git checkout main -- f && git push', {}, true],
    ['git checkout -b x && git push origin HEAD', {}, true],
    ['git checkout -- && git push', {}, true],
    // A git call inside a substitution runs before the push: it moved HEAD while the facts named feat/x.
    ['echo $(git switch main) && git push', {}, true],
    ['x=$(git switch main); git push origin HEAD', {}, true],
    ['echo `git switch main` && git push', {}, true],
    ['cat <(git switch main) && git push', {}, true],
    ['echo $(bash -c "git switch main") && git push', {}, true],
    ['/usr/libexec/git-core/git-switch main && git push', {}, true],
    ['h=$(git rev-parse HEAD) && git push origin HEAD', {}, false],
    // A heredoc's apostrophe opened a quote that hid the background `&` and the branch switch behind it.
    ["cat <<EOF\nit's\nEOF\ntrue & git switch main\ngit push", {}, true],
    ["cat <<EOF\nit's\nEOF\ntrue & git switch main\ngit push origin HEAD", {}, true],
    ['2>/dev/null git push origin HEAD', {}, false],
    // #1569 H3: a newline inside a quote no longer resets it (that flipped parity on the next line and hid
    // the background `&`); a construct that nests its own quoting (`$'…'`, `$(…)`) cuts every `&` after it.
    ['git commit -m "msg\nx=1"; git status & git switch main\ngit push origin HEAD', {}, true],
    ['git commit -m "msg\nmore" & git switch main\ngit push', {}, true],
    ["echo $'\\'' & git config remote.origin.mirror true\ngit push origin feat/x", {}, true],
    ['x="$(echo \'"\')" & git config remote.origin.mirror true\ngit push origin feat/x', {}, true],
    ['git commit -m "a & git switch main" && git push origin HEAD', {}, false],
    ["echo 'x & git checkout main' ; git push origin HEAD", {}, true],
    // #1569 M1: a bare push goes where HEAD is, so a command that is not git before it asks like HEAD does.
    ['./switch.sh && git push', {}, true],
    ['node -e "require(\'child_process\').execSync(\'git switch main\')" && git push', {}, true],
    ['npm test && git push', {}, true],
    // #1569 M2a: an assignment or export that is not on the harmless allowlist moves the config git reads.
    ['HOME=/tmp/h git push origin feat/z', {}, true],
    ['export HOME=/tmp/h; git push origin feat/x', {}, true],
    ['XDG_CONFIG_HOME=/tmp/x git push origin feat/x', {}, true],
    ['env HOME=/tmp/h git push origin feat/x', {}, true],
    ['PATH=/tmp/b git push origin feat/x', {}, true],
    ['unset HOME; git push origin feat/x', {}, true],
    ['source ./env.sh && git push origin feat/x', {}, true],
    ['x=1 rc=0 git push origin feat/x', {}, false],
    // Usability (corpus 2026-10-12: about half of the newly asking pushes held a path in a short name or set TZ).
    // (The corpus form ran `TZ=Europe/Vienna date` before the push; a command now asks, HOCH 2 above.)
    ['D=docs/ops && TZ=Europe/Vienna && git push origin feat/x', {}, false],
    ['WT=/tmp/wt L1=x git push origin feat/x', {}, false],
    ['D=main; git push origin $D', {}, true],
    ['HOM=/tmp/h git push origin feat/x', {}, true],
    ['SKIP_PRE_PUSH=1 git push origin feat/x', {}, true],
    // #1569 L1: an earlier git step is local only with the push's own config allowlist.
    ['git -c diff.external=./x diff && git push origin HEAD', {}, true],
    ['git -c color.ui=always diff && git push origin HEAD', {}, false],
    // MR !133 HOCH 1: an earlier fetch, log, show or diff is local only in its plain read-only forms —
    // `--upload-pack` (abbreviated `--upload` too) runs a program, `--output` writes a file (.git/HEAD,
    // .git/config), `--ext-diff`/`--textconv` run configured programs, `--set-upstream` moves the upstream.
    ["git fetch -q --upload-pack='git switch -q main #' . 2>/dev/null; git push origin HEAD", {}, true],
    ['git fetch --upload=true . && git push origin HEAD', {}, true],
    ['git fetch --set-upstream origin main && git push', {}, true],
    ["git fetch 'ext::sh -c x' && git push origin HEAD", {}, true],
    ['git show -s --format="tformat:ref: refs/heads/main" --output=.git/HEAD main -- && git push origin HEAD', {}, true],
    ['git show --output .git/HEAD -s && git push origin HEAD', {}, true],
    ['git diff --output=.git/config && git push origin feat/x', {}, true],
    ['git log -p --ext-diff && git push origin HEAD', {}, true],
    ['git show --textconv HEAD && git push origin HEAD', {}, true],
    // The everyday forms stay local (Bedienpreis: these ran unasked before and must keep running).
    ['git add -A && git commit -m x && git push -u origin HEAD', {}, false],
    ['git fetch && git push origin feat/x', {}, false],
    ['git fetch origin && git push -u origin HEAD', {}, false],
    ['git log --oneline -3 && git push origin HEAD', {}, false],
    ['git status --short && git push origin feat/x', {}, false],
    ['git diff --stat && git push -u origin HEAD', {}, false],
    ['git show --stat HEAD && git push origin HEAD', {}, false],
    // MR !133 (#1569): `hooks` is measured in the push's folder only — a hook step run in another folder
    // fired hooks nobody measured (measured 2026-10-12: a post-commit hook in ../w2 moved the remote's main).
    ['git -C ../w2 commit -m y && git push origin HEAD', {}, true],
    ['git -C ../w2 status && git push origin feat/x', {}, true],
    ['cd ../b && git commit -m x && cd ../a && git push origin feat/x', {}, true],
    ['git commit -m x && git -C ../a push origin feat/x', {}, true],
    // …while a hook step in the push's own folder, however reached, still runs.
    ['git commit -m x && git push origin HEAD', {}, false],
    ['git status && git push', {}, false],
    ['cd sub && git commit -m x && git push origin HEAD', {}, false],
    ['git -C /w/r commit -m x && git -C /w/r push origin HEAD', {}, false],
    // #1573 review HOCH: a step that fires no hook still runs the config of the folder it ran in (`diff.external`,
    // `core.fsmonitor` of /tmp/other), which repoConfig never read — reproduced to a push on main. Compared as written.
    ['git -C /tmp/other diff --stat && git push origin HEAD', {}, true],
    ['cd /tmp/other && git diff; cd /repo && git push origin HEAD', {}, true],
    ['git -C sub log && git push origin HEAD', {}, true],
    ['git -C . log --oneline -1 && git push origin feat/x', {}, true],
    // #1569 L2: a leading input redirection hid the push entirely.
    ['</dev/null git push origin main', {}, true],
    ['</dev/null git push origin feat/x', {}, false],
    ['<<<x git push origin HEAD', {}, false],
  ])('%s %j → %s', (command, overrides, expected) => {
    const hit = classifyAllOutward(command).at(-1);
    expect(pushNeedsConfirm(hit, { ...base, ...overrides })).toBe(expected);
  });

  // Catches (MR !133, #1569): an output redirection on an earlier allowed step (`git log`, `cd`, an
  // assignment, `exec`) writes .git/config or .git/HEAD before the push runs — measured 2026-10-12 in a
  // throwaway repo, the first two moved the remote's main. Output to /dev/null, copies onto stdout or
  // stderr, input redirections and a quoted `>` write nothing and keep running.
  it.each([
    ['git log -1 --format="[remote \\"origin\\"]%n%x09push = refs/heads/feat/x:refs/heads/main" >> .git/config; git push origin feat/x', true],
    ['exec 3>>.git/config; git log -1 --format="[remote \\"origin\\"]%n%x09push = refs/heads/feat/x:refs/heads/main" >&3; git push origin feat/x', true],
    ['git log -1 --format="ref: refs/heads/main" > .git/HEAD && git push origin HEAD', true],
    ['git log -1 --format="ref: refs/heads/main" 1> .git/HEAD && git push origin HEAD', true],
    ['git log -1 --format="ref: refs/heads/main" &> .git/HEAD && git push origin HEAD', true],
    ['git -C . log -1 --format=x > .git/HEAD && git push origin HEAD', true],
    ['git status --short >> .git/config && git push origin feat/x', true],
    ['git status --short>>.git/config && git push origin feat/x', true],
    ['git log -1 --format=x>.git/HEAD && git push origin HEAD', true],
    ['cd . > .git/HEAD; git push origin HEAD', true],
    ['git diff --stat 2>.git/config; git push origin feat/x', true],
    ['h=$(git log -1 --format=x) > .git/HEAD; git push origin HEAD', true],
    ['x=$(git log -1 --format=x >> .git/config); git push origin feat/x', true],
    ['exec > .git/HEAD; git status; git push origin HEAD', true],
    ['git log -1 --format=x > .git/H && git push origin feat/x', true],
    ['git log -1 --format=x >"/dev/null" && git push origin feat/x', true],
    ['git log 1<>.git/config && git push origin feat/x', true],
    ['bash -c "git log -1 --format=x > .git/HEAD"; git push origin HEAD', true],
    ['git log --oneline -3 > /dev/null && git push origin feat/x', false],
    ['git status --short 2>&1 && git push origin feat/x', false],
    ['git fetch 2>/dev/null && git push origin feat/x', false],
    ['git fetch &>/dev/null && git push origin feat/x', false],
    ['exec 3</tmp/x; git push', false],
    ['git commit -m "a > b" && git push origin feat/x', false],
    ['b="$(git rev-parse HEAD 2>/dev/null)" && git push origin feat/x', false],
  ])('output redirection before the push: %s → %s', (command, expected) => {
    expect(classifyAllOutward(command).some(hit => pushNeedsConfirm(hit, base))).toBe(expected);
  });

  // Catches (#1569 point 2): push configuration set by an earlier call routes a plain-looking push
  // elsewhere — push.default other than simple on a push without a refspec, remote.<r>.push mapping
  // even a named branch, a pushRemote/pushDefault naming another remote, mirror, submodule recursion,
  // a push option that merges — or a read that never ran counts as "standard".
  it.each([
    ['git push', { push: [['push.default', 'current']] }, true],
    ['git push', { push: [['push.default', 'matching']] }, true],
    ['git push origin', { push: [['push.default', 'upstream']] }, true],
    ['git push', { push: [['push.default', 'simple']] }, false],
    ['git push origin feat/x', { push: [['push.default', 'current']] }, false],
    // #1569 H1: git reads push.default for a named branch too (upstream: `feat/y -> main`); only current stays.
    ['git push origin HEAD', { push: [['push.default', 'matching']] }, true],
    ['git push -u origin feat/x', { push: [['push.default', 'upstream']] }, true],
    ['git push -u origin feat/x', { push: [['push.default', 'tracking']] }, true],
    ['git push origin feat/x', { push: [['push.default', 'matching']] }, true],
    ['git push origin feat/x', { push: [['push.default', 'nothing']] }, true],
    ['git push origin feat/x', { push: [['push.default', 'bogus']] }, true],
    ['git push origin feat/x', { push: [['push.default', 'simple']] }, false],
    ['git push -u origin HEAD', { push: [['push.default', 'current']] }, false],
    ['git push', { push: [['push.autosetupremote', 'true']] }, false],
    ['git push origin feat/x', { push: [['push.pushoption', 'merge_request.create']] }, true],
    ['git push origin feat/x', { push: [['push.followtags', 'true']] }, true],
    ['git push origin feat/x', { push: [['push.recursesubmodules', 'on-demand']] }, true],
    ['git push origin feat/x', { remotePush: ['refs/heads/feat/x:refs/heads/main'] }, true],
    ['git push', { remotePush: ['HEAD:refs/heads/main', 'refs/tags/*'] }, true],
    ['git push', { remotePushDefault: 'evil' }, true],
    ['git push', { branchPushRemote: 'evil' }, true],
    ['git push', { branchPushRemote: 'origin', remotePushDefault: 'evil' }, false],
    ['git push', { remotePushDefault: 'origin' }, false],
    ['git push origin feat/x', { remotePushDefault: 'evil', branchPushRemote: 'evil' }, false],
    ['git push origin', { remoteMirror: 'true' }, true],
    ['git push origin feat/x', { submoduleRecurse: 'true' }, true],
    ['git push', { remoteMirror: 'false', submoduleRecurse: 'false' }, false],
    ['git push', { remotePushDefault: undefined }, true],
    ['git push', { remotePush: undefined }, true],
    ['git push', { push: [null] }, true],
  ])('%s with push config %j → %s', (command, config, expected) => {
    const hit = classifyAllOutward(command).at(-1);
    expect(pushNeedsConfirm(hit, { ...base, pushConfig: { ...STANDARD_CONFIG, ...config } })).toBe(expected);
  });

  // Catches: a caller from before #1569 (no pushConfig) or a failed config read lets a push run.
  it.each([[undefined], [null]])('pushConfig %s asks', pushConfig => {
    const hit = classifyAllOutward('git push origin feat/x')[0];
    expect(pushNeedsConfirm(hit, { ...base, pushConfig })).toBe(true);
  });

  // Catches (MR !133 MITTEL): a hook fired by an earlier commit (post-commit, reference-transaction, …)
  // switches HEAD or writes push config after the facts were measured; hooks unmeasured count as present.
  it.each([
    ['git commit -m x && git push origin HEAD', true],
    ['git commit -m x && git push origin HEAD', null],
    ['git commit -m x && git push origin HEAD', undefined],
    ['git commit -m x && git push origin feat/x', true],
  ])('%s with hooks %s asks', (command, hooks) => {
    const facts = { ...base, hooks };
    if (hooks === undefined) delete facts.hooks;
    expect(classifyAllOutward(command).some(hit => pushNeedsConfirm(hit, facts))).toBe(true);
  });

  // Catches: the wiring reads the URL of a remote other than the one pushed to.
  it('names the remote the wiring must measure', () => {
    expect(pushRemote(classifyAllOutward('git push upstream feat/x')[0], 'origin')).toBe('upstream');
    expect(pushRemote(classifyAllOutward('git push')[0], 'fork')).toBe('fork');
    expect(pushRemote(classifyAllOutward('git push')[0], null)).toBe('origin');
  });
});

describe('Repository-Konfiguration vor dem Push (#1573)', () => {
  const base = { current: 'feat/x', upstream: 'origin/feat/x', remote: 'origin', remoteUrlKnown: true, tagRefs: [], pushConfig: STANDARD_CONFIG, hooks: false, gitlinks: false, sourceRefs: ['refs/heads/feat/x'] };
  const roots = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  /**
   * A throwaway repo shaped like an everyday clone (remote, tracking branch, husky's core.hooksPath), its
   * global config a file of its own and no system config, so the host's config never decides. Returns what
   * the wiring's read (REPO_CONFIG_READ) measures there after `setup` ran.
   */
  const measure = (setup = () => {}, globalLines = '') => {
    const root = mkdtempSync(join(tmpdir(), 'so-hud-1573-'));
    roots.push(root);
    const repo = join(root, 'r');
    writeFileSync(join(root, 'global.cfg'), globalLines);
    // GIT_DIR, GIT_INDEX_FILE … of a calling git hook would point every call at the outer repository.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
    Object.assign(env, { HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'global.cfg') });
    // An identity that needs no config: with HOME moved, a host whose passwd entry has no name (WSL) cannot commit.
    Object.assign(env, { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'kollege@example.org', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'kollege@example.org' });
    const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' });
    git.env = env;
    execFileSync('git', ['init', '-q', '-b', 'feat/x', repo], { env });
    git('remote', 'add', 'origin', 'git@example.org:team/repo.git');
    git('config', 'branch.feat/x.remote', 'origin');
    git('config', 'branch.feat/x.merge', 'refs/heads/feat/x');
    git('config', 'core.hooksPath', '.husky/_');
    git('config', 'user.email', 'kollege@example.org');
    setup(git);
    return repoConfigEntries(git(...REPO_CONFIG_READ));
  };
  const asks = (command, repoConfig) => classifyAllOutward(command).some(hit => pushNeedsConfirm(hit, { ...base, repoConfig }));

  // Catches (#1573): a key from an earlier call makes the local step before the push run a program, which moves
  // HEAD to main after the facts were measured (measured 2026-10-16, git 2.56.0: with core.fsmonitor set to a
  // script running `git switch main`, `git status --short` left the repo on main) — yet the push ran unasked.
  it.each([
    ['core.fsmonitor', 'git status --short && git push origin HEAD', git => git('config', 'core.fsmonitor', './x')],
    ['diff.external', 'git diff && git push origin HEAD', git => git('config', 'diff.external', './x')],
    ['filter.<x>.clean', 'git add f && git push origin HEAD', git => git('config', 'filter.x.clean', './x')],
    ['filter.<x>.smudge', 'git checkout -- f && git push origin HEAD', git => git('config', 'filter.x.smudge', './x')],
    ['filter.<x>.process', 'git status && git push origin HEAD', git => git('config', 'filter.x.process', './x')],
    ['diff.<x>.textconv', 'git log -p && git push origin HEAD', git => git('config', 'diff.MyDrv.textconv', './x')],
    ['core.sshCommand', 'git fetch && git push origin HEAD', git => git('config', 'core.sshCommand', './x')],
    ['remote.<r>.uploadpack', 'git fetch && git push origin HEAD', git => git('config', 'remote.origin.uploadpack', './x')],
    ['credential.helper', 'git fetch && git push origin HEAD', git => git('config', 'credential.helper', '!./x')],
    ['gpg.program', 'git commit -m x && git push origin HEAD', git => {
      git('config', 'commit.gpgSign', 'true');
      git('config', 'gpg.program', './x');
    }],
    // The included file, not the including one, carries the program key.
    ['core.fsmonitor through include.path', 'git status && git push origin HEAD', git => {
      git('config', '--file', 'inc.cfg', 'core.fsmonitor', './x');
      git('config', 'include.path', '../inc.cfg');
    }],
    ['a worktree-scoped key', 'git status && git push origin HEAD', git => {
      git('config', 'extensions.worktreeConfig', 'true');
      git('config', '--worktree', 'core.fsmonitor', './x');
    }],
  ])('%s set in the repository asks', (_family, command, setup) => {
    const measured = measure(setup);
    expect(measured).not.toBeNull();
    expect(asks(command, measured)).toBe(true);
  });

  // Catches: the allowlist missing a key every clone carries, so each `git status && git push` asks and the gate
  // gets clicked through unread — or the host's global git-lfs filter and credential helper counting as the repo's.
  it.each([
    ['an everyday clone', ''],
    ['global git-lfs filters and a credential helper', '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tprocess = git-lfs filter-process\n[credential]\n\thelper = osxkeychain\n'],
  ])('%s still lets a push behind local steps run', (_name, globalLines) => {
    const measured = measure(undefined, globalLines);
    expect(asks('git status --short && git fetch && git diff && git push origin HEAD', measured)).toBe(false);
  });

  // Catches (#1573 review MITTEL): an allowlisted remote URL in the `<transport>::` form makes `git fetch` start
  // git-remote-<transport> from PATH (only `ext::` is refused by default) — the key passed, the value was never read.
  it.each([
    ['remote.origin.url', 'x::./evil'],
    ['remote.origin.pushurl', 'fd::3'],
  ])('%s = %s asks', (key, value) => {
    expect(asks('git fetch && git push origin HEAD', measure(git => git('config', key, value)))).toBe(true);
  });

  // Catches (#1573 review NIEDRIG): one `git config --global core.fsmonitor ./x` (or a GIT_CONFIG_GLOBAL file, which is
  // what `measure` writes) crossed the gate as cheaply as the local key, because the wide scopes were not judged.
  it.each([
    ['core.fsmonitor', 'git status && git push origin HEAD', '[core]\n\tfsmonitor = ./x\n'],
    ['diff.external', 'git diff && git push origin HEAD', '[diff]\n\texternal = ./x\n'],
    ['core.sshCommand', 'git fetch && git push origin HEAD', '[core]\n\tsshCommand = ./x\n'],
    ['diff.<x>.textconv', 'git log -p && git push origin HEAD', '[diff "x"]\n\ttextconv = ./x\n'],
    ['a filter that is not git-lfs', 'git add f && git push origin HEAD', '[filter "lfs"]\n\tprocess = ./x\n'],
    ['remote.<r>.uploadpack', 'git fetch && git push origin HEAD', '[remote "origin"]\n\tuploadpack = ./x\n'],
    ['uploadpack.packObjectsHook', 'git fetch && git push origin HEAD', '[uploadpack]\n\tpackObjectsHook = ./x\n'],
    ['an unknown credential helper', 'git fetch && git push origin HEAD', '[credential]\n\thelper = !./x\n'],
    ['a rewrite into a transport URL', 'git fetch && git push origin HEAD', '[url "x::./evil"]\n\tinsteadOf = git@example.org:\n'],
    ['gpg.program with signing on, before a commit', 'git commit -m x && git push origin HEAD', '[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = ./x\n'],
    // #1573 second review: `remote.<r>.vcs` routes the remote through git-remote-<vcs> from PATH.
    ['remote.<r>.vcs', 'git fetch && git push origin HEAD', '[remote "origin"]\n\tvcs = foo\n'],
    // #1573 second review: an explicit -S runs gpg.program whatever commit.gpgSign says.
    ['gpg.program, commit -S', 'git commit -S -m x && git push origin HEAD', '[gpg]\n\tprogram = ./x\n'],
    ['gpg.program, commit --gpg-sign=KEY', 'git commit --gpg-sign=ABC -m x && git push origin HEAD', '[gpg]\n\tprogram = ./x\n'],
    ['gpg.ssh.program, commit -aS', 'git commit -aS -m x && git push origin HEAD', '[gpg "ssh"]\n\tprogram = ./x\n'],
    // #1573 input: a signature check in log/show runs gpg.program, and log.showSignature turns a plain log into one.
    ['gpg.program, log --format=%G?', 'git log --format=%G? -1 && git push origin HEAD', '[gpg]\n\tprogram = ./x\n'],
    ['gpg.program, show --show-signature', 'git show --show-signature && git push origin HEAD', '[gpg]\n\tprogram = ./x\n'],
    ['log.showSignature, a plain log', 'git log -1 && git push origin HEAD', '[log]\n\tshowSignature = true\n'],
  ])('global %s asks', (_family, command, globalLines) => {
    expect(asks(command, measure(undefined, globalLines))).toBe(true);
  });

  // Catches: the wide-scope denylist asking for what most hosts set — the fsmonitor daemon, forge credential helpers,
  // a signing program where no commit runs — so every push behind a git step asks and the gate is clicked through.
  it.each([
    ['core.fsmonitor = true', 'git status && git push origin HEAD', '[core]\n\tfsmonitor = true\n'],
    ['the gh and glab credential helpers', 'git fetch && git push origin HEAD', '[credential "https://github.com"]\n\thelper =\n\thelper = !/opt/homebrew/bin/gh auth git-credential\n[credential "https://gitlab.example.org"]\n\thelper = !glab auth git-credential\n'],
    ['gpg.program with signing on, no commit on the line', 'git status && git push origin HEAD', '[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = /usr/local/bin/gpg\n'],
    ['core.pager and core.editor', 'git log && git commit -m x && git push origin HEAD', '[core]\n\tpager = less\n\teditor = vim\n'],
    ['gpg.program, an unsigned commit', 'git commit -m x && git push origin HEAD', '[gpg]\n\tprogram = ./x\n'],
    ['gpg.program, -S undone by --no-gpg-sign', 'git commit -S --no-gpg-sign -m x && git push origin HEAD', '[gpg]\n\tprogram = ./x\n'],
    ['gpg.program, a log without a signature check', 'git log --format=%h%n%s -1 && git push origin HEAD', '[gpg]\n\tprogram = ./x\n'],
  ])('global %s still runs', (_name, command, globalLines) => {
    expect(asks(command, measure(undefined, globalLines))).toBe(false);
  });

  // Catches (#1573 input): a commit that opens core.editor (no message, -e, --amend, -c, --fixup=reword:), reads a patch
  // interactively (interactive.diffFilter, the pager) or an add that does (-p, -i, -e) passed as a local step, and the
  // global and system editor are not judged — whatever program they name ran before the push.
  it.each([
    'git commit',
    'git commit -e -m x',
    'git commit --amend',
    'git commit -c HEAD',
    'git commit --fixup=reword:HEAD',
    'git commit -p -m x',
    'git commit --interactive',
    'git add -p',
    'git add -i',
    'git add -e f',
    'git add --renormalize .',
  ])('%s before a push asks', step => {
    expect(asks(`${step} && git push origin HEAD`, [])).toBe(true);
  });
  // Catches: the option allowlist missing an everyday form, so each commit-and-push asks and gets clicked through.
  it.each(['git commit -am x', 'git commit -sm "x y"', 'git commit --amend --no-edit', 'git commit -q -F msg.txt', 'git commit -m x -- f', 'git add -A src', 'git add -u'])('%s before a push still runs', step => {
    expect(asks(`${step} && git push origin HEAD`, [])).toBe(false);
  });

  // Catches (#1573 input): with CDPATH set, the session's `cd sub` lands in a CDPATH folder while the resolver measured
  // ./sub, so the facts came from another repository than the one the push runs in.
  it('a relative cd resolves no folder while CDPATH is set', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'so-hud-cdpath-')));
    roots.push(root);
    mkdirSync(join(root, 'sub'));
    mkdirSync(join(root, 'other', 'sub'), { recursive: true });
    const cd = (dir, cdpath) => spawnSync('bash', ['-c', CD_SCRIPT, 'so-hud', dir], { cwd: root, env: { PATH: process.env.PATH, HOME: root, ...(cdpath === undefined ? {} : { CDPATH: cdpath }) }, encoding: 'utf8' });
    expect([cd('sub').status, cd('sub').stdout.trim()]).toEqual([0, join(root, 'sub')]);
    expect(cd('sub', join(root, 'other')).status).not.toBe(0);
    for (const dir of ['./sub', '~/sub', join(root, 'sub')]) expect(cd(dir, join(root, 'other')).stdout.trim()).toBe(join(root, 'sub'));
  });

  // Catches (#1573 review MITTEL): an embedded repository `sub/` (gitlink, no .gitmodules) with its own core.fsmonitor
  // runs it during the outer `git status`/`git diff` while every outer key is allowlisted — the count script missing the
  // gitlink, a failed count (no repository) reading as "none", or a gitlink not making the push ask.
  it('counts gitlinks in a real repository and asks behind a git step', () => {
    const counted = { clean: null, nested: null, broken: null };
    measure(git => {
      const run = () => spawnSync('bash', ['-c', GITLINKS_SCRIPT, 'so-hud-gitlinks'], { cwd: git('rev-parse', '--show-toplevel').trim(), env: git.env, encoding: 'utf8' });
      const clean = run();
      counted.clean = gitlinksFromRun(clean.status, clean.stdout);
      git('commit', '-q', '--allow-empty', '-m', 'a');
      git('init', '-q', 'sub');
      // The nested repo has no local identity; a CI runner has no global one either.
      git('-C', 'sub', '-c', 'user.name=Kollege', '-c', 'user.email=kollege@example.org', 'commit', '-q', '--allow-empty', '-m', 's');
      git('add', 'sub');
      const nested = run();
      counted.nested = gitlinksFromRun(nested.status, nested.stdout);
      const broken = spawnSync('bash', ['-c', GITLINKS_SCRIPT, 'so-hud-gitlinks'], { cwd: tmpdir(), env: { ...git.env, GIT_CEILING_DIRECTORIES: tmpdir() }, encoding: 'utf8' });
      counted.broken = gitlinksFromRun(broken.status, broken.stdout);
    });
    expect(counted).toEqual({ clean: false, nested: true, broken: null });
    for (const gitlinks of [true, null, undefined]) {
      expect(classifyAllOutward('git diff && git push origin HEAD').some(hit => pushNeedsConfirm(hit, { ...base, repoConfig: [], gitlinks }))).toBe(true);
    }
  });

  // Catches (#1573 second review, noise): a sparse checkout (core.sparseCheckout, core.sparseCheckoutCone, index.sparse;
  // no program) making every push behind a git step ask, so the gate gets clicked through unread.
  it('a sparse checkout still lets a push behind a git step run', () => {
    const measured = measure(git => {
      git('sparse-checkout', 'init', '--cone');
      git('config', 'index.sparse', 'true');
    });
    expect(measured.map(([, key]) => key)).toEqual(expect.arrayContaining(['core.sparsecheckout', 'core.sparsecheckoutcone', 'index.sparse']));
    expect(asks('git status && git push origin HEAD', measured)).toBe(false);
  });

  // Catches: a failed or unparseable read counted as "nothing set" (fail-open), or a caller from before #1573.
  it.each([
    ['not read', undefined],
    ['a failed read', null],
    ['output without its final NUL', repoConfigEntries('local\0core.bare\nfalse')],
    ['an odd number of fields', repoConfigEntries('local\0core.bare\0local\0')],
  ])('%s asks', (_name, repoConfig) => {
    expect(asks('git status && git push origin HEAD', repoConfig)).toBe(true);
  });
});

describe('Secret-Schild', () => {
  // Built at runtime: the file itself carries no token-shaped literal for gitleaks to flag.
  const tokens = [
    ['GitLab-Token', 'glpat-' + 'x'.repeat(24)],
    ['GitHub-Token', 'ghp_' + 'A'.repeat(36)],
    ['Anthropic-Key', 'sk-' + 'ant-' + 'a'.repeat(30)],
    ['OpenAI-Key', 'sk-' + 'proj-' + 'e'.repeat(40)],
    ['Stripe-Key', 'sk_' + 'live_' + 'c'.repeat(24)],
    ['Stripe-Webhook-Secret', 'whsec_' + 'f'.repeat(24)],
    ['AWS-Access-Key', 'AKIA' + 'B'.repeat(16)],
    ['Slack-Token', 'xoxb-' + '1'.repeat(12)],
    ['Google-API-Key', 'AIza' + 'd'.repeat(35)],
    ['Private Key', '-----BEGIN ' + 'RSA PRIVATE KEY-----\nabc\n-----END RSA ' + 'PRIVATE KEY-----'],
  ];
  // Catches: a token kind reaches model and transcript unredacted, or is labelled as another kind.
  it.each(tokens)('%s is replaced by kind and fingerprint', async (name, token) => {
    expect(hasSecret(token)).toBe(true);
    const hits = [];
    const out = await redactText(`TOKEN=${token}\n`, hits);
    expect(out.includes(token)).toBe(false);
    expect(out).toMatch(new RegExp(`\\[${name} entfernt · sha256:[0-9a-f]{12}\\]`));
    expect(hits.map(h => h.name)).toEqual([name]);
  });

  // Catches: a token nested in structured tool output (arrays, objects) is not walked into.
  it('redactDeep walks arrays and objects and keeps clean values', async () => {
    const token = 'glpat-' + 'y'.repeat(24);
    const out = await redactDeep({ a: [`x ${token}`], b: { c: 'ok', n: 3 } }, []);
    expect(JSON.stringify(out).includes(token)).toBe(false);
    expect(out.b).toEqual({ c: 'ok', n: 3 });
  });
});

describe('Kollisionswächter', () => {
  // Catches: the mod's matcher drifts from SO's own wave-scope matcher, so the guard sees a
  // collision SO would not (or misses one SO enforces). Both answer the same table.
  it.each([
    ['src/a.ts', 'src/a.ts', true],
    ['src/a.tsx', 'src/a.ts', false],
    ['srcxa.ts', 'src.a.ts', false],
    ['src/lib/a.ts', 'src/', true],
    ['srcx/a.ts', 'src/', false],
    ['src/a.ts', 'src/*.ts', true],
    ['src/lib/a.ts', 'src/*.ts', false],
    ['src/a.ts', 'src/**/*.ts', true],
    ['src/x/y/a.ts', 'src/**/*.ts', true],
    ['tests/x/y.mjs', 'tests/**', true],
    ['tests/a.ts', 'src/**/*.ts', false],
    ['src/a.ts', '', false],
  ])('%s vs %s → %s', (rel, pattern, expected) => {
    expect(scopeMatches(rel, pattern)).toBe(expected);
    expect(pathMatchesPattern(rel, pattern)).toBe(expected);
  });

  const peers = [
    { session_id: 'own', gleiches_working_copy: true, scope_paths: ['src/'] },
    { session_id: 'other-wc', gleiches_working_copy: false, scope_paths: ['src/'] },
    { session_id: 'peer', gleiches_working_copy: true, scope_paths: ['docs/', 'src/**'] },
    { session_id: 'abs', gleiches_working_copy: true, scope_paths: ['/w/repo/src/a.ts'] },
    { session_id: 'blind', gleiches_working_copy: true, scope_paths: null },
  ];
  // Catches: the own session or a peer in another working copy is reported, a peer without scope is
  // silently treated as disjoint, an absolute scope entry never matches, or `..` hides the real path.
  it.each(['/w/repo/src/a.ts', '/w/repo/lib/../src/a.ts'])('%s collides with peer and abs', filePath => {
    const result = findCollisions({ filePath, repoRoot: '/w/repo/', ownSessionId: 'own', peers });
    expect(result).toEqual({
      hits: [{ session_id: 'peer', pattern: 'src/**' }, { session_id: 'abs', pattern: '/w/repo/src/a.ts' }],
      unknownScope: ['blind'],
    });
  });

  // Catches: a plain prefix test treats /w/repo-other as inside /w/repo.
  it('a file outside the repo never collides', () => {
    expect(findCollisions({ filePath: '/w/repo-other/src/a.ts', repoRoot: '/w/repo', ownSessionId: 'own', peers }))
      .toEqual({ hits: [], unknownScope: [] });
  });

  // Catches: the per-profile reaction drifts from PRD F8.
  it.each([
    ['locker', 'warnen'],
    ['ausgewogen', 'fragen'],
    ['streng', 'ablehnen'],
  ])('%s → %s', (profil, aktion) => {
    const verdict = collisionVerdict([{ session_id: 'peer', pattern: 'src/**' }], profil);
    expect(verdict.aktion).toBe(aktion);
    if (aktion === 'ablehnen') expect(verdict.text).toContain('Worktree');
    expect(collisionVerdict([], profil)).toEqual({ aktion: 'laufen' });
  });
});
