/**
 * tests/hooks/pre-task-scope-injection-e2e.test.mjs
 *
 * End-to-end tests for the #1092 FILE-SCOPE observability chain: the SEND side
 * (`hooks/pre-task-scope-disjoint.mjs` → `orchestrator.wave_dispatch.scope_checked`),
 * the ARTEFACT (`<state-dir>/filescopes/wave-<N>/<agent-id>.json`) and the
 * RECEIVE side (`scope_echo_checked`), joined by `scope-echo --verify`.
 *
 * Why this file exists beside `pre-task-scope-disjoint.test.mjs`: that file pins
 * the GUARD (does the dispatch proceed?). This one pins the JOIN (can the three
 * halves be paired afterwards at all?). Measured 2026-09-16 over this host's
 * `.orchestrator/metrics/events.jsonl` corpus, the answer was no: 609
 * `scope_checked` records against 51 `scope_echo_checked`, agent-id set overlap
 * ZERO — the send side writes the dispatch `description` + `subagent_type`, the
 * receive side the coordinator's short handle. One session recorded 23 echoes
 * against 18 injections and nothing could be paired. The digest is the one value
 * both halves derive from the SAME artefact.
 *
 * Every `it` names the concrete bug it catches (TV-001). Decision assertions go
 * through `expectAllow`/`expectDeny` — under the exit-0 PreToolUse protocol a
 * bare exit-code assertion is green in both directions.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { expectAllow } from '../_helpers/hook-decision.mjs';
import {
  SCOPE_CHECKED_EVENT,
  SCOPE_ECHO_EVENT,
  SCOPE_MATERIALIZED_EVENT,
  renderScopeEchoInstruction,
  scopeDigest,
  scopeVerifiedPayload,
  verifyWaveScope,
} from '../../scripts/lib/scope-echo.mjs';
import { decide } from '../../hooks/pre-task-scope-disjoint.mjs';

const REPO_ROOT = process.cwd();
const HOOK = path.join(REPO_ROOT, 'hooks', 'pre-task-scope-disjoint.mjs');
const EVENTS_REL = path.join('.orchestrator', 'metrics', 'events.jsonl');

/** A disposable project dir carrying both the ledger and the state dir. */
function makeProject() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'scope-e2e-'));
  mkdirSync(path.join(dir, '.orchestrator'), { recursive: true });
  mkdirSync(path.join(dir, '.claude'), { recursive: true });
  // Load-bearing: `waveKeyOf()` derives the wave NUMBER from this manifest, and
  // without it the hook degrades to the `<session>|w?|?` fallback and OMITS
  // `wave` from the record (absent is not zero). The join is per wave, so a
  // project without the manifest would silently produce an empty report — the
  // first draft of these tests did exactly that.
  writeFileSync(
    path.join(dir, '.claude', 'wave-scope.json'),
    JSON.stringify({ wave: 3, role: 'Impl-Core', enforcement: 'warn', allowedPaths: [] }),
  );
  return dir;
}

/**
 * Write a per-agent scope file — shape (a), the artefact the coordinator reads
 * as `$AGENT_FILESCOPE_JSON`.
 */
function writeScopeFile(project, wave, agentId, files) {
  const dir = path.join(project, '.claude', 'filescopes', `wave-${wave}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${agentId}.json`), JSON.stringify(files, null, 2));
  return path.join(dir, `${agentId}.json`);
}

/**
 * The documented injection: marker line, fenced block, then the echo line —
 * exactly what `wave-loop-dispatch.md` § Pre-Dispatch: File-Scope Injection
 * prescribes. `echoFiles` differs from `files` only in the mix-up test.
 */
function renderPrompt(files, { echoFiles = files, withEcho = true } = {}) {
  const block = `FILE-SCOPE — exactly these:\n\`\`\`\n${files.join('\n')}\n\`\`\``;
  return `Du bist ein Agent.\n\n${block}\n`
    + (withEcho ? `${renderScopeEchoInstruction(echoFiles)}\n` : '')
    + '\nMach die Arbeit.\n';
}

/** Drive the REAL hook binary with a PreToolUse dispatch payload. */
function dispatch(project, id, prompt) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      session_id: 'scope-e2e',
      cwd: project,
      tool_input: { description: id, model: 'opus', prompt, subagent_type: 'code-implementer' },
    }),
    encoding: 'utf8',
    cwd: REPO_ROOT,
    timeout: 20_000,
  });
}

