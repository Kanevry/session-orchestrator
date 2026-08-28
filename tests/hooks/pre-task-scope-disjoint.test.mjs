/**
 * tests/hooks/pre-task-scope-disjoint.test.mjs
 *
 * Contract tests for the pre-dispatch scope-disjointness guard (#1020).
 *
 * Every `it` below names the concrete bug it catches (TV-001). The decision
 * assertions go exclusively through `expectAllow` / `expectDeny` / `expectWarn`
 * from `tests/_helpers/hook-decision.mjs`: under the exit-0 PreToolUse protocol
 * (#906) allow AND deny both exit 0, so a bare `expect(status).toBe(0)` is an
 * assert-nothing that stays green in BOTH directions.
 *
 * The fake-regression block at the bottom is the load-bearing one: it restores
 * the defect in a COPY of the hook and proves the deny test goes RED. A green
 * test alone never proves a guard bites.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync, spawn, execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

import { expectDeny, expectAllow, expectWarn } from '../_helpers/hook-decision.mjs';

const REPO_ROOT = process.cwd();
const HOOK = path.join(REPO_ROOT, 'hooks', 'pre-task-scope-disjoint.mjs');
const LEDGER_REL = path.join('.orchestrator', 'wave-dispatch-scopes.json');

/** A disposable project dir with the `.orchestrator/` the ledger lives in. */
function makeProjectDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ptsd-'));
  mkdirSync(path.join(dir, '.orchestrator'), { recursive: true });
  return dir;
}

/**
 * Build a dispatch payload in the shape MEASURED on 147 real `Agent` tool_use
 * blocks: `{description, model, prompt, subagent_type, run_in_background?}`.
 * The file scope exists only as prose inside `prompt` — there is no structured
 * field to populate, which is why the hook parses the prompt at all.
 */
function dispatchPayload({
  cwd, id, files, sessionId = 's1', toolName = 'Agent',
  marker = '## DEIN DATEI-SCOPE', transcriptPath,
}) {
  const prompt = `Du bist ${id}.\n\n${marker}\n\`\`\`\n${files.join('\n')}\n\`\`\`\n\nMach die Arbeit.`;
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    session_id: sessionId,
    cwd,
    ...(transcriptPath === undefined ? {} : { transcript_path: transcriptPath }),
    tool_input: { description: id, model: 'opus', prompt, subagent_type: 'code-implementer' },
  });
}

// ---------------------------------------------------------------------------
// Transcript fixtures — HARVESTED from this project's live transcripts, then
// redacted (`.claude/rules/testing.md` § Fixtures Mirror Production Data). Both
// dispatch shapes exist in the wild and they complete DIFFERENTLY:
//
//   sync  — the `tool_result` for the dispatch id arrives when the agent is done
//           (measured 2026-08-06T07:07:39: 5 `Agent` rows in 0.44 s, their five
//           results 5–11 minutes later).
//   async — the `tool_result` arrives in ~0.2 s reading "Async agent launched
//           successfully"; the real completion is a later `<task-notification>`
//           carrying `<tool-use-id>` + `<status>completed</status>` (measured
//           launch 14:14:26.768 → notification 14:24:39.360).
// ---------------------------------------------------------------------------

/** An assistant row carrying one `Agent` dispatch. */
function transcriptDispatch(desc, toolUseId) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-14T14:14:26.537Z',
    message: {
      id: 'msg_01Redacted',
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: toolUseId,
        name: 'Agent',
        input: { description: desc, subagent_type: 'code-implementer', model: 'opus', prompt: '…' },
      }],
    },
  });
}

/** The SYNC shape's completion: a tool_result carrying the agent's report. */
function transcriptSyncResult(toolUseId) {
  return JSON.stringify({
    type: 'user',
    timestamp: '2026-08-14T14:24:39.360Z',
    message: {
      role: 'user',
      content: [{ tool_use_id: toolUseId, type: 'tool_result', content: [{ type: 'text', text: '## Report\nSTATUS: done' }] }],
    },
  });
}

/** The ASYNC shape's LAUNCH ACK — 0.2 s after dispatch, and NOT a completion. */
function transcriptAsyncLaunchAck(toolUseId, agentId) {
  return JSON.stringify({
    type: 'user',
    timestamp: '2026-08-14T14:14:26.768Z',
    message: {
      role: 'user',
      content: [{
        tool_use_id: toolUseId,
        type: 'tool_result',
        content: [{
          type: 'text',
          text: `Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: ${agentId}`,
        }],
      }],
    },
  });
}

/** The ASYNC shape's real completion. */
function transcriptTaskNotification(toolUseId, agentId, desc) {
  return JSON.stringify({
    type: 'user',
    timestamp: '2026-08-14T14:24:39.360Z',
    message: {
      role: 'user',
      content: `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>completed</status>\n<summary>Agent "${desc}" finished</summary>\n<result>done</result>\n</task-notification>`,
    },
  });
}

/** Write a transcript JSONL into `dir` and return its path. */
function writeTranscript(dir, rows) {
  const p = path.join(dir, 'transcript.jsonl');
  writeFileSync(p, `${rows.join('\n')}\n`);
  return p;
}

/** Run a hook binary with a payload on stdin. Returns the spawnSync result. */
function runHook(stdin, { hook = HOOK, cwd = REPO_ROOT } = {}) {
  // A live Claude Code session exports CLAUDE_CODE_SESSION_ID into the ambient
  // env, so a spawned hook inherits the OPERATOR's real session id — any
  // assertion about session attribution would then pass for the wrong reason,
  // and differently on CI (where the var is absent). Scrub it here, once.
  const env = { ...process.env };
  delete env.CLAUDE_CODE_SESSION_ID;
  return spawnSync(process.execPath, [hook], {
    input: stdin,
    encoding: 'utf8',
    cwd,
    env,
    timeout: 20_000,
  });
}

/**
 * The `orchestrator.wave_dispatch.scope_checked` records a spawned dispatch left
 * in ITS OWN project dir (#1092). The hook pins `emitEvent` to `repoRoot:
 * projectDir`, so a test can never append to this repo's real ledger.
 */
