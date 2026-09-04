/**
 * tests/lib/wave-transcript-tail.test.mjs
 *
 * FA-1 wave-supervision tailer (#1114, PRD § FA-1).
 *
 * Fixtures are hand-written against the REAL record key sets measured on
 * 2026-08-25 in
 * ~/.claude/projects/<encoded-repo>/<session-uuid>/subagents/agent-<id>.jsonl:
 *   - assistant record: {parentUuid,isSidechain,agentId,message,requestId,type,
 *     uuid,timestamp,cwd,sessionId,version,gitBranch}
 *   - failed tool result: type "user", `toolUseResult` degraded to a STRING,
 *     and the content block carrying `is_error: true`.
 *
 * Every case below names the concrete bug it catches (TV-001).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createState,
  detectLine,
  isGitWrite,
  classifyErrorClass,
  seedFromEvents,
  resolveSessionId,
  readWaveNumber,
  encodeProjectDir,
  buildStagnationPayload,
  acquireSingleton,
  releaseSingleton,
} from '../../scripts/lib/wave-transcript-tail.mjs';

const REPO = '/repo';
const AGENT = 'a94f0d0912a5e1995';
/** The two identities that are NOT interchangeable (see resolveSessionId). */
const UUID = '06461b1a-c668-4ee9-b759-793dfb2e5bec';
const SEMANTIC = 'main-2026-08-24-session-2';

function tmpRepo(prefix = 'wtt-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Write a session.lock in the REAL schema v2 shape — `parseLock` in
 * session-lock.mjs rejects anything missing session_id/started_at/mode/pid/
 * host/ttl_hours, so a hand-shrunk `{session_id}` fixture would read as "no
 * lock" and quietly test a different branch than the one named.
 */
function writeSessionLock(repo, { sessionId = UUID, semanticSessionId = SEMANTIC, live = true } = {}) {
  mkdirSync(join(repo, '.orchestrator'), { recursive: true });
  const heartbeat = new Date(Date.now() - (live ? 60_000 : 9 * 3600 * 1000)).toISOString();
  const lock = {
    session_id: sessionId,
    started_at: heartbeat,
    last_heartbeat: heartbeat,
    mode: 'deep',
    pid: process.pid,
    host: hostname(),
    ttl_hours: 4,
  };
  if (semanticSessionId) lock.semantic_session_id = semanticSessionId;
  writeFileSync(join(repo, '.orchestrator/session.lock'), JSON.stringify(lock, null, 2) + '\n');
  return lock;
}

/**
 * Wrap a payload the way `emitEvent` does (`{timestamp, event, ...payload}`) so
 * a round-trip test feeds `seedFromEvents` the exact line shape that reaches
 * events.jsonl — not a hand-shaped approximation of it.
 */
function asLedgerLine(payload) {
  return JSON.stringify({ timestamp: '2026-08-25T05:00:00.000Z', event: 'stagnation_detected', ...payload });
}

/** Assistant record carrying one tool_use block — real key set. */
function assistantToolUse(input, { name = 'Bash', id = 'toolu_01', agentId = AGENT } = {}) {
  return {
    parentUuid: 'c2fc714a-0255-4096-bc8a-eb000ae68300',
    isSidechain: true,
    agentId,
    message: {
      model: 'claude-opus-5',
      id: 'msg_011CeNrgCBUVmLUgjJuN7dvQ',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input }],
    },
    requestId: 'req_011',
    type: 'assistant',
    uuid: '2f45f87a-ade8-4ed8-b3ad-77af2237b22d',
    timestamp: '2026-08-25T04:45:36.000Z',
    cwd: REPO,
    sessionId: '06461b1a-c668-4ee9-b759-793dfb2e5bec',
    version: '2.1.200',
    gitBranch: 'main',
  };
}

/** Assistant record carrying one text block — real key set. */
function assistantText(text, { agentId = AGENT } = {}) {
  const rec = assistantToolUse({}, { agentId });
  rec.message.content = [{ type: 'text', text }];
  return rec;
}

