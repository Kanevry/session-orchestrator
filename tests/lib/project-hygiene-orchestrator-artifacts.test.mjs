/**
 * tests/lib/project-hygiene-orchestrator-artifacts.test.mjs
 *
 * NAMED BUG (2026-09-06 Wave 1): `checkIgnoredBallast` counted the
 * `.orchestrator/` files the SessionStart hook had just written as "neither
 * tracked nor ignored". A fresh consumer repo's very FIRST banner therefore
 * accused the operator of 5 stray files that the tool itself had created
 * seconds earlier (measured: `find <consumer>/.orchestrator -type f` returned
 * exactly the 5 reported files).
 *
 * Fixture is a synthetic git repo, never the live repo — a test that measures
 * the working repo pins its defect state instead of the behaviour.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkIgnoredBallast } from '@lib/project-hygiene.mjs';

const dirs = [];
afterEach(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  dirs.length = 0;
});

/** A fresh git repo with one committed file, so `git status` has a baseline. */
function freshRepo() {
  const root = mkdtempSync(join(tmpdir(), 'project-hygiene-orch-'));
  dirs.push(root);
  const g = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  g('init', '-q');
  g('config', 'user.email', 'test@example.invalid');
  g('config', 'user.name', 'Test');
  g('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), '# fixture\n', 'utf8');
  g('add', 'README.md');
  g('commit', '-q', '-m', 'init');
  return root;
}

/** Exactly what a first SessionStart writes: untracked state under .orchestrator/. */
function writeOrchestratorState(root) {
  mkdirSync(join(root, '.orchestrator', 'metrics'), { recursive: true });
  const files = [
    '.orchestrator/current-session.json',
    '.orchestrator/wave-scope.json',
    '.orchestrator/metrics/events.jsonl',
    '.orchestrator/metrics/sessions.jsonl',
    '.orchestrator/STATE.md',
  ];
  for (const f of files) writeFileSync(join(root, f), '{}\n', 'utf8');
  return files;
}

function untrackedFinding(findings) {
  return findings.find((f) => f.check === 'untracked-unignored') ?? null;
}

describe('checkIgnoredBallast — the plugin does not accuse itself', () => {
  it('reports 0 untracked-unignored findings for a fresh repo carrying only .orchestrator/ state', () => {
    const root = freshRepo();
    const written = writeOrchestratorState(root);
    expect(written).toHaveLength(5);

    const findings = checkIgnoredBallast(root);
    expect(untrackedFinding(findings)).toBeNull();
  });

  it('still reports a genuine stray OUTSIDE .orchestrator/ — the check is not weakened', () => {
    const root = freshRepo();
    writeOrchestratorState(root);
    writeFileSync(join(root, 'stray-notes.md'), 'nothing decides about me\n', 'utf8');

    const finding = untrackedFinding(checkIgnoredBallast(root));
    expect(finding).not.toBeNull();
    // Exactly ONE — the stray, none of the 5 .orchestrator/ files.
    expect(finding.message).toMatch(/^1 file\(s\) are neither tracked nor ignored/);
  });

  it('counts an .orchestrator-PREFIXED sibling path, which is not the tool\'s own dir', () => {
    const root = freshRepo();
    writeFileSync(join(root, '.orchestrator-notes.md'), 'not the runtime dir\n', 'utf8');

    const finding = untrackedFinding(checkIgnoredBallast(root));
    expect(finding).not.toBeNull();
    expect(finding.message).toMatch(/^1 file\(s\)/);
  });
});