function scopeEvents(projectDir) {
  const file = path.join(projectDir, '.orchestrator', 'metrics', 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
    .filter((rec) => rec.event === 'orchestrator.wave_dispatch.scope_checked');
}

/** Dispatch `id` with `files` into `projectDir`. */
function dispatch(projectDir, id, files, opts = {}) {
  return runHook(dispatchPayload({ cwd: projectDir, id, files, ...opts }));
}

describe('pre-task-scope-disjoint — the case the hook exists for', () => {
  it('DENIES a dispatch whose scope overlaps an already-dispatched sibling, naming both agents and the witness', () => {
    // Bug caught: two agents of one wave are handed the same file, both write
    // it, and the second silently clobbers the first (the #1020 race). Nothing
    // downstream sees this until the diff is already wrong.
    const dir = makeProjectDir();
    expectAllow(dispatch(dir, 'Agent A', ['scripts/foo.mjs']));

    const denied = dispatch(dir, 'Agent B', ['scripts/foo.mjs']);
    expectDeny(denied, ['Agent B', 'Agent A', 'scripts/foo.mjs', 'concrete']);

    // Bug caught: the deny branch's `ledger_result` literal is asserted
    // nowhere else — only 'allow' and 'no-scope' are pinned (see the #1092
    // event tests below). A typo'd literal here would ship unnoticed,
    // reproducing the unfalsifiable-which-agent defect this event exists to
    // close, one layer up.
    const events = scopeEvents(dir);
    expect(events[events.length - 1].ledger_result).toBe('deny');
  });

  it('DENIES a glob that collides with a sibling concrete path (string-disjoint, expansion-equal)', () => {
    // Bug caught: `scripts/lib/**/*.mjs` and `scripts/lib/io.mjs` are disjoint
    // as STRINGS. A naive set-intersection over the declared entries reports
    // "no overlap" and lets both agents edit io.mjs. Only expansion catches it.
    // Deliberately tmpdir-only: pointing the payload cwd at the real repo would
    // write the coordinator's own live ledger (PSA-002).
    const dir = makeProjectDir();
    expectAllow(dispatch(dir, 'Globber', ['scripts/lib/**/*.mjs']));
    const denied = dispatch(dir, 'Concrete', ['scripts/lib/io.mjs']);
    expectDeny(denied, ['Globber', 'Concrete', 'scripts/lib/io.mjs']);
  });
});

describe('pre-task-scope-disjoint — the allow paths, asserted positively', () => {
  it('ALLOWS disjoint scopes, with an empty decision channel', () => {
    // Bug caught: an over-eager guard on the dispatch path denies legitimate
    // agents. Its blast radius is the whole session — every dispatch blocked.
    // `expectAllow` pins stdout EMPTY, so "no deny" is proven, not assumed.
    const dir = makeProjectDir();
    expectAllow(dispatch(dir, 'Agent A', ['scripts/foo.mjs']));
    expectAllow(dispatch(dir, 'Agent B', ['scripts/bar.mjs']));
    expectAllow(dispatch(dir, 'Agent C', ['tests/lib/baz.test.mjs']));
  });

  it('ALLOWS a re-dispatch of the SAME agent id with the same scope (retry is legitimate)', () => {
    // Bug caught: self-lock. An agent that failed and is re-dispatched would
    // collide with its own ledger record, so the guard would block every retry
    // in the session — the guard becomes the outage it was meant to prevent.
    const dir = makeProjectDir();
    expectAllow(dispatch(dir, 'Agent A', ['scripts/foo.mjs']));
    expectAllow(dispatch(dir, 'Agent A', ['scripts/foo.mjs']));
    expectAllow(dispatch(dir, 'Agent A', ['scripts/foo.mjs']));
  });

  it('ALLOWS a prompt with no scope marker (71.4% of real dispatch prompts have none)', () => {
    // Bug caught: denying the non-extractable case. Measured on 147 archived
    // dispatch prompts, only 42 carry a scope marker — a hook that denied the
    // rest would block 7 dispatches in 10.
    const dir = makeProjectDir();
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: 's1', cwd: dir,
      tool_input: { description: 'Freeform', subagent_type: 'x', prompt: 'Research the topic and report back.' },
    });
    expectAllow(runHook(payload));
  });

  it('ALLOWS a scope block whose lines are prose rather than paths', () => {
    // Bug caught: a loose path parser invents scope entries out of prose and
    // then denies on a phantom overlap. `looksLikeRepoPath` must reject these.
    const dir = makeProjectDir();
    expectAllow(dispatch(dir, 'A', ['alle Dateien im Repo']));
    expectAllow(dispatch(dir, 'B', ['alle Dateien im Repo']));
  });

  it('ALLOWS a non-dispatch tool — the Task* family must not be caught', () => {
    // Bug caught: registering the matcher on `Task` (as originally specified)
    // hits TaskCreate/TaskUpdate/TaskGet/TaskList/TaskStop/TaskOutput — the
    // todo surface — and never the real dispatch tool, which is named `Agent`.
    const dir = makeProjectDir();
    for (const toolName of ['TaskCreate', 'TaskUpdate', 'Bash', 'Edit']) {
      expectAllow(dispatch(dir, 'A', ['scripts/foo.mjs'], { toolName }));
      expectAllow(dispatch(dir, 'B', ['scripts/foo.mjs'], { toolName }));
    }
  });

  it('ALLOWS an empty or malformed payload instead of bricking every dispatch', () => {
    // Bug caught: fail-closed on a harness quirk. A parse error on the dispatch
    // path that denied would stop the session dead; the matrix routes rows 3
    // and 4 to allow for exactly that reason.
    expectAllow(runHook(''));
    expectAllow(runHook('   '));
    expectAllow(runHook('{not json'));
    expectAllow(runHook('null'));
    expectAllow(runHook('[]'));
  });

  it('resets the ledger across waves, so wave N+1 may reuse a file wave N owned', () => {
    // Bug caught: a ledger keyed only on the session accumulates forever, so an
    // agent in wave 3 is denied a file that a wave-1 agent legitimately owned
    // and finished with.
    const dir = makeProjectDir();
    mkdirSync(path.join(dir, '.claude'), { recursive: true });
    const scopeFile = path.join(dir, '.claude', 'wave-scope.json');

    writeFileSync(scopeFile, JSON.stringify({ wave: 1, role: 'Impl-Core' }));
    expectAllow(dispatch(dir, 'Agent A', ['scripts/foo.mjs']));
    // Same wave → collision.
    expectDeny(dispatch(dir, 'Agent B', ['scripts/foo.mjs']), 'scripts/foo.mjs');

    // Wave advances → prior wave's records no longer bind.
    writeFileSync(scopeFile, JSON.stringify({ wave: 2, role: 'Quality' }));
    expectAllow(dispatch(dir, 'Agent B', ['scripts/foo.mjs']));
  });
});