/** Failed tool result: type "user", string toolUseResult, is_error block. */
function failedResult(toolUseId, errorText, { agentId = AGENT } = {}) {
  return {
    parentUuid: '2f45f87a-ade8-4ed8-b3ad-77af2237b22d',
    isSidechain: true,
    promptId: 'a20fbb40-ce39-47c2-b5a7-b41e8aedfa62',
    agentId,
    type: 'user',
    message: {
      role: 'user',
      content: [
        { tool_use_id: toolUseId, type: 'tool_result', content: errorText, is_error: true },
      ],
    },
    uuid: 'b1b0a5f0-1111-2222-3333-444455556666',
    timestamp: '2026-08-25T04:46:00.000Z',
    toolUseResult: errorText,
    sourceToolAssistantUUID: '2f45f87a-ade8-4ed8-b3ad-77af2237b22d',
    cwd: REPO,
    sessionId: '06461b1a-c668-4ee9-b759-793dfb2e5bec',
    version: '2.1.200',
    gitBranch: 'main',
  };
}

/** Successful tool result: object toolUseResult, no is_error. */
function okResult(toolUseId, { agentId = AGENT } = {}) {
  const rec = failedResult(toolUseId, 'ignored', { agentId });
  rec.message.content = [
    { tool_use_id: toolUseId, type: 'tool_result', content: 'The file has been updated.' },
  ];
  rec.toolUseResult = { filePath: '/repo/scripts/lib/foo.mjs', oldString: 'a', newString: 'b' };
  return rec;
}

/** Run a list of records through one state, collecting every emitted finding. */
function runAll(records, state = createState()) {
  const out = [];
  for (const rec of records) out.push(...detectLine(rec, state, { repoRoot: REPO }));
  return out;
}

