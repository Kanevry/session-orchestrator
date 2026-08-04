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

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expectAllow, expectDeny } from '../_helpers/hook-decision.mjs';

const HOOK = resolve(import.meta.dirname, '../..', 'hooks/pre-bash-sessions-ledger-guard.mjs');
const LEDGER = '.orchestrator/metrics/sessions.jsonl';

/**
 * Spawn the hook with a JSON PreToolUse payload on stdin.
 * SO_DISABLED_HOOKS / SO_HOOK_PROFILE are cleared so an operator's ambient
 * bypass cannot silently turn every deny assertion into a vacuous allow.
 */
function runHook({ toolName = 'Bash', command = '', env = {} } = {}) {
  return spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: toolName, tool_input: { command } }),
    encoding: 'utf-8',
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, SO_DISABLED_HOOKS: '', SO_HOOK_PROFILE: '', ...env },
  });
}

describe('pre-bash-sessions-ledger-guard', () => {
  describe('denies a direct write to the ledger', () => {
    it('blocks the #958 shape — a hand-composed record appended with >>', () => {
      // The bug: this exact command class put a schema-invalid record into the
      // ledger. Without the guard it runs and the corruption is silent.
      const env = runHook({ command: `echo '{"session_id":"x"}' >> ${LEDGER}` });
      const denial = expectDeny(env, 'emit-session.mjs');
      // The operator must be told the sanctioned path, not just "blocked":
      // a deny whose text carries no route is what agents read as a crash and
      // route around (the #906 failure mode).
      expect(denial.hookSpecificOutput.permissionDecisionReason).toContain(LEDGER);
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
      // Precision of WRAPPER_FILE_FLAGS: `stdbuf -o` names a BUFFERING MODE,
      // not a file, and shares its spelling with `time -o`. Treating every
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