describe('pre-task-scope-disjoint — degradation matrix', () => {
  it('WARNS and allows on a corrupt ledger rather than denying or staying silent', () => {
    // Bug caught (two directions): denying on unreadable state would block the
    // session on a bookkeeping fault; silently allowing would hide that the
    // guard stopped checking. Row 7 of the matrix demands warn + allow.
    const dir = makeProjectDir();
    writeFileSync(path.join(dir, LEDGER_REL), '{ this is not json');
    expectWarn(dispatch(dir, 'Agent A', ['scripts/foo.mjs']), ['ledger was unreadable', 'reset']);

    // Bug caught: the corrupt-ledger warn's `ledger_result` literal is
    // unverified elsewhere — a typo would misreport a bookkeeping fault as a
    // clean 'allow' in the ledger telemetry, hiding exactly the outage this
    // warn exists to surface.
    const events = scopeEvents(dir);
    expect(events[events.length - 1].ledger_result).toBe('warn-ledger-corrupt');
  });

  it('SELF-HEALS the corrupt ledger, so the wave is checked again from the next dispatch', () => {
    // Bug caught (review MED): the warn verdict carried no `ledger`, and main()
    // only writes `if (verdict.ledger)` — so the corrupt bytes stayed on disk and
    // EVERY remaining dispatch of the wave re-warned and skipped the check. The
    // guard was off for the rest of the wave, visible only in a systemMessage
    // that drowns in wave noise. Here: dispatch 1 warns AND repairs, dispatch 2
    // is recorded, dispatch 3 collides with it and is DENIED again.
    const dir = makeProjectDir();
    const ledgerPath = path.join(dir, LEDGER_REL);
    writeFileSync(ledgerPath, '{ this is not json');

    expectWarn(dispatch(dir, 'Agent A', ['scripts/foo.mjs']), 'ledger was unreadable');

    // The bytes on disk are valid JSON again, and carry the dispatch that warned.
    const healed = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    expect(healed.agents.map((a) => a.id)).toEqual(['Agent A (code-implementer)']);

    // ...and the guard is CHECKING again: the very scope that warned now binds.
    expectDeny(dispatch(dir, 'Agent B', ['scripts/foo.mjs']), ['Agent A', 'scripts/foo.mjs']);
  });

  it('does NOT treat an absent ledger as corruption (every wave has a first agent)', () => {
    // Bug caught: an ENOENT misclassified as corruption warns on the FIRST
    // dispatch of every wave — a permanent false alarm that trains the operator
    // to ignore the channel.
    const dir = makeProjectDir();
    expect(existsSync(path.join(dir, LEDGER_REL))).toBe(false);
    expectAllow(dispatch(dir, 'Agent A', ['scripts/foo.mjs']));
  });

  it('keeps the deny envelope a single parseable line under a large collision payload', () => {
    // Bug caught: the #906 fail-open. The reason names agents, paths and
    // witnesses, so it can exceed the 65 536-byte kernel pipe buffer; a
    // truncated envelope reads as no-decision and the dispatch PROCEEDS.
    const dir = makeProjectDir();
    // Long but PLAUSIBLE paths (~110 chars): `looksLikeRepoPath` rejects
    // anything past 200 chars, so an implausible fixture would silently produce
    // an empty scope and test nothing.
    const longPath = (i) => `scripts/${'nested-dir/'.repeat(8)}module-${String(i).padStart(3, '0')}.mjs`;
    const many = Array.from({ length: 400 }, (_, i) => longPath(i));
    expect(longPath(0).length).toBeGreaterThan(100);
    expect(longPath(0).length).toBeLessThan(200);

    expectAllow(dispatch(dir, 'Agent A', many));
    const denied = dispatch(dir, 'Agent B', many);

    // Still a deny, and still ONE line of valid JSON carrying the decision.
    expectDeny(denied, 'Agent A');
    // The claim under test is the SHAPE — exactly one line, and that line parses.
    // The verdict itself was already asserted by expectDeny above; restating
    // `permissionDecision` here would be a second inline copy of the envelope
    // contract that survives the next protocol change verbatim (#906 class).
    const lines = denied.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0])).not.toThrow();
    // Comfortably below the pipe buffer — the clamp did its job.
    expect(Buffer.byteLength(denied.stdout, 'utf8')).toBeLessThan(65_536);
  });
});