describe('wave-transcript-tail — psa007-git-write detector', () => {
  it('fires on a bare git commit in a Bash tool_use', () => {
    // Bug: a subagent committing mid-wave (PSA-007 breach) stays invisible
    // until the coordinator's post-wave review — the whole point of FA-1.
    const findings = runAll([assistantToolUse({ command: 'git commit -m "wip"' })]);
    expect(findings).toEqual([
      { pattern: 'psa007-git-write', agent_id: AGENT, file: null, occurrences: 1 },
    ]);
  });

  // One table, three former tests: every `isGitWrite` case is a command string
  // and an expected verdict, so they differ only in input/expected. The `why`
  // column carries the bug each row catches.
  it.each([
    // Bug: an anchored-only regex misses the most common compound form
    // (`cd <dir> && git add .`), which is exactly how agents write it.
    { why: 'git add in a non-first && segment', cmd: 'cd /repo && git add scripts/lib/foo.mjs', hit: true },
    { why: 'git push after a semicolon', cmd: 'npm test ; git push origin main', hit: true },
    // Measured bug: the detector's FIRST live hit was a sibling agent seeding a
    // test fixture (`cd "$(mktemp -d)" … git add seed.txt`). PSA-007 protects
    // THIS working copy's shared index; a scratch repo has its own. Fixture
    // seeding is routine in a test wave, so leaving this in would make the
    // signal fire constantly and be learned as noise (HR-101).
    { why: 'mktemp fixture repo', cmd: 'T=$(mktemp -d); cd "$T" && git init -q && git add seed.txt', hit: false },
    { why: 'literal /private/tmp fixture path', cmd: 'cd /private/tmp/fixture-repo && git commit -qm seed', hit: false },
    { why: '$TMPDIR worktree', cmd: 'cd "$TMPDIR/wt" && git add .', hit: false },
    // Bug: a substring implementation (`command.includes('git commit')`) fires
    // on every prompt, grep, or echo that merely names the forbidden command.
    { why: 'merely echoed inside a quoted string', cmd: 'echo "never run git commit here"', hit: false },
    { why: 'merely grepped for', cmd: 'grep -rn "git add" .claude/rules/', hit: false },
    // …and the real thing is still caught, so no row above can be satisfied by
    // a detector that simply always returns false.
    { why: 'real in-repo commit', cmd: 'cd /repo && git commit -m "wip"', hit: true },

    // #1215 — the regex matched the subcommand LITERAL, so a capability probe
    // read as an index write. Measured live 2026-09-03: agent C8 was reported
    // as psa007-git-write for `git stash --version`, index clean, no new stash.
    { why: 'stash capability probe', cmd: 'git stash --version >/dev/null 2>&1; echo ok', hit: false },
    { why: 'stash list is a read', cmd: 'git stash list', hit: false },
    { why: 'stash help is a read', cmd: 'git stash --help', hit: false },
    { why: 'stash show is a read', cmd: 'git stash show stash@{0}', hit: false },
    { why: 'add --dry-run writes nothing', cmd: 'git add --dry-run .', hit: false },
    { why: 'commit --dry-run writes nothing', cmd: 'git commit --dry-run', hit: false },
    { why: 'rm --cached --dry-run writes nothing', cmd: 'git rm --cached --dry-run x', hit: false },
    { why: 'git show is not git stash', cmd: 'git show HEAD:scripts/lib/x.mjs > /tmp/x', hit: false },
    // Bug the -n split catches: `git commit -n` is --no-verify, NOT --dry-run
    // (measured: `git commit -h` prints "-n, --no-verify"; `git add -h` prints
    // "-n, --[no-]dry-run"). A blanket "-n means read" rule would blind the
    // detector to `git commit --no-verify`, the PSA-007 anti-pattern verbatim.
    { why: 'add -n is --dry-run', cmd: 'git add -n .', hit: false },
    { why: 'commit -n is --no-verify, a real commit', cmd: 'git commit -n -m x', hit: true },
    // A read-flag hidden in a commit message must not disarm the detector.
    { why: 'read flag quoted inside a commit message', cmd: 'git commit -m "fix --dry-run docs"', hit: true },
    // Positives: the write forms must survive the argument-awareness.
    { why: 'bare stash is an implicit push', cmd: 'git stash', hit: true },
    { why: 'stash push', cmd: 'git stash push -m wip', hit: true },
    { why: 'stash pop', cmd: 'git stash pop', hit: true },
    { why: 'plain add', cmd: 'git add .', hit: true },
    { why: 'plain commit', cmd: 'git commit -m x', hit: true },
    { why: 'checkout -- discards work', cmd: 'git checkout -- scripts/lib/x.mjs', hit: true },
    { why: 'branch checkout touches no content', cmd: 'git checkout main', hit: false },
    { why: 'reset stays unconditional', cmd: 'git reset --hard', hit: true },

    // #1172 — the fixture suppression required a trailing slash, so the
    // reported form (bare `cd /tmp`) still fired. Measured 2026-08-28: W4-FX2
    // was reported for a `mktemp` proof repo written this way.
    { why: 'bare cd /tmp fixture repo', cmd: 'cd /tmp && git init && git commit -m x', hit: false },
    { why: 'bare cd /private/tmp fixture repo', cmd: 'cd /private/tmp; git add seed.txt', hit: false },
    { why: 'quoted $TMPDIR', cmd: 'cd "$TMPDIR" && git commit -m seed', hit: false },
    { why: 'cd $(mktemp -d)', cmd: 'cd $(mktemp -d) && git add .', hit: false },
    // …and the terminator class keeps a real directory whose name merely
    // STARTS with /tmp reported, so the suppression cannot swallow the repo.
    { why: '/tmpfoo is not the temp dir', cmd: 'cd /tmpfoo && git commit -m x', hit: true },
    { why: 'non-tmp working copy', cmd: 'cd /Users/x/repo && git commit -m x', hit: true },

    // W4/F2 — the bug: the global-flag run was `(?:-[^\s]+\s+)*`, which cannot
    // absorb a VALUE-taking global flag. `git -C /tmp stash` ate `-C ` and then
    // met `/tmp`, which is no subcommand, so the whole invocation read as NOT a
    // git write. Measured 2026-09-04, pre-fix: the first two rows returned false.
    // `-C <dir>` is deliberately NOT fixture context (FIXTURE_CONTEXT_RE keys on
    // `cd`/`mktemp`); teaching it `-C` would hand back a one-token evasion.
    { why: '-C consumes its dir, stash still a write', cmd: 'git -C /tmp stash', hit: true },
    { why: '-c consumes its k=v, commit still a write', cmd: 'git -c user.name=x commit -m y', hit: true },
    { why: '-C . commit', cmd: 'git -C . commit -m x', hit: true },
    { why: '--dry-run still wins over the global flag', cmd: 'git -c k=v commit --dry-run', hit: false },
    { why: 'command prefix', cmd: 'command git commit -m x', hit: true },
    { why: 'env VAR=x prefix', cmd: 'env GIT_AUTHOR_NAME=x git commit -m y', hit: true },
    { why: '--git-dir= form falls through the generic alternative', cmd: 'git --git-dir=/r/.git push', hit: true },
  ])('isGitWrite: $why → $hit', ({ cmd, hit }) => {
    expect(isGitWrite(cmd)).toBe(hit);
  });

  it('does NOT fire on read-only git commands', () => {
    // Bug: a read-only `git log`/`git status` reported as a PSA-007 violation
    // trains the operator to ignore the notification (false-positive noise).
    const findings = runAll([
      assistantToolUse({ command: 'git log --oneline -20' }),
      assistantToolUse({ command: 'git status --porcelain', id: 'toolu_02' }),
      assistantToolUse({ command: 'git diff --stat', id: 'toolu_03' }),
    ]);
    expect(findings).toEqual([]);
  });

});

