/**
 * tests/lib/scope-echo.test.mjs — the receive-side scope-echo helper (#1092).
 *
 * Each `it` names the concrete bug it catches (TV-001). The CLI case is the one
 * that needs a child process: it is the only way to exercise the argv[1] guard,
 * the `--emit` path and the payload-discipline promise (no path in the record)
 * against a real `events.jsonl`.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SCOPE_CHECKED_EVENT,
  SCOPE_ECHO_EVENT,
  SCOPE_MATERIALIZED_EVENT,
  checkScopeEcho,
  extractScopeEcho,
  renderScopeEchoInstruction,
  scopeDigest,
  main,
  scopeEchoPayload,
  verifyWaveScope,
} from '../../scripts/lib/scope-echo.mjs';
import { makeTmpDir, removeTree } from '../_helpers/tmp-fixture.mjs';
import { telemetryIsolationEnv } from '../_helpers/telemetry-isolation.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(REPO_ROOT, 'scripts', 'lib', 'scope-echo.mjs');

/** @type {string} */
let tmp;

beforeEach(() => {
  tmp = makeTmpDir('so-scope-echo-');
});

afterEach(() => {
  removeTree(tmp);
});

/**
 * Write a per-agent scope file (shape (a): a JSON array of path strings).
 * @param {string[]} paths
 * @returns {string} absolute path to the written file
 */
function writeScopeFile(paths) {
  const p = join(tmp, 'scope.json');
  writeFileSync(p, JSON.stringify(paths), 'utf8');
  return p;
}

describe('scopeDigest', () => {
  it('is independent of order — two coordinators listing the same set disagree otherwise', () => {
    expect(scopeDigest(['b.mjs', 'a.mjs'])).toBe(scopeDigest(['a.mjs', 'b.mjs']));
  });

  it('is independent of surrounding whitespace and duplicates', () => {
    expect(scopeDigest(['  a.mjs  ', 'a.mjs', '', 'b.mjs'])).toBe(scopeDigest(['a.mjs', 'b.mjs']));
  });

  it('distinguishes different scopes — a constant digest would make every check vacuously true', () => {
    expect(scopeDigest(['a.mjs'])).not.toBe(scopeDigest(['b.mjs']));
    expect(scopeDigest(['a.mjs'])).toMatch(/^[0-9a-f]{8}$/);
  });

  it('returns the empty-string digest for an empty or unusable scope, never throwing', () => {
    const empty = scopeDigest([]);
    expect(empty).toMatch(/^[0-9a-f]{8}$/);
    expect(scopeDigest(null)).toBe(empty);
    expect(scopeDigest('not-an-array')).toBe(empty);
    expect(scopeDigest([42, null])).toBe(empty);
  });
});

describe('renderScopeEchoInstruction', () => {
  it('names the exact digest the agent must echo, so the round trip closes', () => {
    const paths = ['scripts/lib/scope-echo.mjs'];
    const line = renderScopeEchoInstruction(paths);
    expect(line).toBe(`End your final report with the line: SCOPE-DIGEST: ${scopeDigest(paths)}`);
    expect(extractScopeEcho(line)).toEqual({ echoed: true, digest: scopeDigest(paths) });
  });
});

