/**
 * tests/hooks/pre-bash-sessions-ledger-guard.test.mjs
 *
 * Tests for hooks/pre-bash-sessions-ledger-guard.mjs — the mechanical half of
 * GitLab #958 finding 3: a direct shell append to `.orchestrator/metrics/
 * sessions.jsonl` bypasses `scripts/emit-session.mjs`, the writer that
 * validates. Prose already forbade it (`skills/session-end/
 * session-metrics-write.md`) and prose did not stop it.
 *
 * Strategy: spawn the real hook with a real PreToolUse payload on stdin and
 * discriminate on the STDOUT ENVELOPE via expectAllow/expectDeny. Under the
 * #906 exit-0 protocol allow and deny share exit code 0, so a bare
 * `expect(status).toBe(0)` here would be an assert-nothing that passes in both
 * directions — see tests/_helpers/hook-decision.mjs.
 *
 * Each test names the bug it catches; there is no pre-existing local test to
 * consolidate (new file, new hook).
 */

import { describe, it, expect, onTestFinished } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  expectAllow,
  expectDeny,
  expectWarn,
  expectGuardInactive,
} from '../_helpers/hook-decision.mjs';
import { brokenModuleBoot } from '../_helpers/broken-module-boot.mjs';
import { removeTree } from '../_helpers/tmp-fixture.mjs';

const HOOK = resolve(import.meta.dirname, '../..', 'hooks/pre-bash-sessions-ledger-guard.mjs');
const LEDGER = '.orchestrator/metrics/sessions.jsonl';

/**
 * Spawn the hook with a JSON PreToolUse payload on stdin.
 * SO_DISABLED_HOOKS / SO_HOOK_PROFILE are cleared so an operator's ambient
 * bypass cannot silently turn every deny assertion into a vacuous allow.
 *
 * `execArgv` is threaded ahead of the hook path so the #993 late-binding suite
 * can install a `module.register()` loader (via `brokenModuleBoot`) that corrupts
 * a repo dependency at ESM LINK time — the exact failure `armGuard` must render
 * VISIBLE instead of a silent exit-1 / 0-byte disarm.
 */
function runHook({ toolName = 'Bash', command = '', env = {}, execArgv = [], cwd, payloadCwd } = {}) {
  return spawnSync('node', [...execArgv, HOOK], {
    input: JSON.stringify({ tool_name: toolName, cwd: payloadCwd, tool_input: { command } }),
    cwd,
    encoding: 'utf-8',
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, SO_DISABLED_HOOKS: '', SO_HOOK_PROFILE: '', ...env },
  });
}

/**
 * Install a data-URL bootstrap that replaces only the hook's spawnSync binding.
 * The real default `node:child_process` object keeps guard-source-loader's
 * execFileSync intact; syncBuiltinESMExports updates the hook's named import.
 * This follows the existing data-URL bootstrap pattern without replacing the
 * whole builtin module.
 *
 * @param {string} spawnSource - JavaScript function expression for spawnSync
 * @returns {string[]}
 */
function childProcessBoot(spawnSource) {
  const bootstrap = [
    "import childProcess from 'node:child_process';",
    "import { syncBuiltinESMExports } from 'node:module';",
    'const originalSpawnSync = childProcess.spawnSync;',
    `childProcess.spawnSync = ${spawnSource};`,
    'syncBuiltinESMExports();',
  ].join('\n');
  return ['--import', `data:text/javascript;base64,${Buffer.from(bootstrap, 'utf8').toString('base64')}`];
}

