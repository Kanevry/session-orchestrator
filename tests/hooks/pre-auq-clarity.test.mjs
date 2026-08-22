/**
 * tests/hooks/pre-auq-clarity.test.mjs
 *
 * Contract tests for the runtime `AskUserQuestion` clarity guard.
 *
 * Every `it` below names the concrete bug it catches (TV-001). Decision
 * assertions go exclusively through `expectAllow` / `expectDeny` from
 * `tests/_helpers/hook-decision.mjs`: under the exit-0 PreToolUse protocol
 * (#906) allow AND deny both exit 0, so a bare `expect(status).toBe(0)` is an
 * assert-nothing that stays green in BOTH directions.
 *
 * The fake-regression block at the bottom is the load-bearing one: it restores
 * each named defect in a COPY of the hook and proves the matching test goes RED.
 * A green test alone never proves a guard bites — six tests in this very session
 * stayed green with their named defect installed.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { expectDeny, expectAllow, expectGuardInactive } from '../_helpers/hook-decision.mjs';
import { brokenModuleBoot } from '../_helpers/broken-module-boot.mjs';

const REPO_ROOT = process.cwd();
const HOOK = path.join(REPO_ROOT, 'hooks', 'pre-auq-clarity.mjs');

/**
 * Drive the hook with a raw stdin string. `spawnSync` and not an in-process
 * import on purpose: the decision lives in the process's stdout envelope, and an
 * imported `decide()` would prove nothing about how that envelope is emitted.
 *
 * `CLAUDE_PROJECT_DIR` is pinned to a FRESH tmp dir per call, and that is not
 * tidiness — it is a correctness requirement with a measured incident behind it.
 * The hook appends one telemetry record per decision to
 * `<project-dir>/.orchestrator/metrics/events.jsonl`; `resolveProjectDir` reads
 * that env var first and otherwise walks up from CWD, so with `cwd: REPO_ROOT`
 * and no pin every spawn here lands in the REAL fleet telemetry. Measured
 * 2026-08-22 on the first run after the telemetry landed: 22 synthetic
 * `auq_clarity` records in the live store, each carrying the coordinator's real
 * `session_id` — indistinguishable, after the fact, from denies a live operator
 * actually hit. `eventsFilePath`'s own doc comment warns of exactly this.
 *
 * Per call rather than per file so no test can observe another's records, and so
 * the guard-inactive banner (keyed on project dir) cannot be deduplicated away
 * by a sibling test that happened to run first.
 *
 * @returns {object} spawnSync result, plus `eventsHome` — the pinned project dir.
 */
function runHook(stdin, { hook = HOOK, execArgv = [] } = {}) {
  const eventsHome = mkdtempSync(path.join(os.tmpdir(), 'auq-events-'));
  const result = spawnSync(process.execPath, [...execArgv, hook], {
    input: stdin,
    encoding: 'utf8',
    cwd: REPO_ROOT,
    timeout: 20_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: eventsHome },
  });
  return { ...result, eventsHome };
}

/**
 * Parse the telemetry the hook wrote under a `runHook` result's `eventsHome`.
 * Returns `[]` when the file does not exist — "wrote nothing" is a legitimate
 * outcome to assert, not an error.
 *
 * @param {string} eventsHome
 * @returns {object[]}
 */