describe('wave-transcript-tail — error-echo detector', () => {
  const editCall = (id) =>
    assistantToolUse(
      { file_path: '/repo/scripts/lib/foo.mjs', old_string: 'a', new_string: 'b' },
      { name: 'Edit', id },
    );
  const EDIT_ERR = 'Error: String to replace not found in file. String: "a"';

  it('fires exactly at the third identical failure, not before', () => {
    // Bug (both directions): firing on failure #1 floods the monitor with
    // ordinary edit friction; never firing loses the documented 3x threshold
    // from circuit-breaker.md § Decision Table.
    const state = createState();
    const first = runAll([editCall('t1'), failedResult('t1', EDIT_ERR)], state);
    const second = runAll([editCall('t2'), failedResult('t2', EDIT_ERR)], state);
    const third = runAll([editCall('t3'), failedResult('t3', EDIT_ERR)], state);

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    expect(third).toEqual([
      {
        pattern: 'error-echo',
        agent_id: AGENT,
        file: 'scripts/lib/foo.mjs',
        error_class: 'edit-format-friction',
        occurrences: 3,
      },
    ]);
  });

  it('does NOT fire on successful tool results', () => {
    // Bug: treating every tool_result as a failure makes error-echo fire on a
    // perfectly healthy agent after three successful edits.
    const state = createState();
    const findings = runAll(
      [editCall('t1'), okResult('t1'), editCall('t2'), okResult('t2'), editCall('t3'), okResult('t3')],
      state,
    );
    expect(findings).toEqual([]);
  });

  it('keys the counter on the FILE, so failures on different files do not add up', () => {
    // Bug: an agent-only counter merges unrelated one-off failures across
    // files into a phantom "echo" that never happened.
    const state = createState();
    const other = assistantToolUse(
      { file_path: '/repo/scripts/lib/bar.mjs', old_string: 'x', new_string: 'y' },
      { name: 'Edit', id: 't3' },
    );
    const findings = runAll(
      [editCall('t1'), failedResult('t1', EDIT_ERR), editCall('t2'), failedResult('t2', EDIT_ERR), other, failedResult('t3', EDIT_ERR)],
      state,
    );
    expect(findings).toEqual([]);
  });

  it('maps error text onto the circuit-breaker taxonomy', () => {
    // Bug: every failure classified as "other" makes error_class useless for
    // triage — the field exists to separate edit friction from a scope denial.
    expect(classifyErrorClass('String to replace not found in file')).toBe('edit-format-friction');
    expect(classifyErrorClass('old_string was not unique')).toBe('edit-format-friction');
    expect(classifyErrorClass('scope violation: path outside allowedPaths')).toBe('scope-denied');
    expect(classifyErrorClass('blocked-command: rm -rf denied by guard')).toBe('command-blocked');
    expect(classifyErrorClass('ENOENT: no such file or directory')).toBe('other');
  });
});