describe('pre-bash-sessions-ledger-guard', () => {
  describe('denies a direct write to the ledger', () => {
    it('blocks the #958 shape — a hand-composed record appended with >>', () => {
      // The bug: this exact command class put a schema-invalid record into the
      // ledger. Without the guard it runs and the corruption is silent.
      const env = runHook({ command: `echo '{"session_id":"x"}' >> ${LEDGER}` });
      // The operator must be told the sanctioned path, not just "blocked":
      // a deny whose text carries no route is what agents read as a crash and
      // route around (the #906 failure mode).
      expectDeny(env, [
        'emit-session.mjs',
        'node scripts/check-sessions-integrity.mjs --session-id',
        LEDGER,
      ]);
    });

    it.each([
      ['truncating >', `printf '%s' "$REC" > ${LEDGER}`],
      ['no space before >>', `printf '%s' x >>"${LEDGER}"`],
      ['tee -a in a pipeline', `cat rec.json | tee -a ${LEDGER}`],
      ['cwd-relative after cd', 'cd .orchestrator/metrics && echo x >> sessions.jsonl'],
      ['cp over the ledger', `cp /tmp/backup.jsonl ${LEDGER}`],
      ['a tmp-repo ledger', `echo x > /tmp/repo/${LEDGER}`],

      // ---- MED-1: an apostrophe outside a quoted run used to desync the
      // per-character quote mask for the REST of the command, so the real
      // redirect after it was skipped. All three were DEMONSTRATED to write the
      // ledger while the guard allowed them. `# don't …` is the expected shape
      // of the accident, not an adversarial construction: English prose has
      // apostrophes at a high base rate.
      ['apostrophe in a shell comment', `# don't\necho x >> ${LEDGER}`],
      [
        'apostrophe in a here-doc body',
        `cat <<'EOJ' > /tmp/note.txt\nit's fine\nEOJ\necho '{"a":1}' >> ${LEDGER}`,
      ],
      ['escaped quote in an ANSI-C literal', `echo $'a\\'b' >> ${LEDGER}`],

      // ---- MED-2: the redirect regex captured ONE quoting run, so a target
      // assembled from several was captured wrong (`"$PWD"`, `.orchestrator/
      // metrics/`, `/Users/me/My\`, `"."`) and its ledger tail never examined.
      // Two of the four contain no variable at all.
      ['a target that starts with a quoted run', `echo x >> "$PWD"/${LEDGER}`],
      ['a target whose BASENAME is quoted', 'echo x >> .orchestrator/metrics/"sessions.jsonl"'],
      ['a target with a backslash-escaped space', `echo x >> /Users/me/My\\ Repo/${LEDGER}`],
      ['a target that opens with a quoted dot', `echo x >> "."/${LEDGER}`],

      // ---- fail-closed: an unterminated quote is a command bash itself
      // rejects, so trusting the scan past the break would only ever help a
      // bypass. Denying costs ~0 in false positives.
      ['an unbalanced quote near the ledger', `echo don't >> ${LEDGER}`],

      // ---- #991: the hook's local VERB_PREFIXES was FLAGBLIND — it skipped
      // the wrapper WORD and never its arguments, so `sudo -u root tee` had
      // verb `-u` and `tee` was never in verb position. Every row below was
      // measured ALLOW against the pre-#991 hook (probe: 14 MISS / 14), i.e.
      // the guard reported a safety it did not provide. `doas`/`timeout`/
      // `stdbuf` were not in the local set at all.
      ['a sudo-wrapped tee with a separated flag', `sudo -u root tee -a ${LEDGER}`],
      ['a sudo-wrapped tee with an attached long flag', `sudo --user=root tee -a ${LEDGER}`],
      ['a sudo-wrapped tee behind an option terminator', `sudo -- tee -a ${LEDGER}`],
      ['an env-wrapped tee', `env -u PATH tee -a ${LEDGER}`],
      ['a nice-wrapped tee', `nice -n 10 tee -a ${LEDGER}`],
      ['a nice-wrapped tee with the legacy -10 form', `nice -10 tee -a ${LEDGER}`],
      ['a CHAINED sudo→env wrapper pair', `sudo -u root env FOO=1 tee -a ${LEDGER}`],
      ['a timeout-wrapped tee (positional duration)', `timeout 5 tee -a ${LEDGER}`],
      ['a stdbuf-wrapped tee', `stdbuf -o0 tee -a ${LEDGER}`],
      ['a doas-wrapped tee', `doas tee -a ${LEDGER}`],
      // The `dd of=` and `cp`-destination branches had no test at all before
      // #991 — behind a wrapper both were silently allowed.
      ['a sudo-wrapped dd of=', `sudo -u root dd of=${LEDGER}`],
      ['a sudo-wrapped cp INTO the ledger', `sudo -u root cp /tmp/b.jsonl ${LEDGER}`],
      // Direction guard: the redirect half already denied pre-#991 and must
      // keep denying — the verb rewrite must not regress the scanner path.
      ['a sudo-wrapped redirect', `sudo -u root echo x >> ${LEDGER}`],
      ['a nice-wrapped redirect', `nice -n 10 echo x >> ${LEDGER}`],

      // ---- #991 / #988 T3: `/usr/bin/time -o FILE` TRUNCATES FILE without
      // `-a` (BSD time(1)), and the verb is whatever time then runs — so the
      // write target lives ONLY in wrapperArgs, invisible in verb and args.
      ['a time -o report over the ledger', `/usr/bin/time -o ${LEDGER} echo hi`],
      ['a time -a -o report over the ledger', `/usr/bin/time -a -o ${LEDGER} echo hi`],
      ['a time --output= report over the ledger', `/usr/bin/time --output=${LEDGER} npm test`],
      // The asymmetry: here the ledger is in the VERB's args, not in
      // wrapperArgs. Both paths must fire, so neither may replace the other.
      ['a time-wrapped tee with an unrelated -o', `/usr/bin/time -o /tmp/log tee -a ${LEDGER}`],

      // ---- #991: `env -S` hides a whole command line in one operand.
      ['a command line hidden in env -S', `env -S "tee -a ${LEDGER}"`],
    ])('blocks the %s form', (_label, command) => {
      // Bug: a matcher that only knows `>>` leaves five equally direct write
      // paths open, so the guard reports safety it does not provide.
      expectDeny(runHook({ command }));
    });

    it('cannot be talked out of the deny by naming the sanctioned writer', () => {
      // Bug: a script-NAME allowlist is spoofable from a comment or an
      // unrelated argument. This guard matches write STRUCTURE, so neither
      // shape earns a pass.
      expectDeny(runHook({ command: `echo '{}' >> ${LEDGER} # node scripts/emit-session.mjs` }));
      expectDeny(runHook({ command: `echo scripts/emit-session.mjs >> ${LEDGER}` }));
    });

    it('still emits a PARSEABLE deny envelope for a command past the 64 KiB pipe buffer', () => {
      // Bug (#906 regression class): console.log + process.exit drops stdout
      // above the kernel pipe buffer, and on this protocol a truncated envelope
      // reads as NO decision — the command is ALLOWED. The target is oversized
      // too, so the reason itself must be clamped rather than blow the buffer.
      const hugeDir = 'd'.repeat(70_000);
      const command = `echo '${'x'.repeat(70_000)}' >> /tmp/${hugeDir}/${LEDGER}`;
      expect(command.length).toBeGreaterThan(64 * 1024);

      const res = runHook({ command });
      // Both halves of the #906 fix must hold: the reason is CLAMPED below the
      // 65 536-byte pipe buffer (so nothing can be dropped) …
      expect(res.stdout.length).toBeLessThan(65_536);
      // … and what arrives is a COMPLETE, parseable deny — not a truncated
      // remnant, which the harness would read as no-decision and allow.
      expectDeny(res, 'emit-session.mjs');
    });

    it.each([
      ['$( substitution', '$('.repeat(3000) + 'true' + ')'.repeat(3000) + `; echo x >> ${LEDGER}`],
      ['( subshell', '( '.repeat(7000) + 'true' + ' )'.repeat(7000) + `; echo x >> ${LEDGER}`],
      // Inside "…" an unparseable body falls back to a mark, not a deny — the
      // depth cap must not take that softer exit.
      ['quoted $( substitution', `echo "${'$('.repeat(3000)}echo x >> ${LEDGER}${')'.repeat(3000)}"`],
    ])('denies a ledger write behind %s nesting too deep to scan (#1665)', (_label, command) => {
      // Bug: the span scanner recursed without a bound, the stack overflowed, and
      // main().catch turned the crash into an ALLOW — zsh and bash still run it.
      const started = Date.now();
      expectDeny(runHook({ command }));
      expect(Date.now() - started).toBeLessThan(5000);
    });

    // #1670 — measured ALLOW at d4fcdf08 for every 'deny' row: readWord ended the
    // target at the `(` of an unquoted `$(`, recorded the target `$`, and the
    // scanner then took `(pwd)` for a subshell — the write was never judged.
    it.each([
      ['$(pwd) prefix', `echo x >> $(pwd)/${LEDGER}`],
      ['$(git rev-parse) prefix with a space in the body', `echo x > $(git rev-parse --show-toplevel)/${LEDGER}`],
      ['substitution supplying the basename', `echo x > $(echo ${LEDGER})`],
    ])('denies a redirect target that starts with a substitution: %s', (_label, command) => {
      expectDeny(runHook({ command }), 'emit-session.mjs');
    });

    it.each([
      ['a backup file', `echo x >> $(pwd)/${LEDGER}.bak`],
      ['another file beside a ledger read', `echo x >> $(pwd)/x.log; cat ${LEDGER}`],
    ])('still allows a substitution-prefixed target naming %s', (_label, command) => {
      // Bug: a fail-closed rule keyed on "the word mentions sessions.jsonl"
      // instead of the unresolvable LAST component would deny these.
      expectAllow(runHook({ command }));
    });

    // #1671 item 3 — measured ALLOW for every row: the pre-filter looked for the
    // literal `sessions.jsonl` in the RAW command, so quoting or escaping inside
    // the name skipped the whole scan, and a substitution supplying PART of the
    // name never reached the #1670 rule (it keyed on the full basename).
    const DIR = '.orchestrator/metrics';
    const NAMES = [
      ['$(…) whole stem', '$(echo sessions).jsonl'],
      ['$(…) mid-name', 'sess$(echo ions).jsonl'],
      ['backtick stem', '`echo sessions`.jsonl'],
      ['double-quoted stem', '"sessions".jsonl'],
      ['single-quoted stem', "'sessions'.jsonl"],
      ['backslash-escaped dot', 'sessions\\.jsonl'],
      // Measured ALLOW for `>>` only (tee/cp/dd denied): readWord's double-quote
      // state copied `$(…)` literally, so the skeleton carried no placeholder.
      ['a double-quoted $(…) stem', '"$(echo sessions)".jsonl'],
      ['a double-quoted backtick mid-name', '"sess`echo ions`.jsonl"'],
    ];
    const WRITES = [
      ['>>', (t) => `echo x >> ${t}`],
      ['tee -a', (t) => `cat rec.json | tee -a ${t}`],
      ['cp', (t) => `cp /tmp/backup.jsonl ${t}`],
      ['dd of=', (t) => `dd if=/tmp/backup.jsonl of=${t}`],
    ];
    it.each(WRITES.flatMap(([verb, build]) => NAMES.map(([shape, name]) => [verb, shape, build(`${DIR}/${name}`)])))(
      'denies a %s write whose ledger name is disguised by %s',
      (_verb, _shape, command) => {
        expectDeny(runHook({ command }));
      },
    );

    // The same substitutions with the WHOLE target double-quoted: bash expands
    // `$(…)` and backticks inside "…", so the name is still decided at run time.
    const QUOTED_PATHS = [
      ['$(…) whole stem', `"${DIR}/$(echo sessions).jsonl"`],
      ['$(…) mid-name', `"${DIR}/sess$(echo ions).jsonl"`],
    ];
    it.each(WRITES.flatMap(([verb, build]) => QUOTED_PATHS.map(([shape, p]) => [verb, shape, build(p)])))(
      'denies a %s write to a fully double-quoted target with a %s',
      (_verb, _shape, command) => {
        expectDeny(runHook({ command }));
      },
    );

    it.each([
      ['a substitution-named log beside the ledger', `echo x >> ${DIR}/$(date +%s).log`],
      ['a quoted DIFFERENT jsonl', `cp /tmp/b.jsonl ${DIR}/"events".jsonl`],
      ['a substitution-named file outside the metrics dir', 'echo x >> /tmp/$(echo sessions).jsonl'],
      ['a fully quoted events path', `echo x >> "${DIR}/events.jsonl"`],
      ['a double-quoted substitution-named log', `echo x >> "${DIR}/$(date +%s).log"`],
      // Single quotes keep `$(…)` literal: the file is named `$(echo sessions).jsonl`.
      ['a single-quoted substitution spelling', `echo x >> '${DIR}/$(echo sessions).jsonl'`],
    ])('still allows %s (#1671 precision)', (_label, command) => {
      // Bug: a rule keyed on "metrics dir + any substitution or quote" instead of
      // "could this name be sessions.jsonl" would deny routine metric writes.
      expectAllow(runHook({ command }));
    });
  });

  describe('allows everything that is not a direct write', () => {
    it.each([
      ['the sanctioned writer with an inline entry', `node scripts/emit-session.mjs --entry '{"a":1}'`],
      ['the sanctioned writer naming the ledger explicitly', `node scripts/emit-session.mjs --file ${LEDGER} < rec.json`],
      ['the backfill writer', `node scripts/backfill-sessions.mjs --file ${LEDGER} --apply`],
      ['the migration writer', `node scripts/migrate-sessions-jsonl.mjs --file ${LEDGER} --apply`],
    ])('allows %s', (_label, command) => {
      // Bug: a guard that blocks the ONLY sanctioned writer is worse than no
      // guard — it makes the correct path the painful one.
      expectAllow(runHook({ command }));
    });

    it.each([
      ['an unrelated command', 'git status --short'],
      ['reading the ledger', `wc -l ${LEDGER}`],
      ['reading with a stderr redirect', `tail -3 ${LEDGER} 2>&1`],
      ['copying the ledger AWAY (ledger is the source)', `cp ${LEDGER} /tmp/backup.jsonl`],
      ['appending to a DIFFERENT jsonl', 'echo x >> .orchestrator/metrics/learnings.jsonl'],
      ['appending to the events stream', 'echo x >> .orchestrator/metrics/events.jsonl'],
      ['appending to a ledger BACKUP', 'echo x >> .orchestrator/metrics/sessions.jsonl.bak'],
      ['a quoted mention of the redirect, not a redirect', `git commit -m 'route writes >> sessions.jsonl'`],
      // The MED-1 fix must not overshoot: an apostrophe inside a legitimately
      // quoted commit message, and a here-doc body that merely NAMES the
      // ledger, are prose — not write intent.
      ['an apostrophe inside a quoted commit message', `git commit -m "don't write ${LEDGER} by hand"`],
      ['a here-doc body that merely names the ledger', `cat <<'EOF' > /tmp/n\nappend to ${LEDGER}\nEOF`],

      // These three pin the MED-1 machinery as LOAD-BEARING rather than merely
      // redundant with the fail-closed backstop. Each carries an apostrophe in
      // a construct the old mask could not model; without comment-stripping /
      // here-doc-body-skipping / ANSI-C handling the scan ends unbalanced and
      // the fail-closed branch turns a plain READ into a false deny.
      ['a read with an apostrophe in a trailing comment', `wc -l ${LEDGER}   # don't forget the record`],
      [
        'a here-doc body with an apostrophe naming the ledger',
        `cat <<'EOF' > /tmp/n\ndon't hand-write ${LEDGER}\nEOF`,
      ],
      ['an ANSI-C literal beside a ledger read', `printf $'it\\'s done\\n' && wc -l ${LEDGER}`],

      // #991 counter-probes. Flag-aware unwrapping resolves PAST the wrapper's
      // options, so it must land on the READ verb here — an over-eager
      // "a wrapper is present and the ledger is named" rule would turn every
      // one of these routine inspections into a false deny.
      ['a sudo-wrapped read', `sudo -u root wc -l ${LEDGER}`],
      ['a nice-wrapped read', `nice -n 10 cat ${LEDGER}`],
      ['an env-wrapped read', `env -u PATH tail -3 ${LEDGER}`],
      ['a sudo-wrapped cp AWAY from the ledger', `sudo -u root cp ${LEDGER} /tmp/backup`],
      ['a timeout-wrapped read', `timeout 5 grep x ${LEDGER}`],
      ['a stdbuf-wrapped read', `stdbuf -o0 cat ${LEDGER}`],
      // `sudo -i` spawns a login SHELL, so the resolved verb is the synthetic
      // `sh` and `tee -a <ledger>` is stdin text, not this segment's write.
      ['a sudo -i login shell whose tee is stdin text', `sudo -i tee -a ${LEDGER}`],
      // Precision of the writesFile contract (#996.1): `stdbuf -o` names a
      // BUFFERING MODE, not a file, and shares its spelling with `time -o`, so
      // resolveSegmentVerb does NOT flag it `writesFile: true` (only `time -o`/
      // `--output` sit in its per-wrapper fileArgFlags). Treating every
      // value-taking wrapper flag as a write target would deny this.
      ['a stdbuf -o buffering MODE beside a ledger read', `stdbuf -o L cat ${LEDGER}`],
      // …and the same for a time -o report that goes somewhere else entirely.
      ['a time -o report to an unrelated file', `/usr/bin/time -o /tmp/log wc -l ${LEDGER}`],
    ])('allows %s', (_label, command) => {
      // Bug: an over-eager matcher (raw regex with no quote state, or a bare
      // "mentions sessions.jsonl" test) wedges reads, backups and commits.
      expectAllow(runHook({ command }));
    });

    it.each([
      ['a non-Bash tool', { toolName: 'Edit', command: `echo x >> ${LEDGER}` }],
      ['an empty command', { toolName: 'Bash', command: '' }],
    ])('allows %s without inspecting it', (_label, payload) => {
      // Bug: gating on the wrong tool would deny Edit/Write calls this hook has
      // no business judging.
      expectAllow(runHook(payload));
    });

    it('honours the documented session-level override', () => {
      // Bug: a guard with no escape hatch blocks legitimate maintenance, and
      // the operator's only remaining move is to disable enforcement wholesale.
      expectAllow(
        runHook({
          command: `echo '{}' >> ${LEDGER}`,
          env: { SO_DISABLED_HOOKS: 'pre-bash-sessions-ledger-guard' },
        }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// #993 — load-failure visibility (late binding)
//
// Before #993 this hook STATICALLY imported command-blocker.mjs, so a SyntaxError
// there failed at ESM LINK time: node exited 1 with 0 bytes on stdout, and the
// hook's own `main().catch(...)` was structurally unreachable. Under the exit-0
// PreToolUse protocol (#906) that crash is INDISTINGUISHABLE from an explicit
// allow — a direct ledger write waves through a guard that never armed, silently.
//
// The dependencies are now bound late (dynamic `import()` in `bootstrap()`), so
// the link-time crash becomes a catchable error that banners GUARD INACTIVE.
// ---------------------------------------------------------------------------
describe('#993 — GUARD INACTIVE on a broken command-blocker', { timeout: 30000 }, () => {
  it('fails open VISIBLY (exit 0 + GUARD INACTIVE), not exit-1 / 0-byte, when command-blocker cannot load', () => {
    // Bug this catches: at the pre-#993 static-import shape, this exact spawn
    // produced EXIT=1 / stdout 0 bytes / decision NONE — a would-be DENY of a
    // direct ledger write read by the harness as no-decision, i.e. ALLOWED.
    //
    // command-blocker has `headFallback: true`, so breaking ONLY the working-tree
    // copy would recover from `git show HEAD:` and merely DEGRADE (guard still
    // armed). To reach the total-outage GUARD INACTIVE class the HEAD copy must
    // fail too — `alsoBreakHeadFallback: true` corrupts the data:-URL import the
    // fallback uses. This mirrors the destructive-guard's own INACTIVE test
    // (tests/hooks/pre-bash-destructive-guard.test.mjs, the `alsoBreakHeadFallback`
    // case): the task's bare `{ moduleBasename }` hint would only DEGRADE here.
    const result = runHook({
      // A real deny shape: with the guard armed this is blocked (see the #958
      // suite above), so the fail-OPEN below is meaningful, not a no-op allow.
      command: `echo '{}' >> ${LEDGER}`,
      execArgv: brokenModuleBoot({
        moduleBasename: 'command-blocker.mjs',
        alsoBreakHeadFallback: true,
      }),
    });

    // Fail-OPEN (empty decision channel) + the GUARD INACTIVE banner on stderr,
    // with the hook-specific prefix — the #993 non-hard-wiring proof that the
    // loader emits THIS hook's name, not a `pre-bash-destructive-guard` literal.
    expectGuardInactive(result, { hookName: 'pre-bash-sessions-ledger-guard' });
    // The consequence prose names the concrete outage, so the operator reads a
    // disarmed guard rather than a harness crash and does not route around it.
    expect(result.stderr).toContain('NOT being blocked');
  });
});

// ---------------------------------------------------------------------------
// #1000 — an unknown dash-flag hid the write verb (DUAL PARSE)
//
// `resolveSegmentVerb` could not know whether an unrecognised wrapper flag is a
// boolean or takes a value, and it guessed BOOLEAN. Guessing wrong in that
// direction consumes one token too few, so the verb resolves to the flag's
// OPERAND and `tee` is never in verb position — the write is allowed. The
// resolver now reports the value-taking reading as an additive `alt`, and this
// hook judges BOTH: a hit in either is a deny.
// ---------------------------------------------------------------------------
describe('#1000 — unknown-flag bypass (dual parse)', () => {
  it.each([
    // Measured ALLOW before the alt-loop: `--unknown` was read as a boolean, so
    // the verb resolved to `5` and the tee was invisible.
    ['nice with an unknown long flag', `nice --unknown 5 tee -a ${LEDGER}`],
    // Same shape on env: verb resolved to `x`.
    ['env with an unknown short flag', `env -Q x tee -a ${LEDGER}`],
  ])('denies %s', (_label, command) => {
    expectDeny(runHook({ command }), LEDGER);
  });

  it('keeps denying a genuinely BOOLEAN wrapper flag (parse A must survive)', () => {
    // Direction guard: `sudo -n` IS a boolean, so parse A is the correct reading
    // and `alt` is absent. A "fix" that judged only the value-taking reading
    // would resolve the verb to `tee`'s own `-a` operand and lose this deny —
    // this test catches that regression, which the two rows above cannot.
    expectDeny(runHook({ command: `sudo -n tee -a ${LEDGER}` }), LEDGER);
  });
});

// ---------------------------------------------------------------------------
// #998 item 2 — the MAX_PAYLOAD_DEPTH cut used to be SILENT
//
// A wrapper payload nested past the cap was dropped with no trace, so "analysed
// and clean" and "never looked at" produced the identical empty-stdout allow.
// The cut now raises a fail-visible marker. Still an ALLOW — this hook is an
// accident-guard, fail-open by design; a depth cut is not evidence of a write.
// ---------------------------------------------------------------------------
describe('#998 — depth-cut is fail-VISIBLE', () => {
  it('marks a ledger-bearing payload dropped at the depth cap instead of allowing silently', () => {
    // Three nested `env -S` levels: the innermost `tee -a <ledger>` sits past
    // MAX_PAYLOAD_DEPTH and is never analysed. Bug this catches: the operator
    // previously got a clean allow with nothing to indicate the command was only
    // partly read.
    const inner = `tee -a ${LEDGER}`;
    const mid = `env -S "${inner}"`;
    const outer = `env -S 'env -S "${mid.replace(/"/g, '\\"')}"'`;
    expectWarn(runHook({ command: outer }), ['depth-exceeded', 'pre-bash-sessions-ledger-guard']);
  });

  it('does NOT mark a deep-but-benign command (the basename filter is load-bearing)', () => {
    // Bug this catches: an UNFILTERED mark turns every ordinary deeply-nested
    // command into a warn envelope — noise this accident-guard must not generate,
    // and a change that would break the whole expectAllow table above. The
    // command still mentions the ledger at the OUTER level (so the cheap
    // pre-filter does not short-circuit it), but reads it rather than writing,
    // and the dropped payload names no ledger at all.
    const outer = `cat ${LEDGER} | env -S 'env -S "env -S \\"echo hi\\""'`;
    expectAllow(runHook({ command: outer }));
  });
});

// ---------------------------------------------------------------------------
// #1001 — DEGRADED surfaces on the DECISION channel
//
// This hook discarded `armGuard`'s `degraded` list, so a guard analysing
// commands with the COMMITTED lexer was indistinguishable from a healthy one on
// the only channel exit-0 surfaces. Unlike enforce-commands, this hook's
// PARSE-ERROR door reaches DEGRADED directly: `command-blocker` is its only
// fallback-bearing dependency and nothing imports it transitively first.
// ---------------------------------------------------------------------------
describe('#1001 — DEGRADED surfaces on stdout, not stderr alone', { timeout: 30000 }, () => {
  it('warns "DEGRADED" on the visible channel when the guard armed from HEAD', () => {
    // Bug this catches: `const { modules } = await armGuard(...)` dropped
    // `degraded`, so this spawn produced an EMPTY stdout — a silent allow.
    // Only the working-tree copy is broken here (no alsoBreakHeadFallback), so
    // the `git show HEAD:` recovery succeeds and the guard arms, degraded.
    // The DEGRADED banner drops a throttle marker into the child's tmpdir;
    // hand it one this test owns and removes (#1648).
    const ownTmp = mkdtempSync(join(tmpdir(), 'ledger-guard-degraded-'));
    onTestFinished(() => removeTree(ownTmp));
    const result = runHook({
      command: 'ls -la',
      env: { TMPDIR: ownTmp },
      execArgv: brokenModuleBoot({ moduleBasename: 'command-blocker.mjs' }),
    });
    expectWarn(result, ['DEGRADED', 'pre-bash-sessions-ledger-guard']);
  });
});

// ---------------------------------------------------------------------------
// #1005 — internal repair apply mutation bypass
//
// `repair-invalid-sessions.mjs` mutates the sessions ledger from inside Node,
// so the direct-write matcher sees no redirect or write verb. The matrix keeps
// the bug contract tight: only an effective apply invocation is denied, while
// the CLI's dry-run/boolean parsing and target semantics stay outside the hook.
// ---------------------------------------------------------------------------
const decisionAssertions = { allow: expectAllow, deny: expectDeny };

describe('#1005 — repair apply is ledger-guarded', () => {
  it.each([
    // #385: the EXACT canonical command is the guard's own sanctioned repair
    // path (repairRecord() in session-record-repair.mjs validates itself the
    // same way this hook enforces on every other writer) and is now allowed.
    // Every OTHER row below is a DEVIATION from that exact string — an extra
    // flag, a wrapper, a different path form — and stays denied unchanged.
    ['canonical exact command (#385 sanctioned exact match)', 'node scripts/repair-invalid-sessions.mjs --apply', 'allow'],
    [
      'boolean Node runtime option before the script',
      'node --no-warnings scripts/repair-invalid-sessions.mjs --apply',
      'deny',
      'repair-invalid-sessions.mjs --apply',
    ],
    [
      'Node 24 track-heap-objects boolean option before the script',
      'node --track-heap-objects scripts/repair-invalid-sessions.mjs --apply',
      'deny',
      'repair-invalid-sessions.mjs --apply',
    ],
    [
      'Node 24 experimental-worker-inspection boolean option before the script',
      'node --experimental-worker-inspection scripts/repair-invalid-sessions.mjs --apply',
      'deny',
      'repair-invalid-sessions.mjs --apply',
    ],
    [
      'Node 24 network-family-autoselection boolean option before the script',
      'node --enable-network-family-autoselection scripts/repair-invalid-sessions.mjs --apply',
      'deny',
      'repair-invalid-sessions.mjs --apply',
    ],
    [
      'recognized value-taking Node runtime option before the script',
      'node --require /tmp/preload.mjs scripts/repair-invalid-sessions.mjs --apply',
      'deny',
      'repair-invalid-sessions.mjs --apply',
    ],
    [
      'Node option terminator selects the script operand',
      'node -- scripts/repair-invalid-sessions.mjs --apply',
      'deny',
      'repair-invalid-sessions.mjs --apply',
    ],
    [
      'eval value containing the repair basename is not a script operand',
      'node --eval "scripts/repair-invalid-sessions.mjs" --apply',
      'allow',
    ],
    [
      'print value containing the repair basename is not a script operand',
      'node --print scripts/repair-invalid-sessions.mjs --apply',
      'allow',
    ],
    [
      'check mode does not execute the repair script',
      'node --check scripts/repair-invalid-sessions.mjs --apply',
      'allow',
    ],
    [
      'repair basename only in a Node option value',
      'node --require scripts/repair-invalid-sessions.mjs other-script.mjs --apply',
      'allow',
    ],
    [
      '--file target',
      'node scripts/repair-invalid-sessions.mjs --apply --file .orchestrator/metrics/sessions.jsonl',
      'deny',
      'repair-invalid-sessions.mjs --apply',
    ],
    [
      'absolute node path and script path',
      '/usr/bin/node /opt/tools/repair-invalid-sessions.mjs --apply',
      'deny',
      'repair-invalid-sessions.mjs --apply',
    ],
    ['env-wrapped node', 'env node scripts/repair-invalid-sessions.mjs --apply', 'deny', 'repair-invalid-sessions.mjs --apply'],
    // #1665: Debian's binary name was not recognised as Node — measured ALLOW at a870ecde.
    [
      'nodejs verb with an explicit --repo-root',
      'nodejs scripts/repair-invalid-sessions.mjs --apply --repo-root /tmp/x',
      'deny',
      'repair-invalid-sessions.mjs --apply',
    ],
    [
      'alternate value-taking wrapper reading',
      'env -Q x node scripts/repair-invalid-sessions.mjs --apply',
      'deny',
      'repair-invalid-sessions.mjs --apply',
    ],
    [
      'alternate reading with dry-run override',
      'env -Q x node scripts/repair-invalid-sessions.mjs --apply --dry-run',
      'allow',
    ],
    [
      'sudo-wrapped node',
      'sudo -u root node scripts/repair-invalid-sessions.mjs --apply',
      'deny',
      'repair-invalid-sessions.mjs --apply',
    ],
    ['no flags', 'node scripts/repair-invalid-sessions.mjs', 'allow'],
    ['dry-run', 'node scripts/repair-invalid-sessions.mjs --dry-run', 'allow'],
    ['apply with dry-run override', 'node scripts/repair-invalid-sessions.mjs --apply --dry-run', 'allow'],
    ['apply=false', 'node scripts/repair-invalid-sessions.mjs --apply=false', 'allow'],
    [
      'quoted inert mention',
      'echo "node scripts/repair-invalid-sessions.mjs --apply"',
      'allow',
    ],
    ['unrelated script', 'node scripts/other-script.mjs --apply', 'allow'],
    [
      'repair basename only in a later argument',
      'node scripts/other-script.mjs --note repair-invalid-sessions.mjs --apply',
      'allow',
    ],
  ])('%s', (_label, command, decision, reason) => {
    decisionAssertions[decision](runHook({ command }), reason);
  });

  it('an in-command SO_DISABLED_HOOKS prefix is denied and the reason says why (#1442)', () => {
    // Bug caught: the generic deny never named the allowed bare command, so an
    // agent re-spelled it with an env prefix — which this hook cannot see (it
    // reads SO_DISABLED_HOOKS from its OWN process env) and which also breaks
    // the exact match. Both facts must be in the reason.
    expectDeny(
      runHook({
        command: 'SO_DISABLED_HOOKS=pre-bash-sessions-ledger-guard node scripts/repair-invalid-sessions.mjs --apply',
      }),
      ['  node scripts/repair-invalid-sessions.mjs --apply', 'prefix INSIDE the command has no effect'],
    );
  });
});

// ---------------------------------------------------------------------------
// #385 — the exact canonical repair-apply command is the sanctioned
// mechanism, not a spoofable name allowlist. `repairRecord()` in
// `scripts/lib/session-record-repair.mjs` is the SAME validated write path
// (`.bak` before rewrite, atomic rename, post-verification restore on
// failure) this hook exists to force every OTHER writer through — denying it
// created a fix-it deadlock, because there is no other sanctioned way to
// invoke it. The exception is deliberately an EXACT STRING match: matching by
// verb/flags (like the deny matcher below it) cannot tell "the operator ran
// the runbook command" apart from "the operator ran something adjacent to
// it" — chaining, piping, an extra flag, a wrapper. See the module docblock
// (top of the hook, "ALLOWED STRUCTURALLY") for why a name in the command
// string is otherwise trivially spoofable.
// ---------------------------------------------------------------------------
describe('#385 — canonical repair-apply exact-match exception', () => {
  it('(a) the exact canonical command is allowed', () => {
    expectAllow(runHook({ command: 'node scripts/repair-invalid-sessions.mjs --apply' }));
  });

  it('(b) the canonical command chained with a direct ledger append is still denied', () => {
    // Two write intents in one command: the repair invocation itself would be
    // sanctioned in isolation, but "no further shell operators in the same
    // command" (issue text) means the chain as a whole is not the exact
    // canonical string, and the appended `>>` is caught by the existing
    // redirect-target scan regardless — belt and braces, not either/or.
    expectDeny(
      runHook({
        command:
          'node scripts/repair-invalid-sessions.mjs --apply; echo x >> .orchestrator/metrics/sessions.jsonl',
      }),
      '.orchestrator/metrics/sessions.jsonl',
    );
  });

  it('(b) chained with a second, non-write command is still denied (no operators allowed in the same command)', () => {
    // Same principle as above with no redirect present, so this exercises the
    // chain-length check on its own: the repair segment alone would exact-match,
    // but it is not alone in this command.
    expectDeny(
      runHook({ command: 'node scripts/repair-invalid-sessions.mjs --apply; echo done' }),
      'repair-invalid-sessions.mjs --apply',
    );
  });

  it('(c) the canonical command wrapped in $(...) is denied', () => {
    expectDeny(
      runHook({ command: '$(node scripts/repair-invalid-sessions.mjs --apply)' }),
      'wrapped in a subshell/backticks',
    );
  });

  it('(c) the canonical command wrapped in backticks is denied', () => {
    expectDeny(
      runHook({ command: '`node scripts/repair-invalid-sessions.mjs --apply`' }),
      'wrapped in a subshell/backticks',
    );
  });

  it('(c) the canonical command wrapped in a bare subshell is denied', () => {
    expectDeny(
      runHook({ command: '(node scripts/repair-invalid-sessions.mjs --apply)' }),
      'wrapped in a subshell/backticks',
    );
  });

  it('leading/trailing whitespace around the exact command is still allowed (trim, not literal-byte match)', () => {
    expectAllow(runHook({ command: '  node scripts/repair-invalid-sessions.mjs --apply  \n' }));
  });

  it('a single extra trailing flag breaks the exact match and stays denied', () => {
    expectDeny(
      runHook({ command: 'node scripts/repair-invalid-sessions.mjs --apply --json' }),
      'repair-invalid-sessions.mjs --apply',
    );
  });
});

// ---------------------------------------------------------------------------
// #1408 — a write performed INSIDE an interpreter eval payload
//
// The guard matched SHELL write intent only, and named that bound in its own
// docblock. Measured over 58 transcripts of this repo: 438 Bash commands mention
// the ledger, the shell shapes the guard matches occurred **0 times**, 46 are
// interpreter one-liners. On 2026-09-19 a coordinator appended its session record
// with `node --input-type=module -e "… appendFileSync('<ledger>', …)"`, landing a
// record with `ended_at` instead of `completed_at` and four required fields
// missing — `emit-session.mjs` never ran. Every DENY row below was measured ALLOW
// (empty stdout, exit 0 — "no decision") against the pre-#1408 hook.
//
// The ALLOW rows are the false-positive proof, and they are not hypothetical:
// all three interpreter one-liners that actually occur in the transcripts READ
// the ledger and write `.orchestrator/tmp/session-entry.json`. A matcher keyed on
// co-occurrence of a write verb and the ledger basename — rather than on the
// write call's FIRST ARGUMENT — denies all three.
// ---------------------------------------------------------------------------
describe('#1408 — interpreter eval payloads', () => {
  it.each([
    // ---- the measured accident and its near neighbours
    ['the #1408 shape — node -e appendFileSync', `node -e "require('fs').appendFileSync('${LEDGER}', JSON.stringify(rec) + '\\n')"`,
      'deny'],
    ['the record-session concatenation form', `node -e "fs.appendFileSync(R+'/${LEDGER}', line)"`, 'deny'],
    ['--input-type=module with writeFileSync', `node --input-type=module -e "import fs from 'node:fs'; fs.writeFileSync('/tmp/r/${LEDGER}', s)"`,
      'deny'],
    ['the attached -e spelling', `node -e'require("fs").appendFileSync("${LEDGER}","x")'`, 'deny'],
    ['the =-joined --eval spelling', `node --eval="require('fs').appendFileSync('${LEDGER}','x')"`, 'deny'],
    ['createWriteStream onto the ledger', `node -e "require('fs').createWriteStream('${LEDGER}',{flags:'a'}).write(l)"`, 'deny'],
    ["python3 -c open(…,'a')", `python3 -c "open('${LEDGER}','a').write(line)"`, 'deny'],
    ['perl three-arg open for append', `perl -e "open(my \\$fh, '>>', '${LEDGER}');"`, 'deny'],
    ['ruby File.write', `ruby -e "File.write('${LEDGER}', line, mode: 'a')"`, 'deny'],
    // Per-STATEMENT scoping: the write is the SECOND statement of a chain, and
    // the predicate sits inside splitChainSegments, so it is judged on its own.
    ['a chained second statement', `jq -c . rec.json && node -e "require('fs').appendFileSync('${LEDGER}','x')"`, 'deny'],

    // ---- 2026-09-20 — an interpreter append to the ledger wrapped in `bash -c`
    // is allowed. `payloadSet` was built from `resolved.payloads` (WRAPPER
    // payloads like `env -S`) only, never from the shell `-c` operand, so one
    // word turned every deny below into a silent allow.
    ['a bash -c interpreter append', `bash -c "node -e \\"require('fs').appendFileSync('${LEDGER}','x')\\""`, 'deny'],
    ['a bash -c redirect', `bash -c "echo x >> ${LEDGER}"`, 'deny'],
    ['a sh -c redirect', `sh -c 'echo x >> ${LEDGER}'`, 'deny'],
    // Verb is `xargs`, not a shell — this is why the payload scan is keyed on a
    // shell TOKEN anywhere in the segment rather than on the resolved verb.
    ['an xargs sh -c redirect', `xargs -I{} sh -c "echo x >> ${LEDGER}"`, 'deny'],

    // ---- #1665 — the shared tokenizer glued `(`, `$(`, `` ` `` and `{` onto the
    // next word, so `(node` never resolved the verb `node`; each deny row below
    // was measured ALLOW against the a870ecde hook.
    ['a subshell that is not the first command', `true && (node -e "require('fs').appendFileSync('${LEDGER}','x')")`, 'deny'],
    ['a $(…) command substitution', `echo $(node -e "require('fs').appendFileSync('${LEDGER}','x')")`, 'deny'],
    ['a backtick command substitution', `echo \`node -e "require('fs').appendFileSync('${LEDGER}','x')"\``, 'deny'],
    ['a $(…) inside double quotes', `echo "$(tee -a ${LEDGER} < rec.json)"`, 'deny'],
    // Counter-probe: the same syntax around READS must not inherit a deny, and
    // `{}` / `${…}` are not brace groups (a `{ …; }` group is one).
    ['benign subshell, substitution and group around a read', `true && (echo hi) && echo $(date) "\${HOME}" && { wc -l ${LEDGER}; } && find . -exec cp {} /tmp/o \\;`, 'allow'],
    // #1665 review cycle 2 — the first fix rewrote an unquoted `$(` / backtick
    // to ` ; ` even MID-WORD, so the destination word lost its ledger tail.
    // Each row denied at a870ecde and was measured ALLOW against that fix.
    ['tee -a onto a $(pwd)-prefixed ledger', `tee -a $(pwd)/${LEDGER} < /tmp/rec`, 'deny'],
    ['tee -a onto a backtick-prefixed ledger', `tee -a \`pwd\`/${LEDGER} < /tmp/rec`, 'deny'],
    ['mv onto a $(pwd)-prefixed ledger', `mv /tmp/rec $(pwd)/${LEDGER}`, 'deny'],
    ['dd of= a $(pwd)-prefixed ledger', `dd if=/tmp/rec of=$(pwd)/${LEDGER}`, 'deny'],
    ['dd of= a backtick-prefixed ledger', `dd if=/tmp/rec of=\`pwd\`/${LEDGER}`, 'deny'],
    // The first fix ended the outer `"…"` at the first inner `"`, so the
    // extracted body stopped inside a '…' string and the recursive scan failed
    // CLOSED. Real transcript shape (2 of 893): a glab description built by printf.
    ['a double-quoted $(printf …) whose single-quoted text holds a "', `echo "$(printf 'see sessions.jsonl "x" here')"`, 'allow'],
    // Same nesting, write direction: the nested double quotes no longer split
    // the outer run, so the substitution body reaches the matcher whole.
    ['a double-quoted $(node -e "…") with nested double quotes', `echo "$(node -e "require('fs').appendFileSync('${LEDGER}','x')")"`, 'deny'],

    // ---- the measured ALLOW shapes. 148 of the 438 ledger-naming commands are
    // plain jq reads; the 3 interpreter one-liners that contain a write verb at
    // all are ALL ledger reads that write somewhere else.
    ['a jq read', `jq -c 'select(.session_id=="x")' ${LEDGER}`, 'allow'],
    ['a node -e readFileSync of the ledger', `node -e "JSON.parse(require('fs').readFileSync('${LEDGER}','utf8').trim().split('\\n').pop())"`,
      'allow'],
    ['the measured read-then-write-ELSEWHERE one-liner', `node -e "const fs=require('fs');const r=fs.readFileSync('${LEDGER}','utf8');fs.writeFileSync('.orchestrator/tmp/session-entry.json', r)"`,
      'allow'],
    ['wc -l', `wc -l ${LEDGER}`, 'allow'],
    ['tail', `tail -3 ${LEDGER}`, 'allow'],
    ['grep', `grep -c session_id ${LEDGER}`, 'allow'],
    ['python3 -c with no mode operand (a READ)', `python3 -c "print(open('${LEDGER}').read())"`, 'allow'],
    ["python3 -c open(…,'r')", `python3 -c "print(open('${LEDGER}','r').read())"`, 'allow'],
    ['perl open for READ (no > in any operand)', `perl -e "open(my \\$fh, '<', '${LEDGER}');"`, 'allow'],
    // Per-STATEMENT scoping, allow direction: a read statement followed by an
    // unrelated one must not inherit a deny from anywhere.
    ['a read statement followed by echo', `node -e "require('fs').readFileSync('${LEDGER}')" ; echo ok`, 'allow'],
    // The false-positive floor rides the SAME matcher once wrapped — a read
    // payload must stay allowed, or the deny rows above cost the 148 jq reads.
    ['a bash -c jq read', `bash -c "jq . ${LEDGER}"`, 'allow'],
    ['a bash -c tail-into-jq read', `bash -c "tail -1 ${LEDGER} | jq ."`, 'allow'],
  ])('%s', (_label, command, decision) => {
    decisionAssertions[decision](runHook({ command }));
  });

  it('routes the operator to the validating writer instead of just blocking', () => {
    // Bug: a deny with no route is what a hurried agent reads as a crash and
    // works around — which is how the prose prohibition failed in the first place.
    expectDeny(
      runHook({ command: `node -e "require('fs').appendFileSync('${LEDGER}','x')"` }),
      ['emit-session.mjs', LEDGER, 'appendFileSync'],
    );
  });

  it('does NOT let a second statement ride the #385 exact-match bypass', () => {
    // Bug this catches: the guard's ONE bypass (REPAIR_APPLY_CANONICAL_COMMAND)
    // is a WHOLE-command comparison. Widening a matcher without narrowing its
    // bypass opens a hole — so the canonical repair command with an interpreter
    // append chained after it must not be waved through by the exact match.
    // Reported target is the FIRST offending statement (the repair marker), which
    // is itself the proof: the whole-command exact match did not fire, so the
    // chain fell through to the normal per-segment deny logic.
    expectDeny(
      runHook({
        command: `node scripts/repair-invalid-sessions.mjs --apply; node -e "require('fs').appendFileSync('${LEDGER}','x')"`,
      }),
      'repair-invalid-sessions.mjs --apply',
    );
    // Reversed order: the interpreter write is the statement that hits first, so
    // the new predicate — not the pre-existing repair rule — carries this deny.
    expectDeny(
      runHook({
        command: `node -e "require('fs').appendFileSync('${LEDGER}','x')"; node scripts/repair-invalid-sessions.mjs --apply`,
      }),
      'appendFileSync',
    );
  });
});

describe('#1005 — unavailable Node grammar denies repair apply', () => {
  it.each([
    [
      'spawn error',
      "() => ({ error: new Error('injected spawn failure'), status: null, stdout: '' })",
      'spawn-failed',
    ],
    [
      'empty help output',
      "() => ({ status: 0, stdout: '' })",
      'malformed-help',
    ],
    [
      'malformed help output',
      "() => ({ status: 0, stdout: 'not node help' })",
      'malformed-help',
    ],
  ])('denies visibly on %s instead of allowing', (_label, childProcessSource, reason) => {
    // Bug: treating an unavailable runtime grammar as an empty Map makes this
    // valid Node 24 option stop resolution and silently allow the repair apply.
    expectDeny(
      runHook({
        command: 'node --track-heap-objects scripts/repair-invalid-sessions.mjs --apply',
        execArgv: childProcessBoot(childProcessSource),
      }),
      [
        'repair-invalid-sessions.mjs --apply',
        `Node option grammar unavailable: ${reason}`,
        'denied fail-closed',
      ],
    );
  });
});

// #1577: the existing childProcessBoot seam substitutes only Git identity
// measurement. Real paths, quoting, payload context and CLI resolution are
// exercised by the real hook. This is deterministic contract coverage, not
// native Git/process acceptance (which remains required at the Lead).
describe('#1577 — absolute installed repair invocation', () => {
  const script = resolve(import.meta.dirname, '../../scripts/repair-invalid-sessions.mjs');
  function fixture(markerType = 'directory', rootName = 'consumer') {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'ledger-guard-1577-')));
    onTestFinished(() => removeTree(dir));
    const root = join(dir, rootName);
    for (const name of ['home', 'config', 'vault', rootName]) mkdirSync(join(dir, name), {recursive: true});
    mkdirSync(join(root, 'sub'));
    mkdirSync(join(root, '.orchestrator', 'metrics'), {recursive: true});
    writeFileSync(join(root, '.orchestrator', 'metrics', 'sessions.jsonl'), '');
    if (markerType === 'file') writeFileSync(join(root, '.git'), `gitdir: ${join(dir, 'synthetic-worktree-gitdir')}\n`);
    else mkdirSync(join(root, '.git'));
    const env = {
      HOME: join(dir, 'home'), NAVIGATOR_CONFIG_DIR: join(dir, 'config'), SO_CONFIG_HOME: join(dir, 'config'), SO_VAULT_DIR: join(dir, 'vault'),
      CLAUDE_PROJECT_DIR: '', CODEX_PROJECT_DIR: '', CURSOR_PROJECT_DIR: '', PI_PROJECT_DIR: '',
      ...Object.fromEntries(Object.keys(process.env).filter((name) => name.startsWith('GIT_')).map((name) => [name, undefined])),
    };
    const git = childProcessBoot(`(command, args, options) => {
      if (command !== 'git') return originalSpawnSync(command, args, options);
      if (args[0] !== '-C' || args[2] !== 'rev-parse' || args[3] !== '--show-toplevel') {
        throw new Error('Unexpected identity probe');
      }
      return {status: 0, stdout: ${JSON.stringify(root + '\n')}};
    }`);
    const run = (command, overrides = {}) => {
      const result = runHook({command, cwd: root, payloadCwd: root, env, execArgv: git, ...overrides});
      expect(result.error).toBeUndefined();
      return result;
    };
    return {dir, root, env, run, git};
  }

  // The observable contract is the real hook decision, with only Git identity
  // stubbed as in #1577. These cases catch a missing or overbroad Vault guard;
  // the existing absolute-root tests did not resolve any Vault path.
  it.each(['vault', 'vault/consumer'])('denies a resolved Vault root or descendant (%s)', (rootName) => {
    const {root, run} = fixture('directory', rootName);
    expectDeny(run(`node '${script}' --apply --repo-root '${root}'`), '#1577');
  });

  it('canonicalizes a configured Vault symlink before excluding the target', () => {
    const {dir, root, env, run} = fixture('directory', 'vault/consumer');
    const linked = join(dir, 'vault-link');
    symlinkSync(join(dir, 'vault'), linked);
    expectDeny(run(`node '${script}' --apply --repo-root '${root}'`, {env: {...env, SO_VAULT_DIR: linked}}), '#1577');
  });

  // Bug: the exception admitted `--repo-root` without a sessions.jsonl there,
  // so `--apply` ran against a repo that has no ledger to repair (#1577).
  it.each([
    ['absent', (ledger) => rmSync(ledger)],
    ['a symlink', (ledger, dir) => { rmSync(ledger); writeFileSync(join(dir, 'elsewhere.jsonl'), ''); symlinkSync(join(dir, 'elsewhere.jsonl'), ledger); }],
  ])('denies the absolute exception when the target ledger is %s', (_label, mutate) => {
    const {dir, root, run} = fixture();
    mutate(join(root, '.orchestrator', 'metrics', 'sessions.jsonl'), dir);
    expectDeny(run(`node '${script}' --apply --repo-root '${root}'`), '#1577');
  });

  it('allows a configured Vault prefix sibling', () => {
    const {root, run} = fixture('directory', 'vault-x');
    expectAllow(run(`node '${script}' --apply --repo-root '${root}'`));
  });

  it.each(['home/Projects/vault', 'home/Projects/vault/consumer'])('falls back to the canonical HOME Vault on resolver failure (%s)', (rootName) => {
    const {root, run, git} = fixture('directory', rootName);
    expectDeny(run(`node '${script}' --apply --repo-root '${root}'`, {
      execArgv: [...git, ...brokenModuleBoot({moduleBasename: 'config.mjs'})],
    }), '#1577');
  });

  it.each(['home/Projects/vault-x', 'home/Projects/other/vault'])('keeps fallback segment-exact and narrow (%s)', (rootName) => {
    const {root, run, git} = fixture('directory', rootName);
    expectAllow(run(`node '${script}' --apply --repo-root '${root}'`, {
      execArgv: [...git, ...brokenModuleBoot({moduleBasename: 'config.mjs'})],
    }));
  });

  it('uses a measurable configured Vault instead of the HOME fallback', () => {
    const {root, run} = fixture('directory', 'home/Projects/vault');
    expectAllow(run(`node '${script}' --apply --repo-root '${root}'`));
  });

  it.each(['environment tilde', 'owner match', 'owner paths', 'committed tilde'])('excludes the winning resolved tier (%s)', (tier) => {
    const {dir, root, env, run} = fixture('directory', 'home/Projects/configured-vault/consumer');
    const vault = join(dir, 'home/Projects/configured-vault');
    const changedEnv = {...env, SO_VAULT_DIR: ''};
    // The unrelated invalid config value proves the narrow Vault parser is
    // used instead of parsing the entire Session Config.
    writeFileSync(join(root, 'CLAUDE.md'), `## Session Config\n\nagents-per-wave: invalid\nvault-integration:\n  vault-dir: ~/Projects/configured-vault\n`);
    if (tier === 'environment tilde') {
      changedEnv.SO_VAULT_DIR = '~/Projects/configured-vault';
      writeFileSync(join(dir, 'config/owner.yaml'), '[');
    } else if (tier === 'owner match') {
      writeFileSync(join(dir, 'config/owner.yaml'), `paths:\n  vault-dir: ${join(dir, 'vault')}\nvault-dirs:\n  - path: ${vault}\n    match:\n      path-prefix: ${root}\n`);
      writeFileSync(join(root, 'CLAUDE.md'), '# No committed Vault\n');
    } else if (tier === 'owner paths') {
      writeFileSync(join(dir, 'config/owner.yaml'), `paths:\n  vault-dir: ${vault}\n`);
      writeFileSync(join(root, 'CLAUDE.md'), '# No committed Vault\n');
    }
    expectDeny(run(`node '${script}' --apply --repo-root '${root}'`, {env: changedEnv}), '#1577');
  });

  it.each(['missing committed value', 'unparseable owner', 'unresolvable configured path'])('uses fallback when resolution is unmeasurable (%s)', (kind) => {
    const {dir, root, env, run} = fixture('directory', 'home/Projects/vault/consumer');
    const changedEnv = {...env, SO_VAULT_DIR: ''};
    writeFileSync(join(root, 'CLAUDE.md'), '# No committed Vault\n');
    if (kind === 'unparseable owner') writeFileSync(join(dir, 'config/owner.yaml'), '[');
    if (kind === 'unresolvable configured path') changedEnv.SO_VAULT_DIR = join(dir, 'does-not-exist');
    expectDeny(run(`node '${script}' --apply --repo-root '${root}'`, {env: changedEnv}), '#1577');
  });

  it.each(['invalid required section', 'invalid higher match tier'])('does not mistake owner defaults for measurable resolution (%s)', (kind) => {
    const {dir, root, env, run} = fixture('directory', 'home/Projects/vault/consumer');
    const owner = kind === 'invalid required section' ? 'tone:\n  style: invalid\n' : `vault-dirs: invalid\npaths:\n  vault-dir: ${join(dir, 'vault')}\n`;
    writeFileSync(join(dir, 'config/owner.yaml'), owner);
    writeFileSync(join(root, 'CLAUDE.md'), `vault-integration:\n  vault-dir: ${join(dir, 'vault')}\n`);
    expectDeny(run(`node '${script}' --apply --repo-root '${root}'`, {env: {...env, SO_VAULT_DIR: ''}}), '#1577');
  });

  it('keeps a valid owner match authoritative despite an invalid lower paths tier', () => {
    const {dir, root, env, run} = fixture('directory', 'vault/consumer');
    writeFileSync(join(dir, 'config/owner.yaml'), `paths: invalid\nvault-dirs:\n  - path: ${join(dir, 'vault')}\n    match:\n      path-prefix: ${root}\n`);
    expectDeny(run(`node '${script}' --apply --repo-root '${root}'`, {env: {...env, SO_VAULT_DIR: ''}}), '#1577');
  });

  it('canonicalizes a symlink HOME for the narrow fallback', () => {
    const {dir, root, env, run, git} = fixture('directory', 'home/Projects/vault/consumer');
    const homeLink = join(dir, 'home-link');
    symlinkSync(env.HOME, homeLink);
    expectDeny(run(`node '${script}' --apply --repo-root '${root}'`, {
      env: {...env, HOME: homeLink}, execArgv: [...git, ...brokenModuleBoot({moduleBasename: 'config.mjs'})],
    }), '#1577');
  });

  it.each(['explicit', 'subdirectory', 'worktree'])('allows the bound installed command (%s)', (kind) => {
    const {root, run} = fixture(kind === 'worktree' ? 'file' : 'directory');
    const suffix = ` --repo-root '${root}'`;
    expectAllow(run(`node '${script}' --apply${suffix}`, kind === 'subdirectory'
      ? {cwd: join(root, 'sub'), payloadCwd: join(root, 'sub')} : {}));
  });

  it.each([false, true])('allows an exact explicit root (single quotes: %s)', (quoted) => {
    const {root, run} = fixture('directory', 'consumer');
    const operand = quoted ? `'${root}'` : root;
    expectAllow(run(`node '${script}' --apply --repo-root ${operand}`));
  });

  it.each([
    ['missing root', () => ''],
    ['empty root', () => ' --repo-root='],
    ['parent traversal', (root) => ` --repo-root '${root}/..'`],
    ['trailing slash', (root) => ` --repo-root '${root}/'`],
    ['file override', (root) => ` --repo-root '${root}' --file .orchestrator/metrics/sessions.jsonl`],
  ])('denies %s', (_label, suffix) => {
    const {root, run} = fixture();
    expectDeny(run(`node '${script}' --apply${suffix(root)}`), 'repair-invalid-sessions.mjs --apply');
  });

  it.each([
    ['semicolon before', (command) => `echo before; ${command}`],
    ['semicolon after', (command) => `${command}; echo after`],
    ['AND before', (command) => `echo before && ${command}`],
    ['AND after', (command) => `${command} && echo after`],
    ['NODE_OPTIONS prefix', (command) => `NODE_OPTIONS= ${command}`],
  ])('denies %s around an explicit-root command', (_label, wrap) => {
    const {root, run} = fixture();
    expectDeny(run(wrap(`node '${script}' --apply --repo-root '${root}'`)), 'repair-invalid-sessions.mjs --apply');
  });

  it('denies a nested CLAUDE.md without explicit root despite the hook launcher root', () => {
    const {root, env, run} = fixture();
    const sub = join(root, 'sub');
    writeFileSync(join(sub, 'CLAUDE.md'), '# Nested project\n');
    const overrides = {cwd: sub, payloadCwd: sub, env: {...env, CLAUDE_PROJECT_DIR: root}};
    expectDeny(run(`node '${script}' --apply`, overrides), '#1577');
    expectAllow(run(`node '${script}' --apply --repo-root '${root}'`, overrides));
  });

  // #1656: the explicit-root exception no longer consults getProjectDir(), so
  // a broken platform.mjs cannot decide it — and still cannot disarm the guard.
  it('judges an explicit root without platform.mjs and without disarming the relative contract', () => {
    const {root, run, git} = fixture();
    const execArgv = [...git, ...brokenModuleBoot({moduleBasename: 'platform.mjs'})];
    expectAllow(run(`node '${script}' --apply --repo-root '${root}'`, {execArgv}));
    expectAllow(run('node scripts/repair-invalid-sessions.mjs --apply', {execArgv}));
    // A static-import/bootstrap disarm would silently allow this ledger write.
    expectDeny(run('echo x >> .orchestrator/metrics/sessions.jsonl', {execArgv}), 'Direct write');
  });

  it.each([
    ['extra flag', ' --json'], ['shell suffix', '; echo done'], ['pipe', ' | cat'],
    ['redirect', ' > /tmp/result'], ['trailing newline', '\n'], ['trailing CR', '\r'],
  ])('denies %s beside the otherwise valid absolute command', (_label, suffix) => {
    const {root, run} = fixture();
    expectDeny(run(`node '${script}' --apply --repo-root '${root}'${suffix}`), '#1577');
  });

  // Bug #1577/#1656: from a consumer worktree the launcher project dir names
  // the main checkout, so demanding agreement made the repair unreachable.
  // An explicit --repo-root is the whole target identity.
  it.each(['CLAUDE_PROJECT_DIR', 'CODEX_PROJECT_DIR', 'CURSOR_PROJECT_DIR', 'PI_PROJECT_DIR'])('ignores a disagreeing launcher context through %s when --repo-root is explicit', (name) => {
    const {dir, root, env, run} = fixture();
    expectAllow(run(`node '${script}' --apply --repo-root '${root}'`, {env: {...env, [name]: dir}}));
  });

  it('allows a different payload context but denies an explicit subdirectory target', () => {
    const {dir, root, run} = fixture();
    const secondRoot = join(dir, 'second-root');
    mkdirSync(secondRoot);
    mkdirSync(join(secondRoot, '.git'));
    const identityProbe = childProcessBoot(`(command, args, options) => {
      if (command !== 'git') return originalSpawnSync(command, args, options);
      return {status: 0, stdout: args[1] + '\\n'};
    }`);
    const command = `node '${script}' --apply --repo-root '${root}'`;
    expectAllow(run(command, {execArgv: identityProbe}));
    // A successful Git probe alone cannot authorize an explicit non-top-level.
    expectDeny(run(`node '${script}' --apply --repo-root '${root}/sub'`), '#1577');
    // The payload cwd is not the repair target; --repo-root is (#1656).
    expectAllow(run(command, {
      payloadCwd: secondRoot,
      execArgv: identityProbe,
    }));
  });

  it('denies a --repo-root for which Git reports a different top-level (core.worktree redirect)', () => {
    const {dir, root, run} = fixture();
    const redirectedRoot = join(dir, 'redirected-root');
    mkdirSync(redirectedRoot);
    mkdirSync(join(redirectedRoot, '.git'));
    mkdirSync(join(redirectedRoot, '.orchestrator', 'metrics'), {recursive: true});
    writeFileSync(join(redirectedRoot, '.orchestrator', 'metrics', 'sessions.jsonl'), '');
    // The fixture probe answers `root` for every -C path: Git at B reports A,
    // so B is not its own top-level and must not become the repair target.
    expectDeny(run(`node '${script}' --apply --repo-root '${redirectedRoot}'`), '#1577');
    expectAllow(run(`node '${script}' --apply --repo-root '${root}'`));
  });

  it('denies script and target symlinks rather than authorizing their realpaths', () => {
    const {dir, root, run} = fixture();
    const linkedScript = join(dir, 'repair-invalid-sessions.mjs');
    const linkedRoot = join(dir, 'linked-root');
    symlinkSync(script, linkedScript);
    symlinkSync(root, linkedRoot);
    expectDeny(run(`node '${linkedScript}' --apply --repo-root '${root}'`), '#1577');
    expectDeny(run(`node '${script}' --apply --repo-root '${linkedRoot}'`), '#1577');
  });

  it('denies a symlink Git marker even with a successful top-level probe', () => {
    const {dir, env, root, run} = fixture();
    const linked = join(dir, 'linked-marker-root');
    mkdirSync(linked);
    symlinkSync(join(root, '.git'), join(linked, '.git'));
    expectDeny(run(`node '${script}' --apply --repo-root '${linked}'`, {
      cwd: linked, payloadCwd: linked, env,
      execArgv: childProcessBoot(`() => ({status: 0, stdout: ${JSON.stringify(linked + '\n')}})`),
    }), '#1577');
  });

  it('keeps unrelated absolute script operands outside the new exception', () => {
    const {run} = fixture();
    expectAllow(run('node /tmp/other-script.mjs --note repair-invalid-sessions.mjs --apply'));
  });

  it('denies EPERM despite a successful status and otherwise valid Git identity', () => {
    const {root, run} = fixture();
    const command = `node '${script}' --apply --repo-root '${root}'`;
    // Control: the same filesystem/context and healthy Git identity authorize.
    expectAllow(run(command));
    expectDeny(run(command, {
      execArgv: childProcessBoot(`(command, args, options) => {
        if (command !== 'git') return originalSpawnSync(command, args, options);
        return {
          error: Object.assign(new Error('Denied'), {code: 'EPERM'}),
          status: 0, stdout: ${JSON.stringify(root + '\n')},
        };
      }`),
    }), '#1577');
  });

  it.each([
    ['not Git', `() => ({status: 128, stdout: ''})`],
    ['empty successful output', `() => ({status: 0, stdout: ''})`],
  ])('denies unmeasurable Git identity (%s)', (_label, source) => {
    const {root, run} = fixture();
    expectDeny(run(`node '${script}' --apply --repo-root '${root}'`, {execArgv: childProcessBoot(source)}), '#1577');
  });

  it.each(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_CONFIG_COUNT'])('denies ambient Git identity override %s', (name) => {
    const {env, root, run} = fixture();
    expectDeny(run(`node '${script}' --apply --repo-root '${root}'`, {env: {...env, [name]: root}}), '#1577');
  });

  it.each([
    ['subshell', (command) => `$(${command})`],
    ['backticks', (command) => '`' + command + '`'],
    ['expansion in quoted path', () => `node "${script}" --apply --repo-root "$PWD"`],
    ['different Node', (command) => command.replace(/^node/, '/usr/bin/node')],
    ['Node option', (command) => command.replace(/^node/, 'node --no-warnings')],
  ])('denies %s', (_label, transform) => {
    const {root, run} = fixture();
    expectDeny(run(transform(`node '${script}' --apply --repo-root '${root}'`)), 'repair-invalid-sessions.mjs --apply');
  });
});

// ---------------------------------------------------------------------------
// #1656 (dup of #1577) — the guard denied `repair-invalid-sessions.mjs --apply
// --repo-root <toplevel>` from a consumer session: the relative form allowed
// only the bare exact string, and the absolute form demanded that the
// launcher project dir (the consumer's main checkout) equal the target
// worktree. These rows run REAL `git init` repos — no identity stub — from an
// unrelated cwd with a disagreeing CLAUDE_PROJECT_DIR, i.e. the consumer shape.
// ---------------------------------------------------------------------------
describe('#1656 — explicit --repo-root against a real Git top-level', () => {
  const script = resolve(import.meta.dirname, '../../scripts/repair-invalid-sessions.mjs');
  const REASON = 'repair-invalid-sessions.mjs --apply';
  const gitFree = Object.fromEntries(Object.keys(process.env).filter((name) => name.startsWith('GIT_')).map((name) => [name, undefined]));

  function realRepos() {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'ledger-guard-1656-')));
    onTestFinished(() => removeTree(dir));
    const makeRepo = (name, {ledger = true} = {}) => {
      const repo = join(dir, name);
      mkdirSync(repo, {recursive: true});
      const init = spawnSync('git', ['init', '-q', repo], {encoding: 'utf-8', env: {...process.env, ...gitFree}});
      expect(init.status).toBe(0);
      if (ledger) {
        mkdirSync(join(repo, '.orchestrator', 'metrics'), {recursive: true});
        writeFileSync(join(repo, LEDGER), '');
      }
      return repo;
    };
    for (const name of ['home', 'config', 'vault', 'elsewhere']) mkdirSync(join(dir, name));
    const env = {
      ...gitFree, HOME: join(dir, 'home'), SO_CONFIG_HOME: join(dir, 'config'), SO_VAULT_DIR: join(dir, 'vault'),
      CLAUDE_PROJECT_DIR: join(dir, 'elsewhere'), CODEX_PROJECT_DIR: '', CURSOR_PROJECT_DIR: '', PI_PROJECT_DIR: '',
    };
    const run = (command) => {
      const result = runHook({command, cwd: join(dir, 'elsewhere'), payloadCwd: join(dir, 'elsewhere'), env});
      expect(result.error).toBeUndefined();
      return result;
    };
    return {dir, makeRepo, run};
  }

  it.each([
    ['relative script, --apply first', (repo) => `node scripts/repair-invalid-sessions.mjs --apply --repo-root ${repo}`],
    ['relative script, --repo-root first', (repo) => `node scripts/repair-invalid-sessions.mjs --repo-root ${repo} --apply`],
    ['plugin absolute script, --apply first', (repo) => `node ${script} --apply --repo-root ${repo}`],
    ['plugin absolute script, --repo-root first', (repo) => `node '${script}' --repo-root '${repo}' --apply`],
  ])('allows %s', (_label, build) => {
    const {makeRepo, run} = realRepos();
    expectAllow(run(build(makeRepo('consumer-wt'))));
  });

  // #1670 — measured ALLOW at d4fcdf08 for every row: the guard knew only Node's
  // verb names, so another runner of the repair CLI skipped the allowance AND its
  // --repo-root checks. The contract: never broader than `node`; outside the node
  // grammar the runner is denied, even against a root `node` may repair.
  it.each([
    ['bun', (repo) => `bun scripts/repair-invalid-sessions.mjs --apply --repo-root ${repo}`],
    ['bun run', (repo) => `bun run scripts/repair-invalid-sessions.mjs --apply --repo-root ${repo}`],
    ['deno run -A', (repo) => `deno run -A scripts/repair-invalid-sessions.mjs --apply --repo-root ${repo}`],
    ['npx node', (repo) => `npx node scripts/repair-invalid-sessions.mjs --apply --repo-root ${repo}`],
    ['npm exec -- node', (repo) => `npm exec -- node scripts/repair-invalid-sessions.mjs --apply --repo-root ${repo}`],
    ['$(which node)', (repo) => `$(which node) scripts/repair-invalid-sessions.mjs --apply --repo-root ${repo}`],
    ['`which node`', (repo) => `\`which node\` scripts/repair-invalid-sessions.mjs --repo-root ${repo} --apply`],
  ])('denies the repair CLI run by %s where node itself is allowed', (_label, build) => {
    const {makeRepo, run} = realRepos();
    const repo = makeRepo('consumer-wt');
    expectAllow(run(`node scripts/repair-invalid-sessions.mjs --apply --repo-root ${repo}`));
    expectDeny(run(build(repo)), REASON);
  });

  it('allows a non-node runner of the repair CLI in its dry-run default', () => {
    // Bug: a runner rule keyed on the script operand alone would deny the
    // read-only preview, which never writes the ledger.
    const {makeRepo, run} = realRepos();
    expectAllow(run(`bun scripts/repair-invalid-sessions.mjs --dry-run --repo-root ${makeRepo('consumer-wt')}`));
  });

  it.each([
    ['echo', 'echo bun scripts/repair-invalid-sessions.mjs --apply'],
    ['grep', 'grep -n x scripts/repair-invalid-sessions.mjs --apply'],
  ])('allows %s that only names the repair CLI (never runs it)', (_verb, command) => {
    // Bug: the non-node runner rule treated every verb as a runner and denied
    // a print/search command that only mentions the script.
    const {run} = realRepos();
    expectAllow(run(command));
  });

  it.each([
    ['whitespace in the path', (repos) => `'${repos.makeRepo('has space')}'`],
    ['a character outside the charset', (repos) => repos.makeRepo('a,b')],
    ['a relative path', (repos) => { repos.makeRepo('rel'); return 'rel'; }],
    // Security review so-69: the Vault check judged the plain root while the
    // script follows symlinks — a scratch repo linking into the Vault slipped by.
    ['an .orchestrator/ symlinked into the Vault', (repos) => {
      const repo = repos.makeRepo('evil-orch', {ledger: false});
      mkdirSync(join(repos.dir, 'vault', '.orchestrator', 'metrics'), {recursive: true});
      writeFileSync(join(repos.dir, 'vault', LEDGER), '');
      symlinkSync(join(repos.dir, 'vault', '.orchestrator'), join(repo, '.orchestrator'));
      return repo;
    }],
    ['a metrics/ symlinked into the Vault', (repos) => {
      const repo = repos.makeRepo('evil-metrics', {ledger: false});
      mkdirSync(join(repos.dir, 'vault', '.orchestrator', 'metrics'), {recursive: true});
      writeFileSync(join(repos.dir, 'vault', LEDGER), '');
      mkdirSync(join(repo, '.orchestrator'), {recursive: true});
      symlinkSync(join(repos.dir, 'vault', '.orchestrator', 'metrics'), join(repo, '.orchestrator', 'metrics'));
      return repo;
    }],
    ['a non-top-level subdirectory', (repos) => {
      const sub = join(repos.makeRepo('outer'), 'sub');
      mkdirSync(join(sub, '.orchestrator', 'metrics'), {recursive: true});
      writeFileSync(join(sub, LEDGER), '');
      return sub;
    }],
    ['a nonexistent path', (repos) => join(repos.dir, 'missing')],
    ['a top-level without the ledger', (repos) => repos.makeRepo('no-ledger', {ledger: false})],
    ['a directory that is no Git repo', (repos) => {
      const plain = join(repos.dir, 'plain');
      mkdirSync(join(plain, '.orchestrator', 'metrics'), {recursive: true});
      writeFileSync(join(plain, LEDGER), '');
      return plain;
    }],
  ])('denies a --repo-root with %s', (_label, rootFor) => {
    const repos = realRepos();
    const root = rootFor(repos);
    expectDeny(repos.run(`node scripts/repair-invalid-sessions.mjs --apply --repo-root ${root}`), REASON);
    expectDeny(repos.run(`node ${script} --apply --repo-root ${root}`), REASON);
  });

  it.each([
    ['an extra argument', (c) => `${c} --json`],
    ['a second --repo-root', (c, repo) => `${c} --repo-root ${repo}`],
    ['the = spelling', (c, repo) => c.replace(` --repo-root ${repo}`, ` --repo-root=${repo}`)],
    ['a chained command', (c) => `${c}; echo done`],
    ['an AND chain', (c) => `${c} && true`],
    ['a cd prefix', (c, repo) => `cd ${repo} && ${c}`],
    ['a pipe', (c) => `${c} | cat`],
    ['a subshell', (c) => `(${c})`],
    ['command substitution', (c) => `$(${c})`],
  ])('denies %s around a valid explicit-root command', (_label, wrap) => {
    const {makeRepo, run} = realRepos();
    const repo = makeRepo('consumer-wt');
    for (const base of [`node scripts/repair-invalid-sessions.mjs --apply --repo-root ${repo}`, `node ${script} --apply --repo-root ${repo}`]) {
      expectDeny(run(wrap(base, repo)), REASON);
    }
  });

  it('denies a foreign absolute copy of the repair script and names the sanctioned forms', () => {
    const {dir, makeRepo, run} = realRepos();
    const repo = makeRepo('consumer-wt');
    const foreign = join(dir, 'scripts', 'repair-invalid-sessions.mjs');
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(foreign, '');
    expectDeny(run(`node ${foreign} --apply --repo-root ${repo}`), [REASON, '--repo-root <absolute-git-toplevel>']);
  });
});