describe('pre-task-scope-disjoint — liveness: a FINISHED agent no longer binds', () => {
  it('ALLOWS a repair pass on a file whose previous owner has FINISHED (sync shape)', () => {
    // Bug caught (review HIGH): the ledger had no notion of "agent done", so a
    // sequential fix-pass on the same file as an already-completed agent was
    // DENIED. Measured on 38 archived transcripts: 2 of 2 cross-dispatch overlaps
    // were exactly this — legitimate repairs 36 and 49 minutes apart. And because
    // a deny does not persist the ledger, the re-dispatch met the same stale
    // record: a PERMANENT block until the wave changed or the file was deleted.
    const dir = makeProjectDir();
    const transcriptPath = writeTranscript(dir, [
      transcriptDispatch('L2 extract redactSpans primitive', 'toolu_01A'),
      transcriptSyncResult('toolu_01A'),
    ]);

    expectAllow(dispatch(dir, 'L2 extract redactSpans primitive', ['scripts/lib/redact.mjs'], { transcriptPath }));
    expectAllow(dispatch(dir, 'Fix CP11 standalone-vendoring break', ['scripts/lib/redact.mjs'], { transcriptPath }));

    // Bug caught: the allow-finished branch's `ledger_result` literal is
    // unverified elsewhere — a typo would collapse this liveness-repair path
    // into an indistinguishable plain 'allow' in the ledger telemetry, losing
    // the one signal that tells the two apart after the fact.
    const events = scopeEvents(dir);
    expect(events[events.length - 1].ledger_result).toBe('allow-finished');
  });

  it('ALLOWS the repair pass for an ASYNC agent whose task-notification says completed', () => {
    // Bug caught: the async dispatch shape completes through a
    // `<task-notification>` record, not through its tool_result. A probe that
    // only knew the sync shape would treat every background agent as forever
    // in-flight — i.e. the HIGH finding, unrepaired, for exactly the dispatch
    // mode this session used.
    const dir = makeProjectDir();
    const transcriptPath = writeTranscript(dir, [
      transcriptDispatch('C2 vcs repo-flag checker', 'toolu_01B'),
      transcriptAsyncLaunchAck('toolu_01B', 'a062839d8667371ab'),
      transcriptTaskNotification('toolu_01B', 'a062839d8667371ab', 'C2 vcs repo-flag checker'),
    ]);

    expectAllow(dispatch(dir, 'C2 vcs repo-flag checker', ['scripts/lib/vcs.mjs'], { transcriptPath }));
    expectAllow(dispatch(dir, 'Fix self-defeating findings floor', ['scripts/lib/vcs.mjs'], { transcriptPath }));
  });

  it('still DENIES two RUNNING agents that overlap — the async launch ACK is not a completion', () => {
    // THE boundary this repair must not cross. A background dispatch gets a
    // tool_result within ~0.2 s reading "Async agent launched successfully".
    // Counting that as completion would let every real parallel batch collision
    // through — strictly worse than the pre-repair state. The agent is running;
    // the deny must stand.
    const dir = makeProjectDir();
    const transcriptPath = writeTranscript(dir, [
      transcriptDispatch('Agent A', 'toolu_01C'),
      transcriptAsyncLaunchAck('toolu_01C', 'a1b2c3d4e5f60718a'),
    ]);

    expectAllow(dispatch(dir, 'Agent A', ['scripts/foo.mjs'], { transcriptPath }));
    const denied = dispatch(dir, 'Agent B', ['scripts/foo.mjs'], { transcriptPath });
    expectDeny(denied, ['Agent A', 'Agent B', 'scripts/foo.mjs', 'STILL-RUNNING']);
  });

  it('still DENIES when the prior agent was dispatched but has no result at all (sync, in flight)', () => {
    // The same-batch case, measured: five `Agent` rows inside 0.44 s, their
    // results 5–11 minutes later. At agent #5's PreToolUse none of #1…#4 has a
    // result — every one of them is in flight and a real overlap must deny.
    const dir = makeProjectDir();
    const transcriptPath = writeTranscript(dir, [transcriptDispatch('Agent A', 'toolu_01D')]);

    expectAllow(dispatch(dir, 'Agent A', ['scripts/foo.mjs'], { transcriptPath }));
    expectDeny(dispatch(dir, 'Agent B', ['scripts/foo.mjs'], { transcriptPath }), 'STILL-RUNNING');
  });

  it('does NOT invent a completion when the deny reason names an agent the transcript never mentions', () => {
    // Matrix row 13: no evidence must resolve to IN FLIGHT, never to "finished".
    // A probe that defaulted the unknown case to finished would silently disarm
    // the guard for every dispatch whose description the transcript lags behind.
    const dir = makeProjectDir();
    const transcriptPath = writeTranscript(dir, [
      transcriptDispatch('Some unrelated agent', 'toolu_01E'),
      transcriptSyncResult('toolu_01E'),
    ]);

    expectAllow(dispatch(dir, 'Agent A', ['scripts/foo.mjs'], { transcriptPath }));
    expectDeny(dispatch(dir, 'Agent B', ['scripts/foo.mjs'], { transcriptPath }), 'Agent A');
  });

  it('releases a blind ledger entry once it is older than the in-flight TTL', () => {
    // Bug caught: with no transcript at all the ledger would bind FOREVER — the
    // permanent-block half of the HIGH finding, reintroduced through the back
    // door. The blind fallback is bounded by IN_FLIGHT_TTL_MS (30 min; measured
    // max same-batch spread is 95.7 s, ~19× headroom).
    const dir = makeProjectDir();
    const ledgerPath = path.join(dir, LEDGER_REL);
    const stale = {
      waveKey: 's1|w?|?',
      updated: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      agents: [{
        id: 'Agent A (code-implementer)',
        desc: 'Agent A',
        files: ['scripts/foo.mjs'],
        at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      }],
    };
    writeFileSync(ledgerPath, JSON.stringify(stale));
    expectAllow(dispatch(dir, 'Agent B', ['scripts/foo.mjs']));

    // ...while a FRESH blind entry still binds — the TTL relaxes the old case only.
    const fresh = { ...stale, agents: [{ ...stale.agents[0], at: new Date().toISOString() }] };
    writeFileSync(ledgerPath, JSON.stringify(fresh));
    expectDeny(dispatch(dir, 'Agent B', ['scripts/foo.mjs']), 'Agent A');
  });
});

describe('pre-task-scope-disjoint — the wave-key fallback, pinned', () => {
  it('binds a still-RUNNING agent across a wave boundary when no wave-scope.json exists', () => {
    // Bug caught (review MED, direction pinned): with no readable
    // `wave-scope.json` the ledger key degrades to `<session>|w?|?`, so wave-3
    // meets wave-1 records. The old doc comment claimed this "over-reports
    // nothing" — measured false. It is now BOUNDED rather than denied: a prior
    // record binds only while its agent is in flight, and an agent still running
    // across a wave boundary is a real race, not an artefact of the key.
    const dir = makeProjectDir();
    expect(existsSync(path.join(dir, '.claude', 'wave-scope.json'))).toBe(false);
    const transcriptPath = writeTranscript(dir, [transcriptDispatch('W1-A', 'toolu_01F')]);

    expectAllow(dispatch(dir, 'W1-A', ['scripts/lib/foo.mjs'], { transcriptPath }));
    expectDeny(dispatch(dir, 'W3-Z', ['scripts/lib/foo.mjs'], { transcriptPath }), ['W1-A', 'W3-Z']);
  });

  it('does NOT bind across that boundary once the wave-1 agent has finished', () => {
    // The other half of the pin — and the reason the fallback is acceptable at
    // all. A finished wave-1 owner must not block wave 3; before the liveness
    // probe it did, for the whole session.
    const dir = makeProjectDir();
    const transcriptPath = writeTranscript(dir, [
      transcriptDispatch('W1-A', 'toolu_01G'),
      transcriptSyncResult('toolu_01G'),
    ]);

    expectAllow(dispatch(dir, 'W1-A', ['scripts/lib/foo.mjs'], { transcriptPath }));
    expectAllow(dispatch(dir, 'W3-Z', ['scripts/lib/foo.mjs'], { transcriptPath }));
  });
});