describe('wave-transcript-tail — status-partial detector', () => {
  it('fires on STATUS: partial in an assistant text block', () => {
    // Bug: an agent killed by maxTurns right after writing STATUS: partial
    // loses the finding entirely — the durability AC of PRD § FA-1.
    const findings = runAll([assistantText('Work done.\n\nSTATUS: partial\nfiles_changed: a.mjs')]);
    expect(findings).toEqual([
      { pattern: 'status-partial', agent_id: AGENT, file: null, occurrences: 1 },
    ]);
  });

  it('reports STATUS: blocked and STATUS: failed under the same pattern name', () => {
    // Bug: inventing a second pattern name for the same fact is Epic #1035
    // ("one fact, two copies") and breaks the wave-loop.md pattern enum.
    const blocked = runAll([assistantText('STATUS: blocked')]);
    const failed = runAll([assistantText('STATUS: failed')]);
    expect(blocked.map((f) => f.pattern)).toEqual(['status-partial']);
    expect(failed.map((f) => f.pattern)).toEqual(['status-partial']);
  });

  it('does NOT fire on STATUS: done', () => {
    // Bug: a loose /STATUS:/ match reports every successful agent as stagnating.
    expect(runAll([assistantText('All good.\n\nSTATUS: done')])).toEqual([]);
  });

  it('does NOT fire when an agent merely QUOTES the marker mid-sentence', () => {
    // Measured bug, not hypothetical: the un-anchored regex fired on 2 of 2
    // live hits in this repo's own session — both Explore agents citing the
    // PRD's acceptance criteria and describing this detector. A supervision
    // signal that fires on discussion of itself trains the operator to ignore
    // it (host-resources.md HR-101).
    const quotedAC = 'Zitat aus dem PRD:\n> `And er beendet mit STATUS: blocked` / `And er wartet NICHT`';
    const describingTheDetector =
      '**(c) Agent text output / `STATUS: partial`** — `.message.content[] | select(.type=="text")`';
    expect(runAll([assistantText(quotedAC)])).toEqual([]);
    expect(runAll([assistantText(describingTheDetector)])).toEqual([]);
  });

  it('still fires when the marker opens its own line, bold or plain', () => {
    // Guards the other direction: an anchor tightened too far would silence
    // the real report and make the detector permanently dead.
    expect(runAll([assistantText('Report body.\n\n**STATUS: partial**')])).toHaveLength(1);
    expect(runAll([assistantText('  STATUS: blocked\nfiles_changed: none')])).toHaveLength(1);
  });
});

describe('wave-transcript-tail — dedup / aggregation window', () => {
  it('emits the first hit, then at most every 10 further hits', () => {
    // Bug: without the window, a looping agent writes one notification per
    // turn; with a permanent suppression instead, an escalating loop goes
    // silent after its first line.
    const state = createState();
    const occurrences = [];
    for (let i = 0; i < 22; i += 1) {
      const found = detectLine(
        assistantToolUse({ command: 'git add -A' }, { id: `toolu_${i}` }),
        state,
        { repoRoot: REPO },
      );
      for (const f of found) occurrences.push(f.occurrences);
    }
    expect(occurrences).toEqual([1, 11, 21]);
  });

  it('does not re-emit findings already recorded for this session (restart safety)', () => {
    // Bug: a monitor restart re-scans each transcript from byte 0 and
    // duplicates every finding already in events.jsonl.
    const state = createState();
    const seeded = seedFromEvents(
      [
        JSON.stringify({
          timestamp: '2026-08-25T04:00:00.000Z',
          event: 'stagnation_detected',
          session: 'sess-1',
          wave: 2,
          agent: 'code-implementer',
          agent_id: AGENT,
          pattern: 'psa007-git-write',
          source: 'tail',
          file: null,
          occurrences: 1,
        }),
        JSON.stringify({ event: 'orchestrator.session.started', session: 'sess-1' }),
      ],
      'sess-1',
      state,
    );
    expect(seeded).toBe(1);
    expect(runAll([assistantToolUse({ command: 'git add -A' })], state)).toEqual([]);
  });

  it('ignores stagnation records belonging to a DIFFERENT session', () => {
    // Bug: seeding from a peer session's records suppresses this session's
    // own first finding — the shared-artefact class of #1082.
    const state = createState();
    const seeded = seedFromEvents(
      [
        JSON.stringify({
          event: 'stagnation_detected',
          session: 'someone-else',
          agent_id: AGENT,
          pattern: 'psa007-git-write',
          source: 'tail',
          file: null,
          occurrences: 1,
        }),
      ],
      'sess-1',
      state,
    );
    expect(seeded).toBe(0);
    expect(runAll([assistantToolUse({ command: 'git add -A' })], state)).toHaveLength(1);
  });
});