describe('extractScopeEcho', () => {
  const cases = [
    ['plain line', 'SCOPE-DIGEST: 0123abcd', { echoed: true, digest: '0123abcd' }],
    ['backticked line', 'report\n`SCOPE-DIGEST: 0123abcd`\n', { echoed: true, digest: '0123abcd' }],
    ['trailing whitespace', 'SCOPE-DIGEST: 0123abcd   \n', { echoed: true, digest: '0123abcd' }],
    ['no marker at all', 'STATUS: done', { echoed: false, digest: null }],
    ['seven hex chars', 'SCOPE-DIGEST: 0123abc', { echoed: false, digest: null }],
    ['nine hex chars', 'SCOPE-DIGEST: 0123abcde', { echoed: false, digest: null }],
    ['lowercase lookalike marker', 'scope-digest: 0123abcd', { echoed: false, digest: null }],
    ['uppercase hex payload (normalized to lowercase)', 'SCOPE-DIGEST: 0123ABCD', { echoed: true, digest: '0123abcd' }],
    ['mixed-case hex payload', 'SCOPE-DIGEST: 0123AbCd', { echoed: true, digest: '0123abcd' }],
    ['uppercase marker is still not an echo', 'SCOPE-digest: 0123abcd', { echoed: false, digest: null }],
  ];

  for (const [name, input, expected] of cases) {
    it(`handles ${name}`, () => {
      expect(extractScopeEcho(input)).toEqual(expected);
    });
  }

  it('handles non-string and nullish input alike — a throw here would fail a wave', () => {
    for (const input of [42, null, undefined, {}]) {
      expect(extractScopeEcho(input)).toEqual({ echoed: false, digest: null });
    }
  });

  it('takes the LAST marker — an agent that quotes its instruction then reports would echo the prompt', () => {
    const report = 'instruction was SCOPE-DIGEST: aaaaaaaa\n...\nSCOPE-DIGEST: bbbbbbbb\n';
    expect(extractScopeEcho(report)).toEqual({ echoed: true, digest: 'bbbbbbbb' });
  });

  it('is not stateful across calls — a shared /g regex would skip every second match', () => {
    const report = 'SCOPE-DIGEST: 0123abcd';
    expect(extractScopeEcho(report)).toEqual(extractScopeEcho(report));
  });
});

describe('checkScopeEcho', () => {
  it('matches when the agent echoed the digest of its own scope file', () => {
    const paths = ['scripts/lib/scope-echo.mjs', 'tests/lib/scope-echo.test.mjs'];
    const verdict = checkScopeEcho({
      scopeFilePath: writeScopeFile(paths),
      reportText: `STATUS: done\n${renderScopeEchoInstruction(paths)}\n`,
    });
    expect(verdict).toEqual({
      echoed: true,
      match: true,
      expected: scopeDigest(paths),
      actual: scopeDigest(paths),
    });
  });

  it('reports digest-mismatch when the echoed digest belongs to a different scope', () => {
    const verdict = checkScopeEcho({
      scopeFilePath: writeScopeFile(['a.mjs']),
      reportText: `SCOPE-DIGEST: ${scopeDigest(['b.mjs'])}`,
    });
    expect(verdict.match).toBe(false);
    expect(verdict.echoed).toBe(true);
    expect(verdict.reason).toBe('digest-mismatch');
  });

  it('reports echo-absent (not a mismatch) when the report carries no marker', () => {
    const verdict = checkScopeEcho({
      scopeFilePath: writeScopeFile(['a.mjs']),
      reportText: 'STATUS: done',
    });
    expect(verdict).toMatchObject({ echoed: false, match: false, reason: 'echo-absent' });
  });

  it('marks an EMPTY declared scope not-applicable instead of counting it as a missing echo', () => {
    // Catches: a Discovery agent (scope `[]`) is never handed an instruction
    // line, so `echo-absent` counted it as a failed echo and dragged the
    // echo-rate down with agents that were never instructed.
    const verdict = checkScopeEcho({ scopeFilePath: writeScopeFile([]), reportText: 'STATUS: done' });
    expect(verdict).toEqual({
      echoed: false,
      match: false,
      expected: null,
      actual: null,
      applicable: false,
      reason: 'scope-empty',
    });
    // The payload carries the filter key; an instructed verdict must NOT carry it.
    expect(scopeEchoPayload(verdict)).toMatchObject({ applicable: false, reason: 'scope-empty' });
    expect(
      scopeEchoPayload({ echoed: true, match: true, expected: 'a', actual: 'a' }),
    ).not.toHaveProperty('applicable');
  });

  it('returns scope-file-unreadable instead of throwing on a missing file', () => {
    expect(
      checkScopeEcho({ scopeFilePath: join(tmp, 'nope.json'), reportText: 'SCOPE-DIGEST: 0123abcd' }),
    ).toMatchObject({ match: false, reason: 'scope-file-unreadable' });
  });

  it('returns scope-file-unreadable for a JSON object (shape (b) passed by mistake)', () => {
    const p = join(tmp, 'wrong.json');
    writeFileSync(p, JSON.stringify({ id: 'W2-C5', files: ['a.mjs'] }), 'utf8');
    expect(checkScopeEcho({ scopeFilePath: p, reportText: '' })).toMatchObject({
      match: false,
      reason: 'scope-file-unreadable',
    });
  });

  it('never throws on missing arguments', () => {
    expect(() => checkScopeEcho()).not.toThrow();
    expect(checkScopeEcho().match).toBe(false);
  });
});