describe('pre-task-scope-disjoint — ledger concurrency', () => {
  /** Spawn the hook WITHOUT blocking, so several dispatches genuinely overlap. */
  function runHookAsync(stdin) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [HOOK], { cwd: REPO_ROOT });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(stdin);
    });
  }

  it('loses no ledger entry when eight dispatches run at the same time', async () => {
    // Bug caught (review MED, TOCTOU): read → decide → write is a read-modify-
    // write cycle with no mutual exclusion. `writeJsonAtomicSync` makes the WRITE
    // atomic, never the CYCLE — dispatches starting together read the same state
    // and overwrite each other's records. MEASURED with the lock removed: 5 of 5
    // rounds lost entries (2/8, 2/8, 6/8, 3/8, 4/8 recorded).
    const dir = makeProjectDir();
    const ids = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'];
    const results = await Promise.all(
      ids.map((id) => runHookAsync(dispatchPayload({ cwd: dir, id, files: [`scripts/${id}.mjs`] }))),
    );
    for (const r of results) expectAllow(r);

    const ledger = JSON.parse(readFileSync(path.join(dir, LEDGER_REL), 'utf8'));
    const recorded = ledger.agents.map((a) => a.id).sort();
    expect(recorded).toEqual(ids.map((id) => `${id} (code-implementer)`).sort());
  }, 30_000);

  it('still catches the collision when the two overlapping dispatches start together', async () => {
    // The CONSEQUENCE of the lost record, asserted directly: two concurrent
    // dispatches that claim one shared file must produce exactly ONE deny. With
    // the cycle unlocked both read the pre-state and both are ALLOWED — measured
    // 5 of 5 rounds `denies=0`, i.e. the guard silently off for the very pair it
    // exists for. The wide window here is a REAL configuration: both dispatches
    // collide with a finished predecessor, so both run the transcript scan inside
    // the cycle (§ Liveness).
    const dir = makeProjectDir();
    const now = new Date().toISOString();
    writeFileSync(path.join(dir, LEDGER_REL), JSON.stringify({
      waveKey: 's1|w?|?',
      updated: now,
      agents: [{ id: 'Owner (code-implementer)', desc: 'Owner', files: ['scripts/shared.mjs'], at: now }],
    }));
    const padRow = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(900) }] },
    });
    const transcriptPath = writeTranscript(dir, [
      transcriptDispatch('Owner', 'toolu_01H'),
      transcriptSyncResult('toolu_01H'),
      ...Array(8000).fill(padRow), // ~7 MB — a mid-sized real transcript
    ]);

    const [r1, r2] = await Promise.all([
      runHookAsync(dispatchPayload({ cwd: dir, id: 'R1', files: ['scripts/shared.mjs', 'scripts/r1.mjs'], transcriptPath })),
      runHookAsync(dispatchPayload({ cwd: dir, id: 'R2', files: ['scripts/shared.mjs', 'scripts/r2.mjs'], transcriptPath })),
    ]);

    // Deliberate inline envelope reference, not a lazy copy: we must SELECT which
    // of two concurrent results denied before we can assert on it, and the shared
    // helper offers assertions only (expectDeny/expectAllow/expectWarn), no
    // predicate form. Closing this properly means adding an `isDeny(result)`
    // predicate to tests/_helpers/hook-decision.mjs — tracked, not papered over.
    const denied = [r1, r2].filter((r) => r.stdout.includes('"permissionDecision":"deny"'));
    expect(denied).toHaveLength(1);
    expectDeny(denied[0], 'scripts/shared.mjs');
  }, 30_000);
});

describe('pre-task-scope-disjoint — import safety (isMain)', () => {
  it('does not TERMINATE the importing process — the importer decides its own exit code', () => {
    // Bug caught (review MED): without a self-execution guard, importing this
    // module ran main(), blocked ~5 s on stdin and then called `emitAllow()`,
    // which is `process.exit(0)` — the IMPORTING process was killed, and under
    // ADR-0011 that exit-0-with-empty-stdout is itself an ALLOW. The five exports
    // were unimportable in practice (grep: 0 importers).
    //
    // The discriminator is the EXIT CODE, not a timing proxy: the child sets
    // `process.exitCode = 7` and lets node exit naturally. A hijacked
    // `process.exit(0)` overrides that to 0, whatever the timing.
    const child = `
      import(${JSON.stringify(pathToFileURL(HOOK).href)}).then((m) => {
        process.stdout.write('EXPORTS:' + [typeof m.decide, typeof m.listTrackedFiles].join(','));
        process.exitCode = 7;
      });
    `;
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'], // stdin stays OPEN: main() would block on it
      timeout: 20_000,
    });

    expect(res.stdout).toContain('EXPORTS:function,function');
    expect(res.status).toBe(7);
  });

  it('exposes its parsing surface to an importer at all', async () => {
    // The other half: the guard must not be so wide that the module stops
    // loading. Every export the tests below reach for has to be there.
    const mod = await import(pathToFileURL(HOOK).href);
    for (const name of ['decide', 'extractScopeFromPrompt', 'extractScopeSignal', 'listTrackedFiles',
      'normalizeScopeEntry', 'promoteDirEntries', 'buildTranscriptIndex', 'makeFinishedProbe',
      'bumpSignalCounter']) {
      expect(typeof mod[name]).toBe('function');
    }
  });
});

describe('pre-task-scope-disjoint — path spelling and git-root alignment', () => {
  it('treats `./x.mjs` and `x.mjs` as the SAME file', async () => {
    // Bug caught (review LOW): the hook extracts from PROSE and
    // `looksLikeRepoPath` admits a `./` prefix, so two agents spelling one file
    // two ways compared as DISJOINT — measured ok:true before the fix. Both then
    // edit it, which is exactly the race the hook exists to stop.
    const dir = makeProjectDir();
    expectAllow(dispatch(dir, 'Agent A', ['./scripts/lib/foo.mjs']));
    expectDeny(dispatch(dir, 'Agent B', ['scripts/lib/foo.mjs']), ['scripts/lib/foo.mjs', 'concrete']);
  });

  it('collapses duplicated slashes and `/./` segments before comparing', async () => {
    // Same class, the two other spellings a hand-written scope block produces.
    const { normalizeScopeEntry } = await import(pathToFileURL(HOOK).href);
    expect(normalizeScopeEntry('./scripts//lib/./foo.mjs')).toBe('scripts/lib/foo.mjs');
    expect(normalizeScopeEntry('scripts/lib/')).toBe('scripts/lib/'); // prefix operator preserved
    expect(normalizeScopeEntry('scripts/**/*.mjs')).toBe('scripts/**/*.mjs');
  });

  it('promotes a bare directory entry to its `dir/` prefix ON EVIDENCE, never by guess', async () => {
    // Bug caught (review LOW): `scripts/lib/` and `scripts/lib` are one claim,
    // but `pathMatchesPattern` reads only the first as a prefix — measured
    // ok:true (disjoint) for that pair. The promotion is evidence-gated: with no
    // tracked file beneath it, or with the entry itself tracked, nothing moves.
    const { promoteDirEntries } = await import(pathToFileURL(HOOK).href);
    const known = new Set(['scripts/lib/io.mjs', 'scripts/lib/foo.mjs', 'README.md']);
    expect(promoteDirEntries(['scripts/lib'], known)).toEqual(['scripts/lib/']);
    expect(promoteDirEntries(['README.md'], known)).toEqual(['README.md']);   // a tracked FILE
    expect(promoteDirEntries(['docs/nope'], known)).toEqual(['docs/nope']);   // no witness
    expect(promoteDirEntries(['scripts/lib'], new Set())).toEqual(['scripts/lib']); // git down
  });

  it('lists tracked files repo-relative even when the session cwd is a SUBDIRECTORY', async () => {
    // Bug caught (review MED): `listTrackedFiles` ran `git ls-files` with
    // cwd=projectDir and no `git rev-parse --show-toplevel`, while the CLI's
    // `knownRepoFiles()` resolves the toplevel first. From a subdirectory the
    // hook therefore got SUBDIR-relative paths, stage 3a lost every witness, and
    // the hook ALLOWED what `validate-wave-scope.mjs --assert-disjoint` calls a
    // collision — the dangerous direction, since the hook is the last gate.
    const { listTrackedFiles } = await import(pathToFileURL(HOOK).href);
    const fromSubdir = listTrackedFiles(path.join(REPO_ROOT, 'scripts', 'lib'));
    const fromRoot = execFileSync('git', ['ls-files', '-z'], {
      cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    }).split('\0').filter((f) => f.length > 0);

    expect(fromSubdir).toEqual(fromRoot);
    // A repo-relative entry from OUTSIDE the cwd that was passed in — the exact
    // shape a subdir-relative listing could never produce.
    expect(fromSubdir).toContain('scripts/lib/scope-gate.mjs');
  });
});

