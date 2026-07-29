/**
 * tests/lib/description-surface.test.mjs
 *
 * Unit tests for scripts/lib/description-surface.mjs (#878 FA2c). Hermetic
 * tmpdir fixtures only — per .claude/rules/testing.md § "Dynamic Artifact
 * Counts", live-repo totals are NOT pinned here (a sibling wave agent edits
 * docs this same session, and the corpus grows by design).
 */

import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  openSync,
  closeSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseFrontmatterDescription,
  naiveDescriptionLength,
  measureDescriptionSurface,
  DEFAULT_OUTLIER_TOP_N,
} from '@lib/description-surface.mjs';

const CLI = fileURLToPath(new URL('../../scripts/lib/description-surface.mjs', import.meta.url));

const tmpDirs = [];

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'description-surface-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

/** Builds a minimal repo skeleton: agents/*.md, skills/<name>/SKILL.md, commands/*.md. */
function makeRepoSkeleton(root) {
  mkdirSync(join(root, 'agents'), { recursive: true });
  mkdirSync(join(root, 'skills'), { recursive: true });
  mkdirSync(join(root, 'commands'), { recursive: true });
}

function writeAgent(root, name, content) {
  writeFileSync(join(root, 'agents', `${name}.md`), content, 'utf8');
}

function writeSkill(root, name, content) {
  const dir = join(root, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf8');
}

function writeCommand(root, name, content) {
  writeFileSync(join(root, 'commands', `${name}.md`), content, 'utf8');
}

// ---------------------------------------------------------------------------
// parseFrontmatterDescription — inline description
// ---------------------------------------------------------------------------

describe('parseFrontmatterDescription — inline description', () => {
  it('extracts a plain inline description value', () => {
    const content = '---\nname: foo\ndescription: A short inline description.\n---\n\nBody.\n';

    const result = parseFrontmatterDescription(content);

    expect(result).toEqual({
      raw: 'A short inline description.',
      isBlockScalar: false,
      style: null,
      chomping: null,
    });
  });

  it('strips a single layer of matching double quotes', () => {
    const content = '---\ndescription: "Quoted description."\n---\nBody.\n';

    const result = parseFrontmatterDescription(content);

    expect(result.raw).toBe('Quoted description.');
  });
});

// ---------------------------------------------------------------------------
// parseFrontmatterDescription — block scalar '>' (folded)
// ---------------------------------------------------------------------------

describe('parseFrontmatterDescription — block scalar >', () => {
  it('folds indented continuation lines into the real description text', () => {
    const content = [
      '---',
      'name: foo',
      'description: >',
      '  Use this skill when the user wants X, Y, or Z. It dispatches an',
      '  agent to do the work.',
      '---',
      '',
      'Body.',
      '',
    ].join('\n');

    const result = parseFrontmatterDescription(content);

    expect(result.isBlockScalar).toBe(true);
    expect(result.style).toBe('>');
    // Folded style joins non-blank lines with a single space (YAML folded semantics).
    expect(result.raw).toBe(
      'Use this skill when the user wants X, Y, or Z. It dispatches an agent to do the work.\n',
    );
  });

  it('never counts a block-scalar description as empty', () => {
    const content = ['---', 'description: >', '  Non-trivial content here.', '---', ''].join('\n');

    const result = parseFrontmatterDescription(content);

    expect(result.raw.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// parseFrontmatterDescription — block scalar '|' (literal)
// ---------------------------------------------------------------------------

describe('parseFrontmatterDescription — block scalar |', () => {
  it('preserves line breaks for literal-style block scalars', () => {
    const content = ['---', 'description: |', '  Line one.', '  Line two.', '---', ''].join('\n');

    const result = parseFrontmatterDescription(content);

    expect(result.isBlockScalar).toBe(true);
    expect(result.style).toBe('|');
    expect(result.raw).toBe('Line one.\nLine two.\n');
  });
});

// ---------------------------------------------------------------------------
// parseFrontmatterDescription — indented `---` inside a block scalar body
// (defect: the closing-fence scan used `.trim()`, so an indented `---` INSIDE
// the block scalar's own body was mistaken for the closing frontmatter fence,
// silently truncating the description and hiding every frontmatter key after it)
// ---------------------------------------------------------------------------

describe('parseFrontmatterDescription — indented "---" inside a block scalar', () => {
  it('does not terminate frontmatter parsing on an indented "---" that is part of the block body', () => {
    const content = [
      '---',
      'description: |',
      '  Line one',
      '  ---',
      '  Line three',
      '---',
      '',
    ].join('\n');

    const result = parseFrontmatterDescription(content);

    expect(result.isBlockScalar).toBe(true);
    // The indented '---' is literal block content, not a fence — all three
    // body lines must survive the fold.
    expect(result.raw).toBe('Line one\n---\nLine three\n');
  });
});

// ---------------------------------------------------------------------------
// parseFrontmatterDescription — chomping variants
// ---------------------------------------------------------------------------

describe('parseFrontmatterDescription — chomping variants', () => {
  it('strip (>-) omits the trailing newline', () => {
    const content = ['---', 'description: >-', '  Folded strip content.', '---', ''].join('\n');

    const result = parseFrontmatterDescription(content);

    expect(result.chomping).toBe('-');
    expect(result.raw).toBe('Folded strip content.');
    expect(result.raw.endsWith('\n')).toBe(false);
  });

  it('strip (|-) omits the trailing newline for literal style', () => {
    const content = ['---', 'description: |-', '  Literal strip content.', '---', ''].join('\n');

    const result = parseFrontmatterDescription(content);

    expect(result.chomping).toBe('-');
    expect(result.raw).toBe('Literal strip content.');
  });

  it('keep (>+) preserves trailing blank lines', () => {
    const content = ['---', 'description: >+', '  Folded keep content.', '', '', '---', ''].join(
      '\n',
    );

    const result = parseFrontmatterDescription(content);

    expect(result.chomping).toBe('+');
    expect(result.raw.length).toBeGreaterThan('Folded keep content.'.length);
  });

  it('keep (|+) preserves trailing blank lines for literal style', () => {
    const content = ['---', 'description: |+', '  Literal keep content.', '', '', '---', ''].join(
      '\n',
    );

    const result = parseFrontmatterDescription(content);

    expect(result.chomping).toBe('+');
    expect(result.raw.length).toBeGreaterThan('Literal keep content.'.length);
  });
});

// ---------------------------------------------------------------------------
// parseFrontmatterDescription — missing description / no frontmatter
// ---------------------------------------------------------------------------

describe('parseFrontmatterDescription — missing description', () => {
  it('returns null when frontmatter has no description key', () => {
    const content = '---\nname: foo\ntags: [a, b]\n---\n\nBody.\n';

    expect(parseFrontmatterDescription(content)).toBeNull();
  });

  it('returns null when there is no leading frontmatter at all', () => {
    const content = '# Just a heading\n\nNo frontmatter here.\n';

    expect(parseFrontmatterDescription(content)).toBeNull();
  });

  it('returns null when the frontmatter fence never closes', () => {
    const content = '---\nname: foo\ndescription: orphaned\n\n# Body without closing fence\n';

    expect(parseFrontmatterDescription(content)).toBeNull();
  });

  it('does not mistake a nested description field (e.g. under args-schema) for the top-level key', () => {
    const content = [
      '---',
      'name: foo',
      'args-schema:',
      '  - flag: --bar',
      '    description: "nested, not top-level"',
      '---',
      '',
    ].join('\n');

    expect(parseFrontmatterDescription(content)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// naiveDescriptionLength — the bug this module exists to avoid
// ---------------------------------------------------------------------------

describe('naiveDescriptionLength', () => {
  it('undercounts a block-scalar description to just the indicator', () => {
    const content = [
      '---',
      'description: >',
      '  A much longer real description body here.',
      '---',
      '',
    ].join('\n');

    expect(naiveDescriptionLength(content)).toBe(1); // just the '>' character
  });

  it('matches the real length for an inline description', () => {
    const content = '---\ndescription: Twenty char value.\n---\n';

    expect(naiveDescriptionLength(content)).toBe(18); // "Twenty char value." — hardcoded literal
  });
});

// ---------------------------------------------------------------------------
// measureDescriptionSurface — end-to-end over a fixture repo
// ---------------------------------------------------------------------------

describe('measureDescriptionSurface — end-to-end fixture repo', () => {
  it('reports per-file, per-surface, and total figures with the correct total larger than the naive total', () => {
    const root = tmp();
    makeRepoSkeleton(root);

    writeAgent(
      root,
      'small-agent',
      '---\nname: small-agent\ndescription: Short inline agent description.\n---\nBody.\n',
    );
    writeSkill(
      root,
      'big-skill',
      [
        '---',
        'name: big-skill',
        'description: >',
        '  This is a much longer folded block-scalar description that spans',
        '  multiple continuation lines and would read as nearly empty under',
        '  a naive line-based scanner.',
        '---',
        '',
        'Body.',
        '',
      ].join('\n'),
    );
    writeCommand(
      root,
      'my-command',
      '---\nname: my-command\ndescription: A command description.\n---\n',
    );

    const result = measureDescriptionSurface({ repoRoot: root });

    // Hardcoded literals (computed once from this exact hand-written fixture,
    // not re-derived from the production formula — see .claude/rules/testing.md
    // § "3. Tautological Computation"). naiveTotalChars: 31 ('Short inline
    // agent description.') + 1 ('>' indicator) + 22 ('A command description.')
    // = 54. correctTotalChars: 31 + 158 (folded block-scalar body) + 22 = 211.
    expect(result.fileCount).toBe(3);
    expect(result.naiveTotalChars).toBe(54);
    expect(result.correctTotalChars).toBe(211);
    expect(result.deltaChars).toBe(157);
    expect(result.bySurfaceBytes).toEqual({ agents: 31, skills: 158, commands: 22 });

    const skillEntry = result.perFile.find((f) => f.file === 'skills/big-skill/SKILL.md');
    expect(skillEntry.isBlockScalar).toBe(true);
    expect(skillEntry.naiveChars).toBe(1); // just the '>' char
    expect(skillEntry.correctChars).toBe(158); // exact folded content length — a dropped continuation line would change this
  });

  it('flags the single largest description among the top-N outliers, with no tie-explosion', () => {
    const root = tmp();
    makeRepoSkeleton(root);

    // 5 small agents at DISTINCT lengths (10/12/14/16/18 'd' chars) so the
    // top-3 cutoff has no tie at the boundary, plus 1 dramatically larger one.
    const smallLengths = [10, 12, 14, 16, 18];
    for (let i = 0; i < smallLengths.length; i++) {
      writeAgent(
        root,
        `agent-${i}`,
        `---\nname: agent-${i}\ndescription: ${'d'.repeat(smallLengths[i])}\n---\n`,
      );
    }
    writeAgent(root, 'huge-agent', `---\nname: huge-agent\ndescription: ${'X'.repeat(500)}\n---\n`);

    const result = measureDescriptionSurface({ repoRoot: root, outlierTopN: 3 });

    expect(result.outliers).toHaveLength(3);
    expect(result.outliers[0]).toEqual({ file: 'agents/huge-agent.md', correctChars: 500 });
    expect(result.outliers[1]).toEqual({ file: 'agents/agent-4.md', correctChars: 18 });
    expect(result.outliers[2]).toEqual({ file: 'agents/agent-3.md', correctChars: 16 });
  });

  it('never treats an empty-description file as a size outlier', () => {
    const root = tmp();
    makeRepoSkeleton(root);
    // Only file has NO description key at all.
    writeAgent(root, 'no-desc', '---\nname: no-desc\n---\nBody.\n');

    const result = measureDescriptionSurface({
      repoRoot: root,
      outlierTopN: DEFAULT_OUTLIER_TOP_N,
    });

    expect(result.outliers).toEqual([]);
  });

  it('returns the empty shape for a repo with no agents/skills/commands directories', () => {
    const root = tmp(); // deliberately no makeRepoSkeleton() call

    const result = measureDescriptionSurface({ repoRoot: root });

    expect(result).toEqual({
      fileCount: 0,
      naiveTotalChars: 0,
      correctTotalChars: 0,
      correctTotalBytes: 0,
      deltaChars: 0,
      bySurfaceBytes: { agents: 0, skills: 0, commands: 0 },
      perFile: [],
      outliers: [],
    });
  });
});

// ---------------------------------------------------------------------------
// measureDescriptionSurface — nested instruction files are excluded (#878
// defect: agents/AGENTS.md has no frontmatter, but a body-level EXAMPLE line
// starting with `description:` at column 0 — the whole-file naive scanner
// matched it, producing naiveChars(149) > correctChars(0) for that one file
// and driving the corpus-wide deltaChars negative)
// ---------------------------------------------------------------------------

describe('measureDescriptionSurface — nested instruction files excluded', () => {
  it('excludes agents/AGENTS.md and agents/CLAUDE.md from the walked corpus', () => {
    const root = tmp();
    makeRepoSkeleton(root);
    writeAgent(
      root,
      'real-agent',
      '---\nname: real-agent\ndescription: A real agent.\n---\nBody.\n',
    );
    // No frontmatter at all — the shape agents/AGENTS.md had when #878 was
    // found: a spec doc with an example line starting with `description:` deep
    // in the body, at column 0. The real file now carries containment
    // frontmatter (it was registering as a full-tool agent), but the exclusion
    // must keep holding for the frontmatter-less shape, so the fixture stays.
    writeAgent(
      root,
      'AGENTS',
      [
        '# Sub-Agent Authoring Conventions',
        '',
        'Example frontmatter:',
        '',
        'description: Use this agent when [conditions].',
        '',
      ].join('\n'),
    );
    writeAgent(
      root,
      'CLAUDE',
      '# Nested instructions\n\ndescription: also not an agent definition.\n',
    );

    const result = measureDescriptionSurface({ repoRoot: root });

    expect(result.fileCount).toBe(1);
    expect(result.perFile.map((f) => f.file)).toEqual(['agents/real-agent.md']);
    // The excluded files, if walked, would have contributed naiveChars > 0
    // with correctChars 0 each — proving the exclusion is what keeps the
    // invariant intact, not a coincidence of this particular fixture.
    expect(result.deltaChars).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// CLI — argument parsing, exit codes, --json shape
// ---------------------------------------------------------------------------

function runCli(args, cwd = undefined) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('CLI — --help', () => {
  it('prints usage and exits 0', () => {
    const { status, stdout } = runCli(['--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('Usage: description-surface.mjs');
  });
});

describe('CLI — --json output shape', () => {
  it('produces parseable JSON with the documented top-level shape over a hermetic fixture repo', () => {
    const root = tmp();
    makeRepoSkeleton(root);
    writeAgent(root, 'only-agent', '---\nname: only-agent\ndescription: One agent.\n---\n');

    const { status, stdout } = runCli(['--repo-root', root, '--json']);

    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toMatchObject({
      fileCount: 1,
      naiveTotalChars: expect.any(Number),
      correctTotalChars: expect.any(Number),
      correctTotalBytes: expect.any(Number),
      deltaChars: expect.any(Number),
      bySurfaceBytes: { agents: expect.any(Number), skills: 0, commands: 0 },
    });
    expect(Array.isArray(parsed.perFile)).toBe(true);
    expect(Array.isArray(parsed.outliers)).toBe(true);
  });

  it('human (non-JSON) mode prints a summary line without --json', () => {
    const root = tmp();
    makeRepoSkeleton(root);
    writeAgent(root, 'only-agent', '---\nname: only-agent\ndescription: One agent.\n---\n');

    const { status, stdout } = runCli(['--repo-root', root]);

    expect(status).toBe(0);
    expect(stdout).toContain('Description surface:');
  });
});

describe('CLI — user-input error paths (exit 1, per .claude/rules/cli-design.md)', () => {
  it('exits 1 (not a crash) when --repo-root has no following value', () => {
    const { status, stderr } = runCli(['--repo-root']);

    expect(status).toBe(1);
    expect(stderr).not.toContain('TypeError');
    const parsed = JSON.parse(stderr);
    expect(parsed).toEqual({ status: 'user-error', reason: '--repo-root requires a value' });
  });

  it('exits 1 on an unrecognized flag', () => {
    const { status, stderr } = runCli(['--not-a-real-flag']);

    expect(status).toBe(1);
    const parsed = JSON.parse(stderr);
    expect(parsed).toEqual({ status: 'user-error', reason: 'unknown arg: --not-a-real-flag' });
  });

  it('exits 1 when --outlier-top-n is non-numeric', () => {
    const { status, stderr } = runCli(['--outlier-top-n', 'abc']);

    expect(status).toBe(1);
    const parsed = JSON.parse(stderr);
    expect(parsed).toEqual({ status: 'user-error', reason: 'invalid --outlier-top-n' });
  });

  it('exits 1 when --outlier-top-n is zero or negative', () => {
    const { status } = runCli(['--outlier-top-n', '0']);

    expect(status).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// CLI — pipe delivery exceeding the 64KiB OS pipe buffer (#878 defect 1,
// same failure class as #876 in scripts/print-applicable-rules.mjs)
// ---------------------------------------------------------------------------
//
// process.stdout.write() to a pipe is ASYNCHRONOUS in Node. An explicit
// process.exit() immediately after that write races the kernel pipe buffer
// (65,536 B on macOS) and can terminate the process before the buffer fully
// drains — silently truncating the payload while still reporting exit code
// 0. The live corpus (~35KB of --json output) is nowhere near large enough
// to force this race, so this fixture is built large enough on purpose (and
// its size is ASSERTED, not assumed) to reproduce it every time.

const PIPE_BUFFER_BYTES = 65536;

/** Ground-truth byte length via a real file descriptor (never subject to the pipe-buffer race). */
function fileRedirectByteLength(cwd, args) {
  const outPath = join(cwd, `complete-${Math.random().toString(36).slice(2)}.out`);
  const fd = openSync(outPath, 'w');
  try {
    const res = spawnSync(process.execPath, [CLI, ...args], { stdio: ['ignore', fd, 'ignore'] });
    if (res.status !== 0)
      throw new Error(`CLI exited ${res.status} while building the file-redirect baseline`);
  } finally {
    closeSync(fd);
  }
  return statSync(outPath).size;
}

describe('CLI — pipe delivery exceeding the 64KiB pipe buffer', () => {
  let bigRepo;

  beforeAll(() => {
    bigRepo = mkdtempSync(join(tmpdir(), 'description-surface-pipe-'));
    mkdirSync(join(bigRepo, 'agents'), { recursive: true });
    // 400 agents with a ~250-char description each -> the --json payload's
    // per-file entries alone comfortably exceed 65536 bytes.
    for (let i = 0; i < 400; i++) {
      const name = `agent-${String(i).padStart(3, '0')}`;
      writeFileSync(
        join(bigRepo, 'agents', `${name}.md`),
        `---\nname: ${name}\ndescription: ${'d'.repeat(250)}\n---\n`,
        'utf8',
      );
    }
  });

  afterAll(() => {
    rmSync(bigRepo, { recursive: true, force: true });
  });

  it('--json output through a spawnSync pipe is byte-identical to the file-redirect baseline', () => {
    const completeLen = fileRedirectByteLength(bigRepo, ['--repo-root', bigRepo, '--json']);
    expect(completeLen).toBeGreaterThan(PIPE_BUFFER_BYTES); // fixture sanity

    const res = spawnSync(process.execPath, [CLI, '--repo-root', bigRepo, '--json'], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });

    expect(res.status).toBe(0);
    expect(Buffer.byteLength(res.stdout, 'utf8')).toBe(completeLen);
    // Byte-count parity alone would pass on a coincidental match; also
    // confirm the payload is syntactically complete (a truncated tail fails
    // to parse).
    expect(() => JSON.parse(res.stdout)).not.toThrow();
  });
});