describe('scopeEchoPayload', () => {
  it('omits wave rather than defaulting it to 0 (absent is not zero)', () => {
    const payload = scopeEchoPayload({ echoed: true, match: true, expected: 'a', actual: 'a' });
    expect('wave' in payload).toBe(false);
    expect(scopeEchoPayload({ echoed: true, match: true, expected: 'a', actual: 'a' }, { wave: 0 })).not.toHaveProperty('wave');
    expect(scopeEchoPayload({ echoed: true, match: true, expected: 'a', actual: 'a' }, { wave: '3' })).toMatchObject({ wave: 3 });
  });

  it('clamps agent_id to 120 characters', () => {
    const payload = scopeEchoPayload(
      { echoed: false, match: false, expected: null, actual: null },
      { agentId: 'x'.repeat(400) },
    );
    expect(String(payload.agent_id)).toHaveLength(120);
  });
});

/**
 * Run the CLI, throwing on a non-zero exit.
 * @param {string[]} args
 * @param {string} cwd
 */
const run = (args, cwd) =>
  execFileSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...telemetryIsolationEnv() },
  });

/** Run the CLI tolerating a non-zero exit; returns { status, stdout, stderr }. */
const runRaw = (args, cwd) => {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...telemetryIsolationEnv() },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
};

describe('CLI', () => {

  it('prints only the instruction line in --instruction mode, and nothing for an empty scope', () => {
    const scoped = writeScopeFile(['a.mjs']);
    expect(run(['--scope-file', scoped, '--instruction'], tmp).trim()).toBe(
      renderScopeEchoInstruction(['a.mjs']),
    );
    const emptyScope = join(tmp, 'empty.json');
    writeFileSync(emptyScope, '[]', 'utf8');
    expect(run(['--scope-file', emptyScope, '--instruction'], tmp)).toBe('');
  });

  it('--emit writes exactly one events.jsonl row, with no path field in the payload', () => {
    const paths = ['scripts/lib/scope-echo.mjs', '01-projects/private-slug/notes.md'];
    const scopeFile = writeScopeFile(paths);
    const reportFile = join(tmp, 'report.md');
    writeFileSync(reportFile, `STATUS: done\n${renderScopeEchoInstruction(paths)}\n`, 'utf8');
    mkdirSync(join(tmp, '.orchestrator', 'metrics'), { recursive: true });

    const stdout = run(
      [
        '--scope-file', scopeFile,
        '--report-file', reportFile,
        '--wave', '2',
        '--agent-id', 'W2-C5 code-implementer',
        '--emit',
      ],
      tmp,
    );
    expect(JSON.parse(stdout.trim())).toMatchObject({ echoed: true, match: true, wave: 2 });

    const lines = readFileSync(join(tmp, '.orchestrator', 'metrics', 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.event).toBe('orchestrator.wave_dispatch.scope_echo_checked');
    expect(record).toMatchObject({ match: true, echoed: true, agent_id: 'W2-C5 code-implementer' });
    // Payload discipline (#1092 AC3): this record travels over the webhook unredacted.
    expect(lines[0]).not.toContain('private-slug');
    expect(lines[0]).not.toContain('scripts/lib/scope-echo.mjs');
  });

  it('exits 1 (user error, not 2) and prints usage when --scope-file is missing', () => {
    // Catches: exit 2 claims a SYSTEM error for what is a bad invocation
    // (.claude/rules/cli-design.md — 1 = user/input error).
    const res = runRaw([], tmp);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--scope-file <path> is required');
    expect(res.stderr).toContain('Usage:');
    expect(res.stdout).toBe('');
  });

  it('--help prints usage on stdout and exits 0', () => {
    const res = runRaw(['--help'], tmp);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Usage:');
    // Adjusted with #1092's `--verify` mode, which adds a second required-flag
    // case to the same sentence ("…or, under --verify, a missing --wave /
    // --state-dir"). What is pinned is the CONTRACT `cli-design.md` names — 0
    // for every verdict, 1 for the caller's own missing flag — not the
    // punctuation that followed it.
    expect(res.stdout).toContain('Exit codes: 0 for every verdict, 1 for a missing --scope-file');
    expect(res.stdout).toContain('--verify --wave <N> --state-dir <dir>');
    expect(res.stderr).toBe('');
  });

  it('--instruction on a CORRUPT scope file says so on stderr instead of failing silently', () => {
    // Catches: a corrupt scope file and a legitimate empty Discovery scope were
    // both exit 0 with no output on either stream — indistinguishable, so a
    // broken wave looked exactly like an uninstructed one.
    const corrupt = join(tmp, 'corrupt.json');
    writeFileSync(corrupt, '{ this is not json', 'utf8');
    const res = runRaw(['--scope-file', corrupt, '--instruction'], tmp);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('unreadable');
    expect(res.stderr).toContain('no echo line injected');
  });

  it('--emit still prints the verdict and exits 0 when the ledger is unwritable', () => {
    // Catches: telemetry failure swallowing the verdict. events.jsonl exists as
    // a DIRECTORY here, so every append attempt fails.
    const paths = ['a.mjs'];
    const scopeFile = writeScopeFile(paths);
    const reportFile = join(tmp, 'report.md');
    writeFileSync(reportFile, `STATUS: done\n${renderScopeEchoInstruction(paths)}\n`, 'utf8');
    mkdirSync(join(tmp, '.orchestrator', 'metrics', 'events.jsonl'), { recursive: true });

    const res = runRaw(['--scope-file', scopeFile, '--report-file', reportFile, '--emit'], tmp);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toMatchObject({ echoed: true, match: true });
    expect(res.stderr).toContain('scope-echo: emit failed');
  });

  it('accepts an UPPERCASE hex echo end-to-end — same 32 bits, so it is an echo', () => {
    const paths = ['a.mjs'];
    const scopeFile = writeScopeFile(paths);
    const reportFile = join(tmp, 'report.md');
    writeFileSync(reportFile, `SCOPE-DIGEST: ${scopeDigest(paths).toUpperCase()}\n`, 'utf8');
    const res = runRaw(['--scope-file', scopeFile, '--report-file', reportFile], tmp);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toMatchObject({ echoed: true, match: true });
  });

  it('emits a mismatch record rather than failing when the echo is absent', () => {
    const scopeFile = writeScopeFile(['a.mjs']);
    const reportFile = join(tmp, 'report.md');
    writeFileSync(reportFile, 'STATUS: done\n', 'utf8');
    const stdout = run(['--scope-file', scopeFile, '--report-file', reportFile], tmp);
    expect(JSON.parse(stdout.trim())).toMatchObject({ echoed: false, match: false, reason: 'echo-absent' });
  });
});

describe('--verify (the per-wave join)', () => {
  /**
   * A state dir carrying per-agent scope files plus a ledger built from RAW
   * lines — raw, because the shapes under test include ones `JSON.stringify`
   * cannot produce (a writer killed mid-append).
   *
   * @param {{wave?: number, scopes?: Record<string, string[]>, lines?: Array<string|object>}} spec
   * @returns {{stateDir: string, events: string}}
   */
  function fixture({ wave = 2, scopes = {}, lines = [] } = {}) {
    const stateDir = join(tmp, '.claude');
    const waveDir = join(stateDir, 'filescopes', `wave-${wave}`);
    mkdirSync(waveDir, { recursive: true });
    for (const [agentId, paths] of Object.entries(scopes)) {
      writeFileSync(join(waveDir, `${agentId}.json`), JSON.stringify(paths), 'utf8');
    }
    const events = join(tmp, 'ledger.jsonl');
    const body = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
    writeFileSync(events, lines.length ? `${body}\n` : '', 'utf8');
    return { stateDir, events };
  }

  it('exits 1 with usage when --verify is given without --wave / --state-dir', () => {
    // Catches: --verify takes no --scope-file, so the required-flag check for
    // the OTHER mode must not reject it first (and must not claim exit 2, a
    // SYSTEM error, for the caller's own bad invocation — cli-design.md).
    const res = runRaw(['--verify'], tmp);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--verify requires --wave <positive-int> and --state-dir <dir>');
    expect(res.stdout).toBe('');
  });

  it('reports a zero wave rather than failing when neither scope files nor ledger exist', () => {
    // Catches: step 3d-bis runs after EVERY wave, including one whose state dir
    // was never materialized. A throw there would turn the observability step
    // into the thing that breaks the checkpoint it was added to observe.
    const res = runRaw(
      ['--verify', '--wave', '2', '--state-dir', join(tmp, 'never-materialized'), '--json'],
      tmp,
    );
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual({
      wave: 2,
      transport: 'observable',
      dispatches: 0,
      injected: 0,
      echoed: 0,
      malformed_lines: 0,
      malformed_scope_files: 0,
      by_verdict: {},
      agents: [],
    });
  });

  it('counts an unparseable scope file instead of skipping it silently', () => {
    // Catches (#1379 P2): a corrupt per-agent scope file was dropped in a bare
    // `catch { continue }`, so its digest was never known and the wave reported
    // `digest-unknown` / `injection-missing` — byte-identical to a wave whose
    // injection genuinely never happened. The counter is the discriminator.
    const { stateDir, events } = fixture({ scopes: { 'w2-a1': ['scripts/a.mjs'] } });
    writeFileSync(join(stateDir, 'filescopes', 'wave-2', 'w2-a2.json'), '{"truncated', 'utf8');

    const res = runRaw(
      ['--verify', '--wave', '2', '--state-dir', stateDir, '--events', events, '--json'],
      tmp,
    );

    expect(res.status).toBe(0);
    const report = JSON.parse(res.stdout.trim());
    expect(report.malformed_scope_files).toBe(1);
    // ...and the valid sibling still digests (one agent row, not zero).
    expect(report.agents).toHaveLength(1);
    expect(report.agents[0].agent_id).toBe('w2-a1');
  });

  it('surfaces dropped ledger lines in the human table instead of printing a clean wave', () => {
    // Catches: a crashed writer's truncated append was skipped SILENTLY, so the
    // table read `1/1 injected, 1 echoed` with every digest `matched` — a clean
    // wave, from the instrument built to detect silent failure. The operator
    // reading that table has to be told the counts are a floor.
    const paths = ['scripts/lib/alpha.mjs'];
    const digest = scopeDigest(paths);
    const { stateDir, events } = fixture({
      scopes: { 'w2-a1': paths },
      lines: [
        { event: SCOPE_CHECKED_EVENT, wave: 2, agent_id: 'w2-a1', injected: true, scope_digest: digest },
        '{"event":"orchestrator.wave_dispatch.scope_ech',
        { event: SCOPE_ECHO_EVENT, wave: 2, agent_id: 'w2-a1', echoed: true, actual_digest: digest },
      ],
    });

    const res = runRaw(
      ['--verify', '--wave', '2', '--state-dir', stateDir, '--events', events],
      tmp,
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('WARNING: 1 malformed ledger line(s) skipped');
    expect(res.stdout).toContain('counts and verdicts below are a floor, not a census');
    // ...and the join still resumed past the broken line.
    expect(res.stdout).toContain(`${digest}  matched`);
  });

  it('--emit writes one scope_verified row carrying malformed_lines and no agent_id', () => {
    // Catches two at once: (a) a partial read that is visible on the terminal
    // but not in the ledger is unfalsifiable after the fact (HR-105); (b) this
    // record travels over the unredacted Clank webhook, and an agent_id is a
    // free-form coordinator string that has carried private project slugs.
    const paths = ['01-projects/private-slug/notes.md'];
    const { stateDir, events } = fixture({
      scopes: { 'w2-a1': paths },
      lines: ['{"event":"half-written', '{"event":"also-half'],
    });
    mkdirSync(join(tmp, '.orchestrator', 'metrics'), { recursive: true });

    const res = runRaw(
      ['--verify', '--wave', '2', '--state-dir', stateDir, '--events', events, '--emit', '--json'],
      tmp,
    );
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim()).malformed_lines).toBe(2);

    const rows = readFileSync(join(tmp, '.orchestrator', 'metrics', 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean);
    expect(rows).toHaveLength(1);
    const record = JSON.parse(rows[0]);
    expect(record).toMatchObject({
      event: 'orchestrator.wave_dispatch.scope_verified',
      wave: 2,
      malformed_lines: 2,
      by_verdict: { 'injection-missing': 1 },
    });
    expect(record).not.toHaveProperty('agent_id');
    expect(rows[0]).not.toContain('private-slug');
  });

  it('--session excludes a peer session running the same wave number in the same working copy', () => {
    // Catches: two sessions share one working copy and one ledger (PSA-001), so
    // wave 2 of a peer session is indistinguishable from mine without the
    // filter — its dispatch would join MY scope file's digest and report
    // `matched` for an injection my session never made.
    const paths = ['scripts/lib/alpha.mjs'];
    const digest = scopeDigest(paths);
    const { stateDir, events } = fixture({
      scopes: { 'w2-a1': paths },
      lines: [
        { event: SCOPE_MATERIALIZED_EVENT, wave: 2, transport_observable: true, semantic_session_id: 'mine' },
        {
          event: SCOPE_CHECKED_EVENT, wave: 2, agent_id: 'peer-a1', injected: true,
          scope_digest: digest, semantic_session_id: 'theirs',
        },
      ],
    });

    const unfiltered = verifyWaveScope({ wave: 2, stateDir, eventsPath: events });
    expect(unfiltered.dispatches).toBe(1);
    expect(unfiltered.agents).toEqual([{ agent_id: 'peer-a1', verdict: 'injected-not-echoed', digest }]);

    const mine = verifyWaveScope({ wave: 2, stateDir, session: 'mine', eventsPath: events });
    expect(mine.dispatches).toBe(0);
    expect(mine.agents).toEqual([{ agent_id: 'w2-a1', verdict: 'injection-missing', digest }]);
  });
});

describe('main() — the exported CLI seam', () => {
  /**
   * Call `main()` in-process with stdout/stderr captured. The spawn-based tests
   * above prove the BINARY behaves; these prove the exported function's RETURN
   * contract, which `process.exitCode = await main()` at module load depends on
   * and which a child's exit status cannot distinguish from a throw.
   *
   * @param {string[]} argv
   * @returns {Promise<{code: number, stdout: string, stderr: string}>}
   */
  async function callMain(argv) {
    let stdout = '';
    let stderr = '';
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += chunk;
      return true;
    });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += chunk;
      return true;
    });
    try {
      const code = await main(argv);
      return { code, stdout, stderr };
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  }

  it('returns a NUMBER for every mode — a thrown error would exit non-zero with a stack trace', async () => {
    // Catches: the module's own promise (docblock — "nothing here throws on
    // malformed input; a broken echo check must never change a wave's
    // outcome"). A throw from any of these reaches the module-level
    // `process.exitCode = await main()` as an unhandled rejection, so the
    // observability step becomes the thing that fails the checkpoint.
    await expect(callMain(['--help'])).resolves.toMatchObject({ code: 0 });
    // every required flag missing, in both modes
    await expect(callMain([])).resolves.toMatchObject({ code: 1 });
    await expect(callMain(['--verify'])).resolves.toMatchObject({ code: 1 });
    await expect(callMain(['--verify', '--wave', 'not-a-number', '--state-dir', tmp]))
      .resolves.toMatchObject({ code: 1 });
    // an unreadable scope file, an absent report file, an absent ledger
    await expect(callMain(['--scope-file', join(tmp, 'gone.json'), '--instruction']))
      .resolves.toMatchObject({ code: 0 });
    await expect(callMain(['--scope-file', join(tmp, 'gone.json'), '--report-file', join(tmp, 'gone.md')]))
      .resolves.toMatchObject({ code: 0 });
  });

  it('reports a wave over an absent ledger as all-zero rather than as a failure', async () => {
    // Catches: "no ledger yet" is the state of every wave 1 before its first
    // dispatch. Reading that as an error (or as a throw) would make step 3d-bis
    // red on a healthy session.
    const res = await callMain([
      '--verify', '--wave', '7', '--state-dir', join(tmp, 'empty-state'),
      '--events', join(tmp, 'no-such-ledger.jsonl'), '--json',
    ]);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toMatchObject({
      wave: 7, dispatches: 0, injected: 0, echoed: 0, malformed_lines: 0, agents: [],
    });
  });
});