describe('pre-task-scope-disjoint — fake regression (proves the guard bites)', () => {
  /**
   * Copy the hook into $TMPDIR with symlinks back to the real `scripts/` and
   * `hooks/_lib/`, so PLUGIN_ROOT resolution still finds its dependencies. The
   * copy can then be defect-injected without touching the tracked file.
   */
  function stageHookCopy(mutate) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ptsd-fake-'));
    mkdirSync(path.join(root, 'hooks'), { recursive: true });
    symlinkSync(path.join(REPO_ROOT, 'scripts'), path.join(root, 'scripts'), 'dir');
    symlinkSync(path.join(REPO_ROOT, 'hooks', '_lib'), path.join(root, 'hooks', '_lib'), 'dir');
    const src = readFileSync(HOOK, 'utf8');
    const mutated = mutate(src);
    expect(mutated).not.toBe(src); // the injection must actually have landed
    const dest = path.join(root, 'hooks', 'pre-task-scope-disjoint.mjs');
    writeFileSync(dest, mutated);
    return dest;
  }

  it('a copy that misreads ok as "evaluable" ALLOWS the very collision the real hook denies', () => {
    // THE defect this guard's own review turned up: `findScopeCollisions`
    // returns `ok: collisions.length === 0 && duplicateIds.length === 0` — `ok`
    // means DISJOINT, not EVALUABLE. Reading it as evaluability sends every
    // genuine collision down the "not evaluable" warn path, i.e. an ALLOW.
    // Restoring that read must turn the deny test RED.
    const brokenHook = stageHookCopy((src) =>
      src.replace(
        "if (verdictLib?.ok !== true && collisions.length === 0 && duplicateIds.length === 0) {",
        "if (verdictLib?.ok !== true) {",
      ),
    );

    const dir = makeProjectDir();
    expectAllow(runHook(dispatchPayload({ cwd: dir, id: 'Agent A', files: ['scripts/foo.mjs'] }), { hook: brokenHook }));
    const shouldHaveBeenDenied = runHook(
      dispatchPayload({ cwd: dir, id: 'Agent B', files: ['scripts/foo.mjs'] }),
      { hook: brokenHook },
    );

    // The defect's signature: a warn (allow) where a deny belongs.
    expect(shouldHaveBeenDenied.stdout).not.toContain('"permissionDecision":"deny"');
    expect(() => expectDeny(shouldHaveBeenDenied, 'scripts/foo.mjs')).toThrow();

    // ...and the real hook, same inputs, denies.
    const dir2 = makeProjectDir();
    expectAllow(dispatch(dir2, 'Agent A', ['scripts/foo.mjs']));
    expectDeny(dispatch(dir2, 'Agent B', ['scripts/foo.mjs']), 'scripts/foo.mjs');
  });

  it('a copy whose collision filter drops the current agent ALLOWS the collision', () => {
    // Second defect shape: filtering collisions to those involving THIS
    // dispatch is what makes the deny targeted. Inverting the filter empties
    // the actionable set and the hook allows everything.
    const brokenHook = stageHookCopy((src) =>
      src.replace(
        "const mine = collisions.filter((c) => c?.a === id || c?.b === id);",
        "const mine = collisions.filter((c) => c?.a !== id && c?.b !== id);",
      ),
    );

    const dir = makeProjectDir();
    expectAllow(runHook(dispatchPayload({ cwd: dir, id: 'Agent A', files: ['scripts/foo.mjs'] }), { hook: brokenHook }));
    const leaked = runHook(
      dispatchPayload({ cwd: dir, id: 'Agent B', files: ['scripts/foo.mjs'] }),
      { hook: brokenHook },
    );
    expect(leaked.stdout).not.toContain('"permissionDecision":"deny"');
    expect(() => expectDeny(leaked, 'scripts/foo.mjs')).toThrow();
  });
});