describe('wave-transcript-tail — session + wave resolution', () => {
  it('prefers CLAUDE_CODE_SESSION_ID over the session lock', () => {
    // Bug: reading the lock first attaches the tailer to a stale session id
    // left behind by a previous run in the same working copy.
    // `env: {}` is passed EXPLICITLY on every case — the ambient
    // CLAUDE_CODE_SESSION_ID is set inside a Claude session, so inheriting
    // process.env would make the lock/mtime tiers unreachable and the test
    // would pass without ever exercising them.
    const repo = tmpRepo();
    writeSessionLock(repo, { sessionId: 'from-lock' });
    expect(resolveSessionId({ repoRoot: repo, env: { CLAUDE_CODE_SESSION_ID: 'from-env' } })).toMatchObject({
      sessionId: 'from-env',
      source: 'env',
    });
    expect(resolveSessionId({ repoRoot: repo, env: {} })).toMatchObject({
      sessionId: 'from-lock',
      source: 'session.lock',
    });
  });

  it('falls through to newest-mtime when the lock is present but STALE', () => {
    // Bug (HIGH, W4 review): a raw JSON.parse of session.lock with no liveness
    // check resolves a DEAD session's uuid. Its transcript directory never
    // grows again, so the tailer supervises nothing forever after printing one
    // healthy-looking startup line — a silent no-op, not a visible failure.
    const repo = tmpRepo();
    writeSessionLock(repo, { sessionId: 'dead-session-uuid', live: false });
    const projectsDir = join(repo, 'projects');
    mkdirSync(join(projectsDir, 'live-uuid'), { recursive: true });

    const resolved = resolveSessionId({ repoRoot: repo, env: {}, projectsDir });
    expect(resolved).toMatchObject({ sessionId: 'live-uuid', source: 'newest-mtime' });
    expect(resolved.sessionId).not.toBe('dead-session-uuid');
  });

  it('picks the NEWEST directory in the mtime tier, not the oldest', () => {
    // Bug: an inverted sort comparator attaches the tailer to the oldest
    // session directory in the projects folder — i.e. reliably to a PEER
    // session's transcripts rather than to this session's own.
    const repo = tmpRepo();
    const projectsDir = join(repo, 'projects');
    const stamps = { oldest: 1_700_000_000, middle: 1_700_000_500, newest: 1_700_001_000 };
    for (const [name, secs] of Object.entries(stamps)) {
      mkdirSync(join(projectsDir, name), { recursive: true });
      utimesSync(join(projectsDir, name), secs, secs);
    }
    expect(resolveSessionId({ repoRoot: repo, env: {}, projectsDir })).toMatchObject({
      sessionId: 'newest',
      source: 'newest-mtime',
    });
  });

  it('resolves the SEMANTIC id separately from the raw uuid', () => {
    // Bug (HIGH, W4 review): the two ids are different strings with different
    // jobs — the uuid names the transcript directory, the semantic id is what
    // both consumers join on. Collapsing them into one field kills the join.
    const repo = tmpRepo();
    writeSessionLock(repo, { sessionId: UUID, semanticSessionId: SEMANTIC });
    expect(resolveSessionId({ repoRoot: repo, env: {} })).toEqual({
      sessionId: UUID,
      source: 'session.lock',
      semanticSessionId: SEMANTIC,
      semanticSource: 'session-attribution',
    });
  });

  it('falls back to the raw id when no semantic id exists, and says so', () => {
    // Bug: silently emitting nothing (or an empty `session`) when the lock
    // carries no semantic id. The record must still be written — a raw id is a
    // real identifier, it just will not appear in a per-session roll-up.
    const repo = tmpRepo();
    writeSessionLock(repo, { sessionId: UUID, semanticSessionId: null });
    expect(resolveSessionId({ repoRoot: repo, env: {} })).toMatchObject({
      sessionId: UUID,
      semanticSessionId: UUID,
      semanticSource: 'raw-fallback',
    });
  });

  it('returns null when nothing resolves (fail-open contract)', () => {
    // Bug: throwing here would make the monitor exit non-zero and look like a
    // wave failure; PRD § FA-1 requires one stderr line and no blocked agent.
    expect(resolveSessionId({ repoRoot: tmpRepo(), env: {} })).toBeNull();
  });

  it('reports wave null when wave-scope.json is not bound to this session', () => {
    // Bug: .claude/wave-scope.json binds to the WORKING COPY, not the session
    // (#1082) — attributing a peer session's wave number mislabels the event.
    const repo = tmpRepo();
    mkdirSync(join(repo, '.claude'), { recursive: true });
    const p = join(repo, '.claude/wave-scope.json');

    writeFileSync(p, JSON.stringify({ wave: 3 }));
    expect(readWaveNumber(repo, 'sess-1')).toBeNull();

    writeFileSync(p, JSON.stringify({ wave: 3, session_id: 'someone-else' }));
    expect(readWaveNumber(repo, 'sess-1')).toBeNull();

    writeFileSync(p, JSON.stringify({ wave: 3, session_id: 'sess-1' }));
    expect(readWaveNumber(repo, 'sess-1')).toBe(3);
  });

  it('keeps the tail loop alive instead of draining the event loop', async () => {
    // Bug (observed 2026-08-25): an unref()'d poll timer is the only handle the
    // process holds, so node exits 0 the moment the first tick is scheduled.
    // The monitor then supervises NOTHING while looking like a clean shutdown.
    // Hermetic: a synthetic session id means the subagents dir never exists, so
    // the child only polls — it can neither read nor write anything real.
    const repo = mkdtempSync(join(tmpdir(), 'wtt-live-'));
    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, '../../scripts/lib/wave-transcript-tail.mjs'), '--tail', '--interval=1'],
      {
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: repo, CLAUDE_CODE_SESSION_ID: 'synthetic-no-such-session' },
        stdio: 'ignore',
      },
    );
    let exitedEarly = false;
    child.on('exit', () => { exitedEarly = true; });
    try {
      await new Promise((r) => setTimeout(r, 2500));
      expect(exitedEarly).toBe(false);
    } finally {
      child.kill('SIGKILL');
    }
  }, 15_000);

  it('encodes the repo path the way Claude Code names its projects directory', () => {
    // Bug: a wrong encoding silently resolves to a directory that never
    // appears, so the tailer polls forever and reports nothing.
    expect(encodeProjectDir('/Users/dev/Projects/session-orchestrator')).toBe(
      '-Users-dev-Projects-session-orchestrator',
    );
  });
});

