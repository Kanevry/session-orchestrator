/**
 * tests/skills/wave-loop-scope-marker.test.mjs
 *
 * Pins the SCOPE_MARKER contract between the two halves of the #1020 chain:
 * `skills/wave-executor/wave-loop.md` § Pre-Dispatch: File-Scope Injection
 * documents the block a coordinator prepends to a dispatch prompt, and
 * `hooks/pre-task-scope-disjoint.mjs` extracts the scope back out of it.
 *
 * This is NOT a prose pin (test-value.md TV-002c). Nothing here asserts that a
 * sentence exists in a markdown file: the documented block is EXTRACTED from
 * the skill body, rendered with real paths, and fed through the REAL hook
 * binary. The verdict — a deny naming the witness path — is only reachable if
 * the hook's extractor recognised the documented marker. Two hardcoded strings
 * compared to each other would have been a third copy of the contract; this
 * runs one side against the other.
 *
 * Bug caught: the marker headline in the skill body drifts (a reword, a
 * translation, a heading-style change) while the hook's `SCOPE_MARKER` regex
 * stays put. `extractScopeFromPrompt` then returns `[]`, which the hook's
 * error-class matrix resolves to ALLOW — so the whole guard degrades to
 * pre-#1020 behaviour with no error, no warning, and a green suite. 71.4% of
 * measured dispatch prompts carry no marker at all, so the base rate cannot
 * tell "correctly no scope" from "drifted marker".
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { expectDeny, expectAllow } from '../_helpers/hook-decision.mjs';

const REPO_ROOT = process.cwd();
const HOOK = path.join(REPO_ROOT, 'hooks', 'pre-task-scope-disjoint.mjs');
const WAVE_LOOP = path.join(REPO_ROOT, 'skills', 'wave-executor', 'wave-loop.md');

/** Structural anchor for the section that owns the marker. Not the marker itself. */
const SECTION_ANCHOR = 'File-Scope Injection (#1020)';

/**
 * Lift the documented injection block out of the skill body.
 *
 * The block is a 4-space-indented markdown literal inside the #1020 section:
 * a marker headline followed by a fenced block. Both sides are returned
 * dedented, exactly as a coordinator would paste them into a prompt.
 *
 * @returns {string} the documented block, dedented
 */
function documentedInjectionBlock() {
  const body = readFileSync(WAVE_LOOP, 'utf8');
  const start = body.indexOf(SECTION_ANCHOR);
  if (start === -1) throw new Error(`wave-loop.md no longer contains a "${SECTION_ANCHOR}" section`);
  const rest = body.slice(start);
  const end = rest.indexOf('\n#### ', 1);
  const section = end === -1 ? rest : rest.slice(0, end);

  const lines = section.split('\n');
  const first = lines.findIndex((l) => /^ {4}\S/.test(l));
  if (first === -1) throw new Error('the #1020 section documents no indented injection block');
  const block = [];
  for (let i = first; i < lines.length && /^ {4}/.test(lines[i]); i += 1) {
    block.push(lines[i].slice(4));
  }
  const text = block.join('\n');
  if (!text.includes('```')) throw new Error(`documented block carries no fence:\n${text}`);
  return text;
}

/**
 * Render the documented block with real paths in place of its placeholder line,
 * wrapped in the surrounding prose a real dispatch prompt carries.
 *
 * @param {string} block documented block from {@link documentedInjectionBlock}
 * @param {string[]} files paths to inject
 * @param {{ dropMarkerLine?: boolean }} [opts]
 * @returns {string}
 */
function renderPrompt(block, files, opts = {}) {
  const lines = block.split('\n');
  const placeholder = lines.findIndex((l) => /^<.*>$/.test(l.trim()));
  if (placeholder === -1) throw new Error(`documented block has no placeholder line:\n${block}`);
  const rendered = [
    ...lines.slice(0, placeholder),
    ...files,
    ...lines.slice(placeholder + 1),
  ];
  // Negative control: drop everything above the fence, keeping the paths.
  const emitted = opts.dropMarkerLine
    ? rendered.slice(rendered.findIndex((l) => l.startsWith('```')))
    : rendered;
  return `Du bist W9-X. Repo: /tmp/demo.\n\n${emitted.join('\n')}\n\nMach die Arbeit.`;
}

/** Run the real hook binary with a PreToolUse dispatch payload on stdin. */
function dispatch(cwd, id, prompt) {
  const payload = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    session_id: 'scope-marker-contract',
    cwd,
    tool_input: { description: id, model: 'opus', prompt, subagent_type: 'code-implementer' },
  });
  return spawnSync(process.execPath, [HOOK], {
    input: payload, encoding: 'utf8', cwd: REPO_ROOT, timeout: 20_000,
  });
}

/** Disposable project dir holding the hook's dispatch ledger. */
function makeProjectDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wlsm-'));
  mkdirSync(path.join(dir, '.orchestrator'), { recursive: true });
  return dir;
}

const WITNESS = 'skills/wave-executor/wave-loop.md';

describe('wave-loop.md ↔ pre-task-scope-disjoint.mjs — SCOPE_MARKER contract (#1020)', () => {
  it('the hook extracts a scope from the block wave-loop.md documents — proven by a collision DENY', () => {
    // Drift proof: if the documented marker stops matching the hook's
    // SCOPE_MARKER, both dispatches extract `[]`, no collision is computable,
    // and the second dispatch is ALLOWED — this test goes red on exactly the
    // silent degradation the chain cannot otherwise detect.
    const block = documentedInjectionBlock();
    const dir = makeProjectDir();

    expectAllow(dispatch(dir, 'Agent A', renderPrompt(block, [WITNESS, 'scripts/lib/io.mjs'])));
    const denied = dispatch(dir, 'Agent B', renderPrompt(block, [WITNESS]));

    expectDeny(denied, ['Agent B', 'Agent A', WITNESS]);
  });

  it('the marker HEADLINE is what makes it extractable — the fenced paths alone are not', () => {
    // Without this, the test above would also pass for a wave-loop.md whose
    // marker line had been deleted entirely: it would then be pinning the
    // fence, not the marker contract.
    const block = documentedInjectionBlock();
    const dir = makeProjectDir();
    const opts = { dropMarkerLine: true };

    expectAllow(dispatch(dir, 'Agent A', renderPrompt(block, [WITNESS], opts)));
    expectAllow(dispatch(dir, 'Agent B', renderPrompt(block, [WITNESS], opts)));
  });

  it('the documented block renders one path per line inside the first fence', () => {
    // Shape guard for the two tests above: if the block ever documented a
    // comma-joined list or an unfenced list, the hook would extract nothing and
    // the deny above would vanish for a reason unrelated to the marker.
    const rendered = renderPrompt(documentedInjectionBlock(), ['a/b.mjs', 'c/d.mjs']);
    const fenceBody = /```[^\n]*\n([\s\S]*?)```/.exec(rendered)?.[1] ?? '';
    expect(fenceBody.split('\n').filter((l) => l.trim() !== '')).toEqual(['a/b.mjs', 'c/d.mjs']);
  });
});