// ---------------------------------------------------------------------------
// #1092 — the scope marker missed the real prompts, and the resulting ALLOW
// left no trace. Measured 2026-08-26 over 709 of this repo's own subagent
// prompts: widening the 80-char window adds 34 marker hits and 0 extracted
// paths, while the inline comma-separated declaration shape recovers 9.
// ---------------------------------------------------------------------------
describe('pre-task-scope-disjoint — scope signal shapes and counters (#1092)', () => {
  /** @type {any} */ let mod;
  async function load() { mod ??= await import(pathToFileURL(HOOK).href); return mod; }

  it('extracts an INLINE comma-separated declaration written mid-sentence', async () => {
    const { extractScopeSignal } = await load();
    // The measured miss class: 7 of 15 transcripts of a real prior session put
    // "FILE-SCOPE" at column 210…506 with the paths inline, not fenced. The
    // fenced-only extractor returned [] and the dispatch went unchecked.
    const prompt = 'Du bist C2. Max 25 turns. Do NOT commit (PSA-007). '
      + 'Edit ONLY your FILE-SCOPE: scripts/lib/reconcile/emitter.mjs, scripts/lib/reconcile/renderer.mjs, '
      + 'tests/lib/reconcile/emitter.test.mjs.\n\nMach die Arbeit.';

    expect(extractScopeSignal(prompt)).toEqual({
      status: 'extracted',
      shape: 'inline',
      files: [
        'scripts/lib/reconcile/emitter.mjs',
        'scripts/lib/reconcile/renderer.mjs',
        'tests/lib/reconcile/emitter.test.mjs',
      ],
    });
  });

  it('reads a CITATION of the vocabulary as no declaration at all', async () => {
    const { extractScopeSignal } = await load();
    // The direction a widened window fails in: these are the prompts the
    // 600-char window newly matches. Inventing scope from prose could DENY a
    // legitimate dispatch — the one direction this hook must not fail in.
    // Asserting the STATUS here would be wrong and the first draft of this test
    // was: shape 1's line-leading window already matches these (they are short
    // lines), so the honest classification is 'unparseable' — a marker matched
    // and no path survived. What must hold is the direction that can do damage:
    // ZERO paths, because an invented entry could DENY a legitimate dispatch.
    for (const prose of [
      'Every count MUST quote the exact command you ran, the file scope, the result, and HEAD SHA.',
      'Nenne, ob sich Datei-Scopes ueberschneiden (wichtig fuer File-Scope-Disjunktheit).',
      'Das Nachbardokument (Zeile 349, nicht dein Scope) skopiert bereits korrekt.',
      // The one MY change could break: a compound noun followed by a colon and
      // real paths. At a 24-char operator tail this harvested both files.
      'Pruefe (File-Scope-Disjunktheit: scripts/a.mjs, scripts/b.mjs) vor der Welle.',
      // ... and a citation whose sentence genuinely continues with a path.
      'Beachte deinen File-Scope und lies zuerst scripts/lib/scope-gate.mjs dazu.',
    ]) {
      expect(extractScopeSignal(prose).files).toEqual([]);
    }
  });

  it('keeps the fenced shape ahead of the inline shape when both are present', async () => {
    const { extractScopeSignal } = await load();
    const prompt = 'Edit ONLY your FILE-SCOPE: scripts/wrong.mjs\n\n'
      + '## DEIN DATEI-SCOPE\n```\nscripts/right.mjs\n```\n';

    // Precedence is the whole point: the documented line-leading + fenced form
    // wins, so adding shape 2 cannot silently re-point an existing extraction.
    expect(extractScopeSignal(prompt).files).toEqual(['scripts/right.mjs']);
  });

  it('classifies a marker with an unusable block as unparseable, not absent', async () => {
    const { extractScopeSignal } = await load();
    const prompt = '## FILE-SCOPE\n```\nsiehe die Wellenplanung im Vault\n```\n';

    // Row 6 vs row 5. Collapsing them is exactly what makes "the coordinator
    // injected nothing" indistinguishable from "the parser gave up".
    // `shape: 'none'` is the load-bearing half: a fenced block WAS present, so a
    // shape field that merely mirrored the status would report 'fenced' here and
    // an event consumer would read a parsed scope where none survived.
    expect(extractScopeSignal(prompt)).toEqual({ status: 'unparseable', shape: 'none', files: [] });
  });

  it('records a counter on the no-signal ALLOW instead of leaving no trace', async () => {
    const { decide } = await load();
    const base = { ledger: null, ledgerCorrupt: false, waveKey: 's1|w2|k', knownFiles: [],
      collide: () => ({ ok: true, collisions: [], duplicateIds: [] }), nowIso: '2026-08-26T00:00:00.000Z' };
    const call = (prompt) => decide({ ...base, input: { tool_name: 'Agent', tool_input: { description: 'A', prompt } } });

    const absent = call('Mach die Arbeit, keine Datei genannt.');
    const unparseable = call('## FILE-SCOPE\n```\nsiehe Wellenplan\n```\n');
    const extracted = call('## FILE-SCOPE\n```\nscripts/a.mjs\n```\n');

    // The defect: all three previously returned { action: 'allow' } with NO
    // ledger field, so main() wrote nothing and the three cases were
    // byte-identical to the guard never having run.
    expect(absent.action).toBe('allow');
    expect(absent.ledger.scopeSignals).toEqual({ 'marker-absent': 1, unparseable: 0, extracted: 0 });
    expect(unparseable.ledger.scopeSignals).toEqual({ 'marker-absent': 0, unparseable: 1, extracted: 0 });
    expect(extracted.ledger.scopeSignals).toEqual({ 'marker-absent': 0, unparseable: 0, extracted: 1 });
  });

  it('counts only — no prompt text, no paths, no agent ids leak into the tally', async () => {
    const { decide } = await load();
    const verdict = decide({
      input: { tool_name: 'Agent', tool_input: { description: 'Secret-Agent', prompt: 'nothing scoped here' } },
      ledger: null, ledgerCorrupt: false, waveKey: 's1|w2|k', knownFiles: [],
      collide: () => ({ ok: true, collisions: [], duplicateIds: [] }), nowIso: '2026-08-26T00:00:00.000Z',
    });

    // The ledger is a shared working-copy artefact; a scope-signal tally must
    // not become a second, unreviewed copy of prompt content.
    expect(Object.keys(verdict.ledger.scopeSignals).sort()).toEqual(['extracted', 'marker-absent', 'unparseable']);
    for (const v of Object.values(verdict.ledger.scopeSignals)) expect(typeof v).toBe('number');
    expect(JSON.stringify(verdict.ledger)).not.toContain('nothing scoped here');
  });

  it('does not erase the wave\'s recorded agents when a no-scope dispatch is counted', async () => {
    const { decide } = await load();
    const prior = { waveKey: 's1|w2|k', updated: '2026-08-26T00:00:00.000Z',
      agents: [{ id: 'A1', desc: 'A1', files: ['scripts/a.mjs'], at: '2026-08-26T00:00:00.000Z' }] };

    const verdict = decide({
      input: { tool_name: 'Agent', tool_input: { description: 'A2', prompt: 'no scope in this prompt' } },
      ledger: prior, ledgerCorrupt: false, waveKey: 's1|w2|k', knownFiles: [],
      collide: () => ({ ok: true, collisions: [], duplicateIds: [] }), nowIso: '2026-08-26T00:01:00.000Z',
    });

    // Writing a FRESH ledger on the counting path would drop A1's scope claim
    // and disable collision detection for the rest of the wave — a far worse
    // bug than the missing counter it was added to fix.
    expect(verdict.ledger.agents).toEqual(prior.agents);
    expect(verdict.ledger.scopeSignals['marker-absent']).toBe(1);
  });

  it('carries the tally forward across dispatches of the same wave and resets on a new one', async () => {
    const { bumpSignalCounter } = await load();
    const first = bumpSignalCounter(null, 'w2', 'marker-absent');
    const second = bumpSignalCounter({ waveKey: 'w2', scopeSignals: first }, 'w2', 'extracted');

    expect(second).toEqual({ 'marker-absent': 1, unparseable: 0, extracted: 1 });
    // A tally that accumulated across waves would report last wave's coverage
    // as this wave's.
    expect(bumpSignalCounter({ waveKey: 'w2', scopeSignals: second }, 'w3', 'extracted'))
      .toEqual({ 'marker-absent': 0, unparseable: 0, extracted: 1 });
  });

  it('marks ledger_result as warn-not-evaluable when the collision library throws (matrix row 9)', async () => {
    // Bug caught: 4 of 6 `ledger_result` literals ('allow'/'no-scope' are
    // pinned by the tests below) were never asserted anywhere — a typo'd
    // literal on THIS branch would silently misreport an UNVERIFIED
    // disjointness check as a clean decision in the ledger telemetry, exactly
    // the "assertion without evidence" matrix row 9 exists to avoid trusting.
    const { decide } = await load();
    const verdict = decide({
      input: { tool_name: 'Agent', tool_input: { description: 'A', prompt: '## FILE-SCOPE\n```\nscripts/a.mjs\n```\n' } },
      ledger: null,
      ledgerCorrupt: false,
      waveKey: 's1|w2|k',
      knownFiles: [],
      collide: () => { throw new Error('scope-gate blew up'); },
      nowIso: '2026-08-26T00:00:00.000Z',
    });

    expect(verdict.action).toBe('warn');
    expect(verdict.telemetry.ledger_result).toBe('warn-not-evaluable');
  });

  it('clamps agent_id to 120 chars in the telemetry payload for a long dispatch description', async () => {
    // Bug caught: MAX_AGENT_ID_CHARS (120) truncation (`id.slice(0,
    // MAX_AGENT_ID_CHARS)`) is applied to every telemetry record but never
    // exercised — a dropped `.slice()` call or an off-by-one bound would let
    // an oversized agent_id back into the stdout-clamped event payload
    // unnoticed (§ stdout discipline).
    const { decide } = await load();
    const longDesc = 'A'.repeat(300);
    const verdict = decide({
      input: {
        tool_name: 'Agent',
        tool_input: { description: longDesc, subagent_type: 'code-implementer', prompt: 'no scope in this prompt' },
      },
      ledger: null,
      ledgerCorrupt: false,
      waveKey: 's1|w2|k',
      knownFiles: [],
      collide: () => ({ ok: true, collisions: [], duplicateIds: [] }),
      nowIso: '2026-08-26T00:00:00.000Z',
    });

    expect(verdict.telemetry.agent_id.length).toBe(120);
  });
});
// ---------------------------------------------------------------------------
// #1092 — the LEDGER half: one telemetry record per dispatch decision.
//
// The in-ledger counter (above) is a WAVE tally: it says how many dispatches of
// this wave carried a scope, never WHICH one did. These tests pin the per-
// dispatch record — and the boundary the issue's acceptance criterion 3 draws
// around its payload.
// ---------------------------------------------------------------------------
describe('pre-task-scope-disjoint — per-dispatch scope_checked event (#1092)', () => {
  const EVENT = 'orchestrator.wave_dispatch.scope_checked';

  it(`emits ONE ${EVENT} for a fenced FILE-SCOPE block, with no path string in the payload`, () => {
    // Bug caught: a dispatch whose FILE-SCOPE block WAS injected and parsed left
    // no per-dispatch trace at all — the wave counter said "3 extracted" while
    // nothing said which three agents those were, so "agent W3-P7 dispatched
    // unscoped" was unfalsifiable after the fact (HR-105). Second bug, in the
    // other direction: an observability record that copies the scope INTO the
    // ledger turns telemetry into a second, unreviewed copy of prompt content —
    // and this payload also travels over the optional Clank webhook.
    const dir = makeProjectDir();
    expectAllow(dispatch(dir, 'W3-P7', ['scripts/lib/alpha.mjs', 'tests/lib/alpha.test.mjs']));

    const events = scopeEvents(dir);
    expect(events).toHaveLength(1);
    const [ev] = events;

    expect(ev.injected).toBe(true);
    expect(ev.shape).toBe('fenced');
    expect(ev.signal).toBe('extracted');
    expect(ev.declared_path_count).toBe(2);
    expect(ev.ledger_result).toBe('allow');
    expect(ev.collision_count).toBe(0);
    expect(ev.agent_id).toBe('W3-P7 (code-implementer)');
    expect(ev.hook).toBe('pre-task-scope-disjoint');

    // Acceptance criterion 3: no prompt body, no declared path, in any field.
    const line = JSON.stringify(ev);
    expect(line).not.toContain('scripts/lib/alpha.mjs');
    expect(line).not.toContain('tests/lib/alpha.test.mjs');
    expect(line).not.toContain('Mach die Arbeit');
  });

  it('emits the ABSENT case too — injected:false, shape:none — and does not change the verdict', () => {
    // Bug caught: the case worth measuring is the one that produces NO scope
    // (71.4 % of real prompts, matrix row 5). Emitting only on the extracted
    // path would rebuild the original defect one layer up: a wave with zero
    // injections and a wave whose hook never ran would again be identical in the
    // ledger. `expectAllow` re-pins the decision channel EMPTY, so the added
    // telemetry is proven not to have moved the verdict.
    const dir = makeProjectDir();
    const payload = JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: 's1', cwd: dir,
      tool_input: { description: 'Freeform', subagent_type: 'explore', prompt: 'Research the topic and report back.' },
    });

    expectAllow(runHook(payload));

    const events = scopeEvents(dir);
    expect(events).toHaveLength(1);
    expect(events[0].injected).toBe(false);
    expect(events[0].shape).toBe('none');
    expect(events[0].signal).toBe('marker-absent');
    expect(events[0].declared_path_count).toBe(0);
    expect(events[0].ledger_result).toBe('no-scope');
  });

  it('still DENIES a real collision when the event write itself fails', () => {
    // Bug caught: an un-caught `await emitEvent(...)` on the decision path turns
    // a full disk, a read-only mount or a clobbered metrics path into an
    // unchecked dispatch — the hook's `main().catch` allows on any throw (matrix
    // row 12), so a telemetry fault would silently disarm the one case this hook
    // exists for. Here `.orchestrator/metrics` is a FILE, so emitEvent's
    // recursive mkdir throws; the deny must survive it.
    const dir = makeProjectDir();
    writeFileSync(path.join(dir, '.orchestrator', 'metrics'), 'not a directory');

    expectAllow(dispatch(dir, 'Agent A', ['scripts/foo.mjs']));
    expectDeny(dispatch(dir, 'Agent B', ['scripts/foo.mjs']), ['Agent B', 'Agent A', 'scripts/foo.mjs']);
    // ...and nothing was written where a file already sat.
    expect(readFileSync(path.join(dir, '.orchestrator', 'metrics'), 'utf8')).toBe('not a directory');
  });
});