describe('wave-transcript-tail — emitted record shape', () => {
  const ECHO = {
    pattern: 'error-echo',
    agent_id: AGENT,
    file: 'scripts/lib/foo.mjs',
    error_class: 'edit-format-friction',
    occurrences: 3,
  };
  function ctxFor(repo) {
    return { repoRoot: repo, sessionId: UUID, semanticSessionId: SEMANTIC, agentType: 'code-implementer' };
  }

  it('puts the SEMANTIC session id in `session`, keeping the uuid as session_id', () => {
    // Measured bug (HIGH, W4 review): `session` carried the uuid, but BOTH
    // consumers join on the semantic id — compute-grounding-injection.sh
    // intersects `.session` against sessions.jsonl `session_id`s, and
    // session-end/metrics-collection.md filters `.session == $sid`. All 5
    // records in this repo's ledger failed that join, so the shipped feature
    // measured as 0 records: indistinguishable from the pre-#1114 dead state.
    const repo = tmpRepo();
    writeSessionLock(repo);
    const payload = buildStagnationPayload(ECHO, ctxFor(repo));

    expect(payload.session).toBe(SEMANTIC);
    expect(payload.session).not.toBe(UUID);
    expect(payload).toMatchObject({
      source: 'tail',
      agent_id: AGENT,
      pattern: 'error-echo',
      error_class: 'edit-format-friction',
      occurrences: 3,
      session_id: UUID,
      semantic_session_id: SEMANTIC,
    });
  });

  it('omits error_class entirely for a pattern that has none', () => {
    // Bug: an `error_class: undefined` key serialises as an absent field in
    // JSON but as a PRESENT key in memory — and the grounding-injection filter
    // selects on `.error_class == "edit-format-friction"`, so a null/empty
    // value must never be written rather than written as a falsy placeholder.
    const repo = tmpRepo();
    writeSessionLock(repo);
    const payload = buildStagnationPayload(
      { pattern: 'psa007-git-write', agent_id: AGENT, file: null, occurrences: 1 },
      ctxFor(repo),
    );
    expect(payload).not.toHaveProperty('error_class');
    expect(payload.pattern).toBe('psa007-git-write');
  });

  it('round-trips: the record it writes is a record it can seed from', () => {
    // THE guard that would have caught the join-key defect. Producer and reader
    // must key on ONE id: report() writes `session`, seedFromEvents() reads it
    // back on the next restart. While the producer wrote the uuid and the
    // consumers read the semantic id, nothing in the suite noticed — each half
    // was self-consistent.
    const repo = tmpRepo();
    writeSessionLock(repo);
    const line = asLedgerLine(buildStagnationPayload(ECHO, ctxFor(repo)));

    expect(seedFromEvents([line], SEMANTIC, createState())).toBe(1);
    // …and the pre-fix key seeds nothing, which is the failure direction.
    expect(seedFromEvents([line], UUID, createState())).toBe(0);
  });
});

