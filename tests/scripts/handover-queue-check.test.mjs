/**
 * tests/scripts/handover-queue-check.test.mjs — #1639: every open point of a
 * fleet handover carries a queue mark; unmarked ones are filed via the
 * coordinator CLI (stubbed here) and marked in the file.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { homeEnv } from '../_helpers/home-env.mjs';
import { findOpenPoints, refFor, unmarkedPoints } from '../../scripts/lib/handover-queue-marks.mjs';

const SCRIPT = resolve(process.cwd(), 'scripts/handover-queue-check.mjs');

// Stub coordinator CLI: logs its argv as one JSON line, answers like
// `owner-queue add --json` (exit 0 → {id}, exit 4 → {ids}).
const STUB = `
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.STUB_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const exit = Number(process.env.STUB_EXIT ?? 0);
process.stdout.write(exit === 4 ? JSON.stringify({ error: 'dup', code: 4, ids: [77] }) : JSON.stringify({ id: 42 }));
process.exit(exit);
`;

const HANDOVER = [
  '# Übergabe x',
  '',
  '## Nachkontrolle',
  '- main-Pipeline auf !169 prüfen queue:#2002',
  '- Issue zu? issue:#1638',
  '',
  '## Offen',
  '- Konsumenten-Regeln brauchen paths:',
  '  (29 Regeln in 6 Repos)',
  '',
].join('\n');

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hqc-'));
  writeFileSync(join(dir, 'stub.js'), STUB);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args, { fleet = true, stubExit = 0 } = {}) {
  const env = { ...process.env, ...homeEnv(dir), STUB_LOG: join(dir, 'calls.log'), STUB_EXIT: String(stubExit) };
  delete env.NAVIGATOR_CONFIG_DIR;
  if (fleet) env.NAVIGATOR_CONFIG_DIR = join(dir, 'nav');
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8', timeout: 15_000 });
  const calls = existsSync(env.STUB_LOG)
    ? readFileSync(env.STUB_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    : [];
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, calls };
}

const applyArgs = (file, name = 'x') => [
  '--file', file, '--name', name, '--apply', '--repo', 'session-orchestrator', '--navigator-cli', join(dir, 'stub.js'),
];

describe('handover-queue-check (#1639)', () => {
  it('3 points, 1 unmarked: check names it (exit 3); --apply files exactly 1 item and writes its id', () => {
    const file = join(dir, 'uebergabe-x.md');
    writeFileSync(file, HANDOVER);

    const check = run(['--file', file]);
    expect(check.code).toBe(3);
    expect(check.stdout).toContain('1 Punkt(e) ohne Queue-ID');
    expect(check.calls).toHaveLength(0);

    const apply = run(applyArgs(file));
    expect(apply.code).toBe(0);
    expect(apply.calls).toHaveLength(1);
    expect(apply.calls[0]).toEqual(expect.arrayContaining(['--kind', 'lead-todo', '--waits-on', 'lead']));
    expect(readFileSync(file, 'utf8')).toContain('- Konsumenten-Regeln brauchen paths: queue:#42\n  (29 Regeln');
  });

  it('a fully marked handover files nothing (no duplicates)', () => {
    const file = join(dir, 'x-zug-a.md');
    writeFileSync(file, HANDOVER.replace('paths:', 'paths: queue:#9'));

    const r = run(applyArgs(file));

    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(0);
  });

  it('exit 4 from owner-queue (similar open item) adopts the existing id', () => {
    const file = join(dir, 'uebergabe-x.md');
    writeFileSync(file, HANDOVER);

    const r = run(applyArgs(file), { stubExit: 4 });

    expect(r.code).toBe(0);
    expect(readFileSync(file, 'utf8')).toContain('paths: queue:#77');
  });

  it('a Nachkontrolle point is filed as nachsorge with the MR as --ref', () => {
    const file = join(dir, 'uebergabe-x.md');
    writeFileSync(file, '## Nachkontrolle\n- main-Pipeline auf !169 prüfen\n');

    const r = run(applyArgs(file));

    expect(r.calls[0]).toEqual(expect.arrayContaining(['--kind', 'nachsorge', '--ref', 'session-orchestrator!169']));
  });

  it('a failing CLI leaves the point unmarked and exits 3', () => {
    const file = join(dir, 'uebergabe-x.md');
    writeFileSync(file, HANDOVER);

    const r = run(applyArgs(file), { stubExit: 1 });

    expect(r.code).toBe(3);
    expect(readFileSync(file, 'utf8')).toBe(HANDOVER);
  });

  it('without fleet integration nothing is checked or filed', () => {
    const file = join(dir, 'uebergabe-x.md');
    writeFileSync(file, HANDOVER);

    const r = run(applyArgs(file), { fleet: false });

    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(0);
    expect(readFileSync(file, 'utf8')).toBe(HANDOVER);
  });

  it('--fleet-dir picks the newest own file since the session start; a predecessor of the same name and foreign sessions are ignored', () => {
    const start = Date.now() - 60_000;
    writeFileSync(join(dir, 'uebergabe-other.md'), HANDOVER);
    writeFileSync(join(dir, 'uebergabe-x.md'), HANDOVER); // same name, written days ago
    utimesSync(join(dir, 'uebergabe-x.md'), new Date(start - 86_400_000), new Date(start - 86_400_000));
    const args = ['--name', 'x', '--fleet-dir', dir, '--since', String(start)];

    expect(run(args).code).toBe(0);
    writeFileSync(join(dir, 'x-zug-z.md'), HANDOVER);
    expect(run(args).code).toBe(3);
  });

  it('an owner-decision section is reported, never filed; lead work that only names the owner(-queue) is filed', () => {
    const file = join(dir, 'uebergabe-x.md');
    writeFileSync(
      file,
      '## Offene Owner-Entscheide\n- Release heute?\n## Offen beim Owner\n- Konto?\n'
        + '## Offen (owner-queue, wartet auf Lead)\n- a\n## Danach: Owner-Direktive 14.10.\n- b\n',
    );

    const r = run([...applyArgs(file), '--json']);

    expect(r.code).toBe(3);
    expect(r.calls).toHaveLength(2);
    expect(JSON.parse(r.stdout).failed.map((f) => f.line)).toEqual([2, 4]);
  });

  // #1647: a fleet-wide loop over --file filed 65 items and wrote 89 marks
  // into 17 foreign handovers; --apply must refuse a file that is not own.
  it('--apply on a foreign session\'s file exits 4, files nothing and leaves the file byte-identical (#1647)', () => {
    const file = join(dir, 'uebergabe-other.md');
    writeFileSync(file, HANDOVER);

    const r = run(applyArgs(file, 'x'));

    expect(r.code).toBe(4);
    expect(r.stderr).toContain('uebergabe-other.md');
    expect(r.calls).toHaveLength(0);
    expect(readFileSync(file, 'utf8')).toBe(HANDOVER);
  });

  // #1647 review: an own-pattern NAME is not enough. A symlink writes through to
  // a foreign target; a same-named file older than --since is a predecessor's.
  it.each([
    ['a symlink to a foreign handover', (own, foreign) => symlinkSync(foreign, own), []],
    ['a predecessor file older than --since', (own) => {
      writeFileSync(own, HANDOVER);
      utimesSync(own, new Date('2026-10-15T08:00:00Z'), new Date('2026-10-15T08:00:00Z'));
    }, ['--since', '2026-10-16T00:00:00Z']],
  ])('--apply refuses %s with exit 4 and writes nothing (#1647)', (_label, make, extra) => {
    const foreign = join(dir, 'uebergabe-other.md');
    writeFileSync(foreign, HANDOVER);
    const own = join(dir, 'uebergabe-x.md');
    make(own, foreign);

    const r = run([...applyArgs(own), ...extra]);

    expect(r.code).toBe(4);
    expect(r.calls).toHaveLength(0);
    expect(readFileSync(foreign, 'utf8')).toBe(HANDOVER);
    expect(readFileSync(own, 'utf8')).toBe(HANDOVER);
  });

  // #1647: without --name the queue title fell back to the foreign file's basename.
  it('--apply without --name is a usage error (exit 2) and files nothing (#1647)', () => {
    const file = join(dir, 'uebergabe-x.md');
    writeFileSync(file, HANDOVER);

    const r = run(['--file', file, '--apply', '--repo', 'session-orchestrator', '--navigator-cli', join(dir, 'stub.js')]);

    expect(r.code).toBe(2);
    expect(r.calls).toHaveLength(0);
    expect(readFileSync(file, 'utf8')).toBe(HANDOVER);
  });

  // #1794: info lines under Nachkontrolle were filed as queue items.
  // #1794 review: a label made any line info, so `**MR:** !44 — still need to
  // rebase` was reported as a hint and its action never reached the queue.
  it('an info line is a hint, never filed; a labelled line with an action is still filed (fail-closed)', () => {
    const file = join(dir, 'uebergabe-x.md');
    writeFileSync(
      file,
      '## Nachkontrolle\n- **MR:** !44, Kopf abc1234\n- Pipeline 31234 grün\n- Pipeline 31234 grün, danach Tag prüfen\n- **MR:** !44 — still need to rebase\n',
    );

    const r = run([...applyArgs(file), '--json']);
    const out = JSON.parse(r.stdout.trim());

    expect(r.calls).toHaveLength(2);
    expect(out.filed).toEqual([
      { line: 4, id: 42 },
      { line: 5, id: 42 },
    ]);
    expect(out.info.map((i) => i.line)).toEqual([2, 3]);
    expect(r.code).toBe(3);
    expect(readFileSync(file, 'utf8')).toBe(
      '## Nachkontrolle\n- **MR:** !44, Kopf abc1234\n- Pipeline 31234 grün\n- Pipeline 31234 grün, danach Tag prüfen queue:#42\n- **MR:** !44 — still need to rebase queue:#42\n',
    );
  });

  // #1794: a queue mark in the heading did not cover its block — every point got its own item.
  // #1794 review: the mark also covered child headings, so `## Offen queue:#1`
  // silently marked unrelated actions under its `###` subsections.
  it('a queue mark in the heading covers only the points directly under it, not a child heading', () => {
    const file = join(dir, 'uebergabe-x.md');
    const md = '## Nachkontrolle (queue:#123)\n- Pipeline prüfen\n### Tag\n- Tag prüfen\n## Offen\n- neu\n';
    writeFileSync(file, md);

    const r = run(applyArgs(file));

    expect(r.calls).toHaveLength(2);
    expect(readFileSync(file, 'utf8')).toBe(
      md.replace('- Tag prüfen', '- Tag prüfen queue:#42').replace('- neu', '- neu queue:#42'),
    );
  });

  it('keeps CRLF line endings when it marks a point', () => {
    const file = join(dir, 'uebergabe-x.md');
    writeFileSync(file, '## Offen\r\n- a\r\n- b queue:#1\r\n');

    expect(run(applyArgs(file)).code).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('## Offen\r\n- a queue:#42\r\n- b queue:#1\r\n');
  });
});

describe('findOpenPoints (#1639)', () => {
  it('reads only open-point sections; subsections inherit unless erledigt; erledigt/[x]/~~/code fences do not count', () => {
    const md = [
      '## Erledigt',
      '- done item',
      '## Nachkontrolle (erledigt)',
      '- also done',
      '## Offene Punkte',
      '### Konsumenten',
      '- inherited',
      '- [x] ticked',
      '- [X]no-space',
      '- ~~struck~~',
      '- Erledigt: Migration 231',
      '### Erledigt',
      '- done sub',
      '```',
      '- in a fence',
      '```',
      '## Folgearbeit',
      '1. numbered',
      '# Anhang',
      '- appendix',
    ].join('\n');

    expect(unmarkedPoints(findOpenPoints(md)).map((p) => p.text)).toEqual(['inherited', 'numbered']);
  });

  it('refFor: first !N/#N, last path segment of a group path, null when the CLI would refuse it', () => {
    const pts = findOpenPoints(
      '## Offen\n- check other-repo!12 then #3\n- nothing\n- infrastructure/projects-baseline#672\n- see **#219**\n- MR !0\n',
    );
    expect(pts.map((p) => refFor(p, 'so'))).toEqual(['other-repo!12', null, 'projects-baseline#672', 'so#219', null]);
  });
});