function readEvents(eventsHome) {
  const file = path.join(eventsHome, '.orchestrator', 'metrics', 'events.jsonl');
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Build a PreToolUse envelope in the shape MEASURED in the shipped Claude Code
 * bundle (2.1.239): `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`,
 * plus `session_id` / `cwd` / `permission_mode`. The whole `questions` array
 * lives inside `tool_input`.
 */
function envelope(questions, { toolName = 'AskUserQuestion', toolInput } = {}) {
  return JSON.stringify({
    session_id: 'main-2026-08-22-session-3',
    cwd: REPO_ROOT,
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_use_id: 'toolu_01TEST',
    tool_input: toolInput ?? { questions },
  });
}

/** A question that scores clean: 12-char header, 2 options, reason + cost each. */
function cleanQuestion(overrides = {}) {
  return {
    question: 'Wave 4 jetzt fahren oder direkt schliessen?',
    header: 'Wave 4',
    multiSelect: false,
    options: [
      {
        label: 'Wave 4 (Recommended)',
        description: 'Schliesst die Laufzeit-Luecke; ~20 min; friert den Planumfang bis dahin ein.',
      },
      {
        label: 'Direkt schliessen',
        description: 'Spart 20 min, laesst die Laufzeit-Fragen bis zur naechsten Session offen.',
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Scope — the hook must not act outside its own tool
// ---------------------------------------------------------------------------

describe('pre-auq-clarity — scope', () => {
  it('allows a FOREIGN tool name even when its payload would break a hurdle', () => {
    // Bug caught: relying on the hooks.json matcher as the only defence. A
    // matcher typo, a wildcard matcher, or a future harness that fans PreToolUse
    // out more widely would put a Bash/Edit payload through the AUQ scorer —
    // and this payload breaks H1, so a hook without the tool_name check would
    // BLOCK an unrelated tool call.
    const res = runHook(envelope([cleanQuestion({ header: 'Eine viel zu lange Kopfzeile' })], {
      toolName: 'Bash',
    }));
    expectAllow(res);
  });

  it('allows a tool call whose tool_input carries no questions array at all', () => {
    // Bug caught: an unrecognised payload shape read as "zero questions", where
    // zero options per question is itself an H2 break — a deny manufactured by
    // the adapter rather than found in the question.
    expectAllow(runHook(envelope(null, { toolInput: { prompt: 'not an AUQ payload' } })));
  });

  it('allows an empty stdin stream instead of treating it as a call', () => {
    expectAllow(runHook(''));
  });
});

// ---------------------------------------------------------------------------
// Fail direction — every doubt resolves to ALLOW
// ---------------------------------------------------------------------------

describe('pre-auq-clarity — fail direction', () => {
  it('allows (never throws, never denies) on a broken stdin envelope', () => {
    // Bug caught: the hook throws on a malformed envelope. Under the exit-0
    // protocol a throw either exits 1 with an empty stdout (a silent, invisible
    // disarm) or — if the top-level net routes to deny — destroys the
    // operator's question over a harness quirk. Neither may happen.
    const res = runHook('{"tool_name": "AskUserQuestion", "tool_input": {');
    expectAllow(res);
    expect(res.status).toBe(0); // NOT the exit-1 of an uncaught throw
  });

  it('allows a question that carries ONE malformed option beside a valid one', () => {
    // Bug caught: dropping the unusable option leaves ONE option, and "fewer
    // than 2 options" is itself hurdle H2 — so a lenient adapter converts a
    // shape it did not understand into a hard deny. The whole question must be
    // skipped instead.
    const q = cleanQuestion();
    q.options = [q.options[0], 'not an option object'];
    expectAllow(runHook(envelope([q])));
  });

  it('allows a question whose options key is missing entirely', () => {
    const q = cleanQuestion();
    delete q.options;
    expectAllow(runHook(envelope([q])));
  });

  it('fails OPEN and VISIBLY when a repo module cannot be loaded', () => {
    // Bug caught (#992/#993): a broken dependency exits 1 with 0 bytes on
    // stdout, which on the only decision-bearing channel is indistinguishable
    // from an explicit allow — a guard that is off and says nothing. It must
    // still allow (a broken module may not cost the operator's question) AND
    // announce the outage.
    //
    // `schema.mjs` and NOT `clarity.mjs`: the helper matches by
    // `url.endsWith(basename)`, and this hook's own filename —
    // `pre-auq-clarity.mjs` — ends with `clarity.mjs`. Passing that basename
    // corrupts the HOOK ITSELF at link time, which produces a SyntaxError and
    // exit 1 that looks exactly like the fail-silent disarm this test exists to
    // forbid (measured 2026-08-22: `Unexpected token ';'` in
    // pre-auq-clarity.mjs, status 1). The test would have reported a hook defect
    // that is not there.
    const res = runHook(envelope([cleanQuestion()]), {
      execArgv: brokenModuleBoot({ moduleBasename: 'schema.mjs' }),
    });
    expectGuardInactive(res, { hookName: 'pre-auq-clarity' });
  });
});

// ---------------------------------------------------------------------------
// Content criteria are reported, never blocked
// ---------------------------------------------------------------------------

describe('pre-auq-clarity — content criteria never block', () => {
  it('allows a question that fails ONLY content criteria (K4/K7/K8)', () => {
    // Bug caught: blocking on a content criterion. Measured false-positive rate
    // 14–25 % — a hook that blocks one correct question in four is switched off
    // within a month, and takes the hard limits H1/H2 down with it. This
    // question breaks NO hurdle: 8-char header, 2 options, recommendation first.
    const q = {
      question: 'Wie weiter?',
      header: 'Weiter',
      options: [
        // K4: no reason/cost/consequence. K7: an unexplained identifier.
        { label: 'Ja (Recommended)', description: 'Nimm ja.' },
        { label: 'Nein', description: 'Erst .orchestrator/wave-scope.json lesen, dann entscheiden.' },
      ],
    };
    const res = runHook(envelope([q]));
    expectAllow(res);
    // ...and the findings were genuinely MEASURED, not merely absent: the
    // diagnostic names them. Without this half, a scorer that silently found
    // nothing would pass this test identically.
    expect(res.stderr).toContain('Inhaltliche Befunde');
    expect(res.stderr).toContain('NICHT blockiert');
  });

  it('allows an over-long option description — a fail that carries no hurdle', () => {
    // Bug caught: treating every `fail` finding as blocking. K6 also produces
    // fails with no hurdle attached (description > 150 chars, question payload
    // > 650 chars); only the option COUNT and the recommendation POSITION are
    // hurdle H2.
    const q = cleanQuestion();
    q.options[1].description = `${'sehr lange Begruendung mit Grund und Preis, '.repeat(6)}kostet 20 min.`;
    expect(q.options[1].description.length).toBeGreaterThan(150);
    expectAllow(runHook(envelope([q])));
  });
});

// ---------------------------------------------------------------------------
// The two hard limits — the only things that block
// ---------------------------------------------------------------------------

describe('pre-auq-clarity — hard limits block', () => {
  it('denies an over-long header (H1) and names the field, the value and the limit', () => {
    // Bug caught: a deny whose reason is too vague for the second attempt to
    // land — the model rewrites something else, gets denied again, and the
    // operator's question never appears. The reason must carry the addressable
    // JSON path, the measured value and the limit.
    const res = runHook(envelope([cleanQuestion({ header: 'Welche Strategie waehlen wir?' })]));
    const env = expectDeny(res, ['H1', 'questions[0].header', '[gemessen: 29, Grenze: 12]']);

    // The operator-visible headline names WHICH limit broke, not a preamble
    // identical for every deny (`emitDeny` derives it from the first line).
    expect(env.systemMessage).toContain('H1');
  });

  it('denies a five-option question (H2) and names the count and the cap', () => {
    const q = cleanQuestion();
    q.options = ['A (Recommended)', 'B', 'C', 'D', 'E'].map((label) => ({
      label,
      description: `Nimm ${label}, weil es 20 Minuten kostet und den Umfang einfriert.`,
    }));
    expectDeny(runHook(envelope([q])), ['H2', 'questions[0]', '[gemessen: 5, Grenze: 4]']);
  });

  it('denies a recommendation that does not sit first (H2) and names its position', () => {
    // Bug caught: silently accepting a recommendation at position 2. The
    // operator reads from the top and takes the first option as the meant one —
    // so a misplaced marker inverts the advice without anyone noticing.
    const q = cleanQuestion();
    q.options[0].label = 'Wave 4';
    q.options[1].label = 'Direkt schliessen (Recommended)';
    expectDeny(runHook(envelope([q])), ['H2', '[gemessen: 2, Grenze: 1]']);
  });

  it('groups two questions breaking the SAME hurdle under one heading', () => {
    // Bug caught: repeating the H1 heading once per question, which reads as two
    // unrelated rules and buries the fact that it is one problem with two
    // witnesses.
    const res = runHook(envelope([
      cleanQuestion({ header: 'Viel zu lange Kopfzeile A' }),
      cleanQuestion({ header: 'Viel zu lange Kopfzeile B' }),
    ]));
    const env = expectDeny(res, ['questions[0].header', 'questions[1].header']);
    const reason = env.hookSpecificOutput.permissionDecisionReason;
    expect(reason.split('H1 — Kopfzeile')).toHaveLength(2); // exactly ONE heading
  });

  it('allows a clean question — the guard is not a blanket block', () => {
    // The discriminator for every deny above: without it, a hook that denied
    // unconditionally would pass all of them.
    expectAllow(runHook(envelope([cleanQuestion()])));
  });
});

// ---------------------------------------------------------------------------
// Envelope shape — the emitRewrite trap
// ---------------------------------------------------------------------------

describe('pre-auq-clarity — envelope shape', () => {
  it('never puts permissionDecision beside updatedInput', () => {
    // Bug caught: the trap documented on `emitRewrite` in scripts/lib/io.mjs.
    // The shipped binary routes a rewrite only when NO permission decision is
    // present; pairing the two takes a different branch that replaces the input
    // AND SKIPS THE PERMISSION STAGE. For AskUserQuestion the permission stage
    // IS the question card, so that combination routes the question PAST the
    // human — silently, from both ends. This hook emits a decision, therefore it
    // must emit no `updatedInput` at all.
    const res = runHook(envelope([cleanQuestion({ header: 'Welche Strategie waehlen wir?' })]));
    // `expectDeny` already pins the top-level key set to exactly
    // ['hookSpecificOutput','systemMessage']; this adds the nested half, which a
    // key-set check on the OUTER object cannot see.
    const env = expectDeny(res);
    expect(Object.keys(env.hookSpecificOutput).sort())
      .toEqual(['hookEventName', 'permissionDecision', 'permissionDecisionReason']);
    expect(res.stdout).not.toContain('updatedInput');
  });

  it('writes nothing at all to stdout on the allow path', () => {
    // Bug caught: a diagnostic escaping to stdout. Any stray stdout line is
    // parsed as a decision envelope by the harness and by the Pi bridge, where
    // an unparseable `{`-prefixed line fails CLOSED — a debug print would become
    // a block.
    const res = runHook(envelope([cleanQuestion()]));
    expect(res.stdout).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Fake regression — proves each test above actually bites
// ---------------------------------------------------------------------------

describe('pre-auq-clarity — telemetry (the guard must be falsifiable)', () => {
  it('writes an allowed event for a clean question — without it "never fired" and "fired, clean" are the same observation', () => {
    // The bug: someone drops the allow-side emit as redundant ("we only care
    // about denies"). Nothing goes red, and the hook silently becomes
    // unfalsifiable — under ADR-0011 an allow exits 0 and writes no stdout, so
    // from outside the process a hook that never ran looks EXACTLY like a hook
    // that ran and found nothing. That is the state HR-105 exists to forbid, and
    // it is the open question this whole guard was built to answer.
    const run = runHook(envelope([cleanQuestion()]));
    expectAllow(run);

    const events = readEvents(run.eventsHome).filter((e) => e.event.startsWith('orchestrator.auq_clarity.'));
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('orchestrator.auq_clarity.allowed');
    expect(events[0].hurdles).toEqual([]);
    expect(events[0].questions).toBe(1);
  });

  it('records the hurdle that actually broke, not merely that something did', () => {
    // The bug: the payload degrades to a bare {denied: true}. The deny rate
    // stays measurable but becomes un-actionable — H1 (header truncated by the
    // tool) and H2 (too many options to weigh) have different causes and
    // different fixes, and a tally that cannot separate them cannot tell you
    // which one to re-aim.
    const run = runHook(envelope([cleanQuestion({ header: 'Welche Strategie waehlen wir?' })]));
    expectDeny(run);

    const denied = readEvents(run.eventsHome).find((e) => e.event === 'orchestrator.auq_clarity.denied');
    expect(denied.hurdles).toEqual(['H1']);
  });

  it('carries no question text — events.jsonl is read by audits never scoped to hold it', () => {
    // The bug: a later edit adds the offending header to the payload "to make
    // triage easier". The operator's question text is the one thing a clarity
    // guard necessarily sees in full, and this store is swept fleet-wide.
    const secret = 'Zroniankaertigungsschluessel';
    const run = runHook(envelope([cleanQuestion({ header: secret })]));
    expectDeny(run);

    const raw = JSON.stringify(readEvents(run.eventsHome));
    expect(raw).not.toContain(secret);
  });

  it('still denies when the telemetry write fails — measurement never overrides the verdict', () => {
    // The bug: the emit is awaited OUTSIDE a try/catch, or the catch is dropped.
    // A single unwritable metrics path then turns every deny into an allow, and
    // the guard fails open at exactly the moment its logging is broken — the
    // worst possible correlation.
    const run = runHook(envelope([cleanQuestion({ header: 'Welche Strategie waehlen wir?' })]));
    // Re-run against a project dir whose events.jsonl is a DIRECTORY, so the
    // append throws EISDIR inside the hook.
    const home = mkdtempSync(path.join(os.tmpdir(), 'auq-broken-'));
    mkdirSync(path.join(home, '.orchestrator', 'metrics', 'events.jsonl'), { recursive: true });
    const broken = spawnSync(process.execPath, [HOOK], {
      input: envelope([cleanQuestion({ header: 'Welche Strategie waehlen wir?' })]),
      encoding: 'utf8',
      cwd: REPO_ROOT,
      timeout: 20_000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: home },
    });

    expectDeny(run);
    expectDeny(broken); // same verdict, telemetry broken
  });
});

describe('pre-auq-clarity — fake regression (proves the guard bites)', () => {
  /**
   * Copy the hook into $TMPDIR with symlinks back to the real `scripts/` and
   * `hooks/_lib/`, so PLUGIN_ROOT resolution still finds its dependencies. The
   * copy can then be defect-injected without touching the tracked file.
   */
  function stageHookCopy(mutate) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'auqc-fake-'));
    mkdirSync(path.join(root, 'hooks'), { recursive: true });
    symlinkSync(path.join(REPO_ROOT, 'scripts'), path.join(root, 'scripts'), 'dir');
    symlinkSync(path.join(REPO_ROOT, 'hooks', '_lib'), path.join(root, 'hooks', '_lib'), 'dir');
    const src = readFileSync(HOOK, 'utf8');
    const mutated = mutate(src);
    expect(mutated).not.toBe(src); // the injection must actually have landed
    const dest = path.join(root, 'hooks', 'pre-auq-clarity.mjs');
    writeFileSync(dest, mutated);
    return dest;
  }

  it('DEFECT: acting on a foreign tool name — the scope test goes red', () => {
    const broken = stageHookCopy((src) => src
      .replace("  if (input?.tool_name !== AUQ_TOOL) return allow();\n", '')
      .replace("  if (input.tool_name !== AUQ_TOOL) return emitAllow();\n", ''));

    const stdin = envelope([cleanQuestion({ header: 'Eine viel zu lange Kopfzeile' })], {
      toolName: 'Bash',
    });
    const leaked = runHook(stdin, { hook: broken });
    expect(leaked.stdout).toContain('"permissionDecision":"deny"'); // the defect's signature
    expect(() => expectAllow(leaked)).toThrow();

    expectAllow(runHook(stdin)); // ...and the real hook allows
  });

  it('DEFECT: error handling that denies instead of passing through — the stdin test goes red', () => {
    const broken = stageHookCopy((src) => src
      .replace(
        '    return emitAllow();\n  }\n  if (!input) return emitAllow();',
        '    throw err;\n  }\n  if (!input) return emitAllow();',
      )
      .replace('    emitAllow();\n  });', "    emitDeny('interner Hook-Fehler');\n  });"));

    const garbage = '{"tool_name": "AskUserQuestion", "tool_input": {';
    const leaked = runHook(garbage, { hook: broken });
    expect(leaked.stdout).toContain('"permissionDecision":"deny"');
    expect(() => expectAllow(leaked)).toThrow();

    expectAllow(runHook(garbage));
  });

  it('DEFECT: blocking on a content criterion — the K4/K7 allow test goes red', () => {
    const broken = stageHookCopy((src) => src.replace(
      "      if (criteria[f.criterion]?.hurdle) continue;\n"
      + "      softByCriterion.set(f.criterion, (softByCriterion.get(f.criterion) ?? 0) + 1);",
      "      if (!broken.has(f.criterion)) broken.set(f.criterion, { title: 'inhaltlich', perQuestion: [] });\n"
      + "      broken.get(f.criterion).perQuestion.push({ questionNo, lines: [renderFinding(f, questionNo)] });",
    ));

    const stdin = envelope([{
      question: 'Wie weiter?',
      header: 'Weiter',
      options: [
        { label: 'Ja (Recommended)', description: 'Nimm ja.' },
        { label: 'Nein', description: 'Erst .orchestrator/wave-scope.json lesen, dann entscheiden.' },
      ],
    }]);
    const leaked = runHook(stdin, { hook: broken });
    expect(leaked.stdout).toContain('"permissionDecision":"deny"');
    expect(() => expectAllow(leaked)).toThrow();

    expectAllow(runHook(stdin));
  });

  it('DEFECT: a reason that omits field, value and limit — the H1 deny test goes red', () => {
    // Der Injektionspunkt ist mit dem Suffix-Reservierungs-Fix gewandert: seit
    // dieser Session klippt renderFinding nur noch `f.message` und haengt Ort
    // und Messwerte davor/dahinter, weil clipLine von hinten schnitt und damit
    // ausgerechnet `[gemessen/Grenze]` als erstes verlor. Die Mutation trifft
    // jetzt den Rueckgabewert selbst statt der alten Einzeiler-Zeile.
    const broken = stageHookCopy((src) => src.replace(
      '  return `${head}${body}${tail}`;',
      '  return `  • ${body}`;',
    ));

    const stdin = envelope([cleanQuestion({ header: 'Welche Strategie waehlen wir?' })]);
    const vague = runHook(stdin, { hook: broken });
    // Still a deny — the defect is in the REASON, which is exactly why an
    // assertion that only checked "it denied" would stay green here.
    expect(vague.stdout).toContain('"permissionDecision":"deny"');
    expect(() => expectDeny(vague, ['questions[0].header', '[gemessen: 29, Grenze: 12]'])).toThrow();

    expectDeny(runHook(stdin), ['questions[0].header', '[gemessen: 29, Grenze: 12]']);
  });

  it('DEFECT: allow-side telemetry dropped as redundant — the falsifiability test goes red', () => {
    // The most plausible future edit against this guard, because it looks like
    // pure noise reduction: "we only care about denies". It is the one edit that
    // silently restores the unfalsifiable state — allow exits 0 and writes no
    // stdout, so with no allow event nothing distinguishes a hook that never
    // fired from one that fired and found nothing. Proving the test goes RED
    // here is the only thing that makes it a guard rather than decoration.
    const broken = stageHookCopy((src) => src.replace(
      "  if (verdict.telemetry) {\n    await logDecision(verdict.action === 'deny' ? 'denied' : 'allowed', verdict.telemetry, input);\n  }",
      "  if (verdict.telemetry && verdict.action === 'deny') {\n    await logDecision('denied', verdict.telemetry, input);\n  }",
    ));

    const stdin = envelope([cleanQuestion()]);
    const trap = runHook(stdin, { hook: broken });
    expectAllow(trap); // the decision is unchanged — that is what makes it silent
    expect(readEvents(trap.eventsHome).filter((e) => e.event.startsWith('orchestrator.auq_clarity.'))).toHaveLength(0);

    // ...and the real hook, same input, does record it.
    const good = runHook(stdin);
    expect(readEvents(good.eventsHome).map((e) => e.event)).toEqual(['orchestrator.auq_clarity.allowed']);
  });

  it('DEFECT: permissionDecision emitted beside updatedInput — the envelope test goes red', () => {
    const broken = stageHookCopy((src) => src.replace(
      "  if (verdict.action === 'deny') return emitDeny(verdict.reason, verdict.suggestion);",
      "  if (verdict.action === 'deny') {\n"
      + "    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',\n"
      + "      permissionDecision: 'deny', permissionDecisionReason: verdict.reason,\n"
      + "      updatedInput: input.tool_input } }) + '\\n');\n"
      + '    return process.exit(0);\n'
      + '  }',
    ));

    const stdin = envelope([cleanQuestion({ header: 'Welche Strategie waehlen wir?' })]);
    const trap = runHook(stdin, { hook: broken });
    expect(trap.stdout).toContain('updatedInput'); // the defect's signature
    expect(() => expectDeny(trap)).toThrow();

    expect(runHook(stdin).stdout).not.toContain('updatedInput');
  });
});