describe('wave-transcript-tail — single-instance guard', () => {
  it('refuses a second tailer while the first holds the lock', () => {
    // Measured bug (HIGH, W4 review): the monitor starts on
    // on-skill-invoke:wave-executor, which a deep session triggers repeatedly.
    // Two tailers each seeded 0 at startup and both emitted — 4 of the 5
    // records in this repo's ledger were exact duplicates, in two pairs 6 ms
    // and 8 ms apart. Asserted through the lock state rather than by spawning
    // two real processes, which would race on timing.
    const repo = tmpRepo();
    mkdirSync(join(repo, '.orchestrator'), { recursive: true });

    const first = acquireSingleton(repo);
    expect(first.ok).toBe(true);
    expect(JSON.parse(readFileSync(first.lockPath, 'utf8'))).toMatchObject({
      pid: process.pid,
      holder: 'wave-transcript-tail',
    });

    const second = acquireSingleton(repo);
    expect(second).toMatchObject({ ok: false, reason: 'held' });
  });

  it('lets the next tailer in after the holder releases', () => {
    // Bug in the other direction: a lock that outlives its holder makes wave
    // supervision permanently dead after the first wave-executor invocation —
    // strictly worse than the double-emit it was added to fix.
    const repo = tmpRepo();
    mkdirSync(join(repo, '.orchestrator'), { recursive: true });

    expect(acquireSingleton(repo).ok).toBe(true);
    releaseSingleton(repo);
    expect(acquireSingleton(repo).ok).toBe(true);
  });
});

describe('wave-transcript-tail — pre-agent_id seed records', () => {
  const gitAdd = () => assistantToolUse({ command: 'git add -A' });
  const priorRecord = (extra) =>
    JSON.stringify({
      event: 'stagnation_detected',
      session: SEMANTIC,
      source: 'tail',
      pattern: 'psa007-git-write',
      file: null,
      occurrences: 1,
      ...extra,
    });

  it('dedupes a record written before `agent_id` existed (wildcard match)', () => {
    // Measured bug: 4 of the 5 records in this repo's ledger predate the
    // agent_id field. Keying them on the literal 'unknown' seeds a counter no
    // live hit can ever match, so every restart re-announces all four as new
    // findings — the exact duplication the restart-safety seed exists to stop.
    const state = createState();
    expect(seedFromEvents([priorRecord()], SEMANTIC, state)).toBe(1);
    expect(runAll([gitAdd()], state)).toEqual([]);
  });

  it('still keys a record that HAS agent_id per agent, not repo-wide', () => {
    // Bug in the other direction: making every seed a wildcard would suppress
    // a sibling agent's genuine FIRST finding — a false negative in a
    // supervision tool, which is the worse failure of the two.
    const state = createState();
    expect(seedFromEvents([priorRecord({ agent_id: 'some-other-agent' })], SEMANTIC, state)).toBe(1);
    expect(runAll([gitAdd()], state)).toHaveLength(1);
  });
});
