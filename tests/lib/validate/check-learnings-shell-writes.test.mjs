/**
 * Tests for scripts/lib/validate/check-learnings-shell-writes.mjs (GitHub #69 /
 * GitLab #1446) — the blocking gate against instruction prose that tells an
 * agent to write learnings.jsonl with a shell `>` / `>>` / `tee`.
 *
 * Fixture trees are throwaway (non-git) dirs. The live corpus is NOT scanned
 * here: validate-plugin runs this checker as vitest's globalSetup, so a live
 * finding already fails every run.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { scanLearningsShellWrites } from '../../../scripts/lib/validate/check-learnings-shell-writes.mjs';
import { makeTmpDir, removeTree } from '../../_helpers/tmp-fixture.mjs';

const checkScript = path.join(process.cwd(), 'scripts/lib/validate/check-learnings-shell-writes.mjs');

const roots = [];
afterEach(() => {
  for (const r of roots.splice(0)) removeTree(r);
});

/** A plugin root holding one instruction file `rel` whose content is `body`. */
function makeRoot(body, rel = 'skills/demo/SKILL.md') {
  const root = makeTmpDir('learnings-shell-writes-');
  roots.push(root);
  mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
  writeFileSync(path.join(root, rel), body);
  return root;
}

/** Scan a one-file plugin root whose skill doc is `body`. */
function scanDoc(body, rel) {
  return scanLearningsShellWrites({ pluginRoot: makeRoot(body, rel) });
}

describe('scanLearningsShellWrites', () => {
  it.each([
    ['R2', 'Then write the result back with `>` to `.orchestrator/metrics/learnings.jsonl`.'],
    ['R1', 'cat x > "$ROOT/.orchestrator/metrics/learnings.jsonl"'],
    ['R1', 'echo "$LINE" >> learnings.jsonl'],
    ['R3', 'jq -c . x | tee -a .orchestrator/metrics/learnings.jsonl'],
    // A prohibition in an EARLIER sentence, or AFTER the operator, is not one.
    ['R1', 'Never skip review. Then run: cat new >> .orchestrator/metrics/learnings.jsonl'],
    ['R1', 'jq . next > learnings.jsonl # never run this twice'],
  ])('flags %s: %s', (rule, line) => {
    const res = scanDoc(`# Demo\n\n${line}\n`);
    expect(res.ok).toBe(false);
    expect(res.findings).toEqual([{ file: 'skills/demo/SKILL.md', line: 3, rule, text: line }]);
  });

  it('flags a backticked operator up to 3 lines from the mention (the window), not 4', () => {
    const near = scanDoc('Read `learnings.jsonl` into memory.\n\n\nRewrite it with `>`.\n');
    expect(near.findings).toMatchObject([{ line: 4, rule: 'R2' }]);
    const far = scanDoc('Read `learnings.jsonl` into memory.\n\n\n\nRewrite it with `>`.\n');
    expect(far.findings).toEqual([]);
  });

  it('flags the three ebf63bd1 `.cursor/rules/060-evolve.mdc` sites, none of which names learnings.jsonl', () => {
    const body = [
      '1. Read ALL existing lines from `learnings.jsonl` into memory',
      '2. Apply confidence updates',
      '3. Apply confidence decrements',
      '4. Append new learnings with confidence 0.5',
      '5. Prune expired entries',
      '6. Consolidate duplicates',
      '7. Write entire result back with `>` (atomic rewrite, NOT append `>>`)',
      '',
      '### Step 3: Apply Changes',
      '',
      'Same atomic rewrite strategy as analyze mode. Read all, modify selected, prune, consolidate, write all with `>`.',
      '',
      '## Critical Rules',
      '',
      '- ALWAYS use atomic rewrite (read all, modify, write all with `>`)',
      '',
    ].join('\n');
    const res = scanDoc(body, '.cursor/rules/x.mdc');
    expect(res.findings.map((f) => [f.file, f.line, f.rule])).toEqual([
      ['.cursor/rules/x.mdc', 7, 'R2'],
      ['.cursor/rules/x.mdc', 11, 'R2'],
      ['.cursor/rules/x.mdc', 15, 'R2'],
    ]);
  });

  it.each([
    ['a prohibition on the line', 'NEVER write learnings.jsonl with `>` — use the CLI.'],
    ['a prohibition before the operator', 'NEVER run: cat new >> learnings.jsonl'],
    ['a prohibition on the line above', 'Do not do this:\ncat x > learnings.jsonl'],
    ['an empty-file create', ': > "$F/learnings.jsonl"'],
    ['the marker on the line', 'cat x > learnings.jsonl <!-- learnings-write-check: prohibition -->'],
  ])('exempts %s', (_label, body) => {
    const res = scanDoc(`${body}\n`);
    expect(res.findings).toEqual([]);
    expect(res.summary.exempt).toBe(1);
  });

  it.each([
    ['a `<state-dir>/metrics/learnings.jsonl` mention', 'Read <state-dir>/metrics/learnings.jsonl before planning.'],
    ['a Markdown blockquote', '> `learnings.jsonl` is gitignored, so a bad write has no VCS restore.'],
    ['a quoted former wording', 'This replaced step 4g "atomic rewrite with `>`" in `learnings.jsonl` prose.'],
  ])('passes %s', (_label, line) => {
    const res = scanDoc(`${line}\n`);
    expect(res).toMatchObject({ ok: true, findings: [], summary: { mentions: 1, exempt: 0 } });
  });
});

describe('check-learnings-shell-writes CLI', () => {
  // The contract validate-plugin's runCheck() consumes: exit status plus
  // two-space-indented `  FAIL:` lines and one `Results:` tally.
  it('exits 1 with one FAIL line and `Results: 0 passed, 1 failed` on a fixture with one shell write', () => {
    const root = makeRoot('# Demo\n\necho "$LINE" >> learnings.jsonl\n');
    const result = spawnSync(process.execPath, [checkScript, root], { encoding: 'utf8', timeout: 60_000 });
    expect(result.status).toBe(1);
    expect(result.stdout.match(/^ {2}FAIL:/gm)).toHaveLength(1);
    expect(result.stdout).toContain('Results: 0 passed, 1 failed');

    const json = spawnSync(process.execPath, [checkScript, root, '--json'], { encoding: 'utf8', timeout: 60_000 });
    expect(json.status).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, findings: [{ rule: 'R1', line: 3 }] });
  });
});