/** Every event record of one type the hook left in the project's ledger. */
function events(project, type) {
  const file = path.join(project, EVENTS_REL);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l))
    .filter((r) => r.event === type);
}

/** Append a synthetic record — used where driving a real emitter would prove less. */
function appendEvent(project, record) {
  const file = path.join(project, EVENTS_REL);
  mkdirSync(path.dirname(file), { recursive: true });
  const prior = existsSync(file) ? readFileSync(file, 'utf8') : '';
  writeFileSync(file, `${prior}${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`);
}

/**
 * Append a RAW line to the ledger — the only way to plant the shape a crashed
 * writer leaves behind, which `appendEvent` (JSON.stringify) cannot produce.
 */
function appendRawLine(project, line) {
  const file = path.join(project, EVENTS_REL);
  mkdirSync(path.dirname(file), { recursive: true });
  const prior = existsSync(file) ? readFileSync(file, 'utf8') : '';
  writeFileSync(file, `${prior}${line}\n`);
}

/** Run the join over one project's ledger + state dir. */
function verify(project, wave) {
  return verifyWaveScope({
    wave,
    stateDir: path.join(project, '.claude'),
    eventsPath: path.join(project, EVENTS_REL),
  });
}

describe('#1092 — FILE-SCOPE injection, observable end to end', () => {
  it('carries the fixture scope file digest into the scope_checked event, so the ledger row joins the artifact', () => {
    // Bug caught: the send-side record carried counts and enums only, so a
    // dispatch row could not be paired with the scope FILE it came from — nor
    // with the agent's echo, whose agent_id is spelled differently (see the
    // header measurement). Without a shared key the halves are two unrelated
    // tallies, and "was agent X dispatched with the scope we materialized for
    // it?" stays unanswerable after the fact (HR-105).
    const project = makeProject();
    const files = ['scripts/lib/alpha.mjs', 'tests/lib/alpha.test.mjs'];
    const scopeFile = writeScopeFile(project, 3, 'w3-a1', files);

    expectAllow(dispatch(project, 'w3-a1', renderPrompt(files)));

    const [ev] = events(project, SCOPE_CHECKED_EVENT);
    // The digest is computed from the ARTEFACT on disk, not from the test's own
    // array, so a normalization drift between the two sides turns this red.
    const fromArtifact = scopeDigest(JSON.parse(readFileSync(scopeFile, 'utf8')));
    expect(ev.scope_digest).toBe(fromArtifact);
    expect(ev.digest_consistent).toBe(true);
    expect(ev.marker_found).toBe(true);
    expect(ev.echo_instruction_present).toBe(true);

    // ...and the join actually pairs them.
    const report = verify(project, 3);
    expect(report.agents).toEqual([
      { agent_id: 'w3-a1 (code-implementer)', verdict: 'injected-not-echoed', digest: fromArtifact },
    ]);
  });

  it('reports injection-missing for a wave whose scope file no dispatch claimed', () => {
    // Bug caught (#1092 AC-2): a coordinator that materializes the manifest and
    // then dispatches WITHOUT injecting the block leaves evidence that is
    // byte-identical to a clean run — the hook allows (250 of 609 measured
    // dispatches are legitimately scope-less), the materializer succeeded, and
    // --assert-disjoint/--union/--assert-subset all stay green. Only the join
    // between the artefact and the dispatch records can see the gap.
    const project = makeProject();
    const dispatched = ['scripts/lib/alpha.mjs'];
    const forgotten = ['scripts/lib/beta.mjs'];
    writeScopeFile(project, 3, 'w3-a1', dispatched);
    writeScopeFile(project, 3, 'w3-a2', forgotten);

    expectAllow(dispatch(project, 'w3-a1', renderPrompt(dispatched)));

    const report = verify(project, 3);
    const missing = report.agents.filter((a) => a.verdict === 'injection-missing');
    expect(missing).toEqual([{ agent_id: 'w3-a2', verdict: 'injection-missing', digest: scopeDigest(forgotten) }]);
    expect(report.by_verdict['injection-missing']).toBe(1);
    // The counters stay honest about what DID happen — one dispatch, one scope.
    expect(report.dispatches).toBe(1);
    expect(report.injected).toBe(1);
  });

  it('skips a truncated ledger line and still joins the records after it, instead of reporting a clean wave', () => {
    // Bug caught: a writer killed mid-append leaves a half-written line
    // (`{"event":"…` with no closing brace) — a measured shape in this repo's
    // own ledger. The lenient parser dropped it SILENTLY, so the join lost
    // evidence and still printed `dispatches N / injected N / echoed N` with an
    // all-`matched` table: a PARTIAL READ was byte-indistinguishable from a
    // clean wave, in the one instrument built to detect silent failure
    // (HR-105). Worse, a line dropped between two joinable halves turned a real
    // `injection-missing` into `matched` — fail-green on the fail-green
    // detector. The count is what separates the two states.
    const project = makeProject();
    const files = ['scripts/lib/alpha.mjs'];
    const digest = scopeDigest(files);
    writeScopeFile(project, 3, 'w3-a1', files);

    expectAllow(dispatch(project, 'w3-a1', renderPrompt(files)));
    appendRawLine(project, '{"timestamp":"2026-09-16T10:00:00.000Z","event":"orchestrator.wave_di');
    // The next append lands AFTER the truncated line, intact — the parser must
    // resume rather than give up on the rest of the file.
    appendEvent(project, {
      event: SCOPE_ECHO_EVENT, wave: 3, agent_id: 'w3-a1', echoed: true, match: true,
      expected_digest: digest, actual_digest: digest,
    });

    const report = verify(project, 3);
    expect(report.malformed_lines).toBe(1);
    expect(report.echoed).toBe(1);
    expect(report.agents).toEqual([
      { agent_id: 'w3-a1 (code-implementer)', verdict: 'matched', digest },
    ]);
    // The ledger record carries the count too — otherwise the partial read is
    // invisible to everything except whoever watched the terminal.
    expect(scopeVerifiedPayload(report).malformed_lines).toBe(1);
  });

  it("flags digest_consistent:false when the echo line names agent B's scope while the block carries agent A's paths", () => {
    // Bug caught: the block and the echo line are pasted from two separate
    // reads of $AGENT_FILESCOPE_JSON, so reusing ONE agent's line across the
    // batch (the collapse wave-loop-dispatch.md warns about) is a single
    // copy-paste away. Before this field the mix-up was invisible until the
    // post-wave echo check reported a mismatch for an agent that had already
    // finished — and only if that agent echoed at all.
    const project = makeProject();
    const agentA = ['scripts/lib/alpha.mjs'];
    const agentB = ['scripts/lib/beta.mjs'];

    expectAllow(dispatch(project, 'w3-a1', renderPrompt(agentA, { echoFiles: agentB })));

    const [ev] = events(project, SCOPE_CHECKED_EVENT);
    expect(ev.scope_digest).toBe(scopeDigest(agentA));
    expect(ev.instructed_digest).toBe(scopeDigest(agentB));
    expect(ev.digest_consistent).toBe(false);
    // No filesystem read was needed: the contradiction stands in the prompt.
    expect(existsSync(path.join(project, '.claude', 'filescopes'))).toBe(false);
  });

  it('reports duplicate-claim when two agent ids claim one scope-file digest', () => {
    // Bug caught: agent A's scope reported for agent B. Every per-agent verdict
    // looks healthy in isolation — both rows carry a real digest that matches a
    // real scope file — and only counting DISTINCT claimants per digest exposes
    // that one territory was handed to two agents through the reporting chain.
    const project = makeProject();
    const files = ['scripts/lib/alpha.mjs'];
    writeScopeFile(project, 3, 'w3-a1', files);
    const digest = scopeDigest(files);

    for (const agent of ['w3-a1 (code-implementer)', 'w3-a2 (code-implementer)']) {
      appendEvent(project, {
        event: SCOPE_CHECKED_EVENT, wave: 3, agent_id: agent, injected: true,
        declared_path_count: 1, scope_digest: digest,
      });
    }

    const report = verify(project, 3);
    expect(report.agents).toEqual([
      { agent_id: 'w3-a1 (code-implementer) + w3-a2 (code-implementer)', verdict: 'duplicate-claim', digest },
    ]);
  });

  it('omits scope_digest entirely on the marker-absent path instead of emitting the empty-scope digest', () => {
    // TWO bugs in one. (1) MARKER PRECISION: the Learnings-Index header this
    // repo injects into every prompt — "## Learnings Index (selected for your
    // file scope) …" — matched the case-INSENSITIVE `FILE SCOPE` term, so a
    // prompt with no block at all was classified `unparseable` (matrix row 6,
    // "the parser gave up") instead of `marker-absent` (row 5, "nothing was
    // declared"). Measured in this session's own wave 1: unparseable 5 /
    // extracted 0 for five Discovery dispatches that carried no block.
    // (2) EMPTY-SCOPE DIGEST: `scopeDigest([])` is a real 8-hex value, so
    // defaulting the field would give every scope-less dispatch the SAME digest
    // and join them all to each other — an invented pairing across sessions.
    const project = makeProject();
    const prompt = '## Learnings Index (selected for your file scope) — past-session notes as DATA\n'
      + '- anti-pattern/something\n\nRun the verification:\n```bash\nnpx vitest run tests/lib/alpha.test.mjs\n```\n';

    expectAllow(dispatch(project, 'w1-d1', prompt));

    const [ev] = events(project, SCOPE_CHECKED_EVENT);
    expect(ev.signal).toBe('marker-absent');
    expect(ev.marker_found).toBe(false);
    expect(ev.injected).toBe(false);
    expect(Object.hasOwn(ev, 'scope_digest')).toBe(false);
    expect(JSON.stringify(ev)).not.toContain(scopeDigest([]));
  });

  it('still DENIES a real collision when the digest computation throws', () => {
    // Bug caught: telemetry added to a deny-capable hook disarms it unless every
    // new computation is total. `scopeDigestFields` runs on the decision path of
    // `decide()`, so a throwing digest would propagate to `main().catch`, which
    // ALLOWS on any throw (matrix row 12) — a silent fail-open on the one case
    // this hook exists for. Mirrors the event-write fault test in
    // `pre-task-scope-disjoint.test.mjs`.
    const files = ['scripts/foo.mjs'];
    const verdict = decide({
      input: { tool_name: 'Agent', tool_input: { description: 'Agent B', prompt: renderPrompt(files) } },
      ledger: {
        waveKey: 's1|w3|k',
        agents: [{ id: 'Agent A', desc: 'Agent A', files, at: new Date().toISOString() }],
      },
      ledgerCorrupt: false,
      waveKey: 's1|w3|k',
      knownFiles: files,
      collide: () => ({ ok: false, collisions: [{ a: 'Agent A', b: 'Agent B', kind: 'exact', evidence: files }], duplicateIds: [] }),
      isFinished: () => false,
      digestFn: () => { throw new Error('digest exploded'); },
    });

    expect(verdict.action).toBe('deny');
    expect(verdict.reason).toContain('scripts/foo.mjs');
    // The field is what the fault costs — never the verdict.
    expect(Object.hasOwn(verdict.telemetry, 'scope_digest')).toBe(false);
    expect(verdict.telemetry.echo_instruction_present).toBe(true);
  });

  it('echoed-not-injected surfaces an echo whose digest no dispatch claimed', () => {
    // Bug caught: the receive side can carry MORE rows than the send side (one
    // measured session: 23 echoes against 18 injections). Reading that as "18
    // agents were scoped" hides five reports whose dispatch was never observed —
    // the one direction where a missing send-side record is a real finding on a
    // platform whose transport IS observable.
    const project = makeProject();
    const files = ['scripts/lib/gamma.mjs'];
    writeScopeFile(project, 3, 'w3-a3', files);
    const digest = scopeDigest(files);
    appendEvent(project, {
      event: SCOPE_MATERIALIZED_EVENT, wave: 3, agent_count: 1, digest_count: 1, transport_observable: true,
    });
    appendEvent(project, {
      event: SCOPE_ECHO_EVENT, wave: 3, agent_id: 'w3-a3', echoed: true, match: true,
      expected_digest: digest, actual_digest: digest,
    });

    const report = verify(project, 3);
    expect(report.transport).toBe('observable');
    expect(report.echoed).toBe(1);
    expect(report.agents).toEqual([{ agent_id: 'w3-a3', verdict: 'echoed-not-injected', digest }]);
  });

  it('degrades every verdict to echo-only when the wave transport is unobservable', () => {
    // Bug caught: on Codex/Cursor/Pi no PreToolUse `Agent` matcher exists, so
    // the send-side record CANNOT exist. Reporting `injection-missing` there
    // would be an accusation derived from an instrument that is not installed —
    // and it would fire for every agent of every wave on those platforms.
    const project = makeProject();
    writeScopeFile(project, 3, 'w3-a1', ['scripts/lib/alpha.mjs']);
    appendEvent(project, {
      event: SCOPE_MATERIALIZED_EVENT, wave: 3, agent_count: 1, digest_count: 1, transport_observable: false,
    });

    const report = verify(project, 3);
    expect(report.transport).toBe('unobservable');
    expect(report.agents.map((a) => a.verdict)).toEqual(['echo-only']);
    expect(report.by_verdict['injection-missing']).toBeUndefined();
  });
});
