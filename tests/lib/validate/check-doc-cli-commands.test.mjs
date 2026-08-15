import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  parseCommandsSection,
  extractCandidates,
  parseInvocations,
  inspectDocCliCommands,
} from '../../../scripts/lib/validate/check-doc-cli-commands.mjs';

const repoRoot = process.cwd();
const checkScript = path.join(repoRoot, 'scripts/lib/validate/check-doc-cli-commands.mjs');

/** @param {string} bin */
const hasBin = (bin) => spawnSync('command', ['-v', bin], { shell: true }).status === 0;
const hasGlab = hasBin('glab');

/** Real `glab repo --help` shape: padded section headers, 4-space command column. */
const GLAB_HELP = `
  Work with GitLab repositories and projects.

  USAGE

    glab repo <command> [command] [--flags]

  COMMANDS

    clone [<repo> | -g <group>] [<dir>]   Clone a GitLab repository or project.
    create [path] [--flags]               Create a new GitLab project/repository.
    mirror [ID | URL | PATH] [--flags]    Configure mirroring on an existing project to sync
                                          with a remote repository.
    view [repository] [--flags]           View a project or repository.

  FLAGS

    -h --help                             Show help for this command.
`;

/** Real `gh repo --help` shape: column-0 headers, multiple COMMANDS sections. */
const GH_HELP = `
Work with GitHub repositories.

GENERAL COMMANDS
  create:        Create a new repository
  list:          List repositories owned by user or organization

TARGETED COMMANDS
  edit:          Edit repository settings
  view:          View a repository

INHERITED FLAGS
  --help   Show help for command
`;

describe('parseCommandsSection', () => {
  it('parses glab padded "  COMMANDS  " headers at the command column', () => {
    const commands = parseCommandsSection(GLAB_HELP);
    expect([...commands].sort()).toEqual(['clone', 'create', 'mirror', 'view']);
  });

  it('parses every gh COMMANDS section, not just the first', () => {
    const commands = parseCommandsSection(GH_HELP);
    expect([...commands].sort()).toEqual(['create', 'edit', 'list', 'view']);
  });

  it('does not mistake a wrapped description line for a subcommand', () => {
    // "with" begins the continuation of mirror's description. Accepting deeper
    // indentation would invent a `glab repo with` subcommand and mask a real
    // dead-command finding by widening the accepted set.
    expect(parseCommandsSection(GLAB_HELP).has('with')).toBe(false);
  });

  it('returns null when the help text has no COMMANDS section at all', () => {
    // This null is the api exemption: `gh api <endpoint>` / `glab api <endpoint>`
    // take a positional, so judging their next token as a subcommand produces a
    // guaranteed false positive on every `glab api projects/...` line in docs.
    const leafHelp = 'Makes an authenticated HTTP request to the GitLab API.\n\n  USAGE  \n\n    glab api <endpoint>\n';
    expect(parseCommandsSection(leafHelp)).toBeNull();
  });
});

describe('extractCandidates — channel separation', () => {
  it('takes commands from shell fences and drops shell comments', () => {
    // A shell-comment negative example (the skills/gitlab-ops/SKILL.md
    // convention) must not be reported as a live dead command.
    const body = '```bash\nglab repo view x/y\n# glab repo edit --visibility private\n```\n';
    const texts = extractCandidates(body).map((c) => c.text);
    expect(texts).toEqual(['glab repo view x/y']);
  });

  it('ignores fences whose language is not shell', () => {
    const body = '```js\nconst s = "glab repo edit";\n```\n';
    expect(extractCandidates(body)).toEqual([]);
  });

  it('accepts an inline span only when it BEGINS with the CLI name', () => {
    // `glab group list` lived in an inline span in prose (#1023) — a fence-only
    // check never sees it. But a span merely MENTIONING a CLI mid-sentence is
    // prose about a command; accepting those was measured at >25% noise.
    const body = 'Run `glab group list` but not `the glab group list thing`.\n';
    const spans = extractCandidates(body).filter((c) => c.channel === 'inline-span');
    expect(spans.map((s) => s.text)).toEqual(['glab group list']);
  });

  it('does not treat an inline span inside a fence as a second candidate', () => {
    const body = '```bash\nglab repo view x/y\n```\n';
    expect(extractCandidates(body).map((c) => c.channel)).toEqual(['shell-fence']);
  });

  it('joins backslash continuations so flags on later lines stay attached', () => {
    const body = '```bash\nglab issue create -R a/b \\\n  --title T\n```\n';
    const [candidate] = extractCandidates(body);
    expect(candidate.text).toBe('glab issue create -R a/b  --title T');
    expect(candidate.line).toBe(2);
  });
});

describe('parseInvocations', () => {
  it('skips leading flags to find the real subcommand token', () => {
    expect(parseInvocations('glab issue create -R a/b --title T')).toEqual([
      { cli: 'glab', group: 'issue', sub: 'create' },
    ]);
  });

  it('reports no subcommand when only flags follow the group', () => {
    expect(parseInvocations('glab api -X PUT projects/1')[0]).toMatchObject({
      group: 'api',
      sub: 'PUT',
    });
  });
});

describe('inspectDocCliCommands — end to end', () => {
  /** @type {string} */
  let fixtureRoot;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), 'doc-cli-commands-'));
    mkdirSync(path.join(fixtureRoot, 'skills'), { recursive: true });
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  /** @param {string} name @param {string} body */
  const writeDoc = (name, body) => {
    writeFileSync(path.join(fixtureRoot, 'skills', name), body, 'utf8');
  };

  it.skipIf(!hasGlab)('reports a dead subcommand and leaves the live one alone', () => {
    writeDoc('a.md', '```bash\nglab repo edit --visibility private\nglab repo view a/b\n```\n');
    const findings = inspectDocCliCommands(fixtureRoot).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: 'dead-subcommand', command: 'glab repo edit' });
  });

  it.skipIf(!hasGlab)('reports a dead command GROUP found only in an inline span', () => {
    writeDoc('a.md', 'Use `glab group list` to enumerate groups.\n');
    const findings = inspectDocCliCommands(fixtureRoot).findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'dead-command-group',
      command: 'glab group',
      channel: 'inline-span',
    });
  });

  it.skipIf(!hasGlab)('does not flag `glab pipeline`, an undocumented alias for `glab ci`', () => {
    // `pipeline` is absent from `glab --help` COMMANDS but works. A top-level
    // membership oracle reports its in-repo uses as dead; asking the group's own
    // --help resolves the alias. Regression guard for that false-positive class.
    writeDoc('a.md', '```bash\nglab pipeline status\nglab pipeline list\n```\n');
    expect(inspectDocCliCommands(fixtureRoot).findings).toEqual([]);
  });

  it.skipIf(!hasGlab)('does not flag `glab api`, whose next token is a positional endpoint', () => {
    writeDoc('a.md', '```bash\nglab api projects/74\nglab api "groups?per_page=2"\n```\n');
    const result = inspectDocCliCommands(fixtureRoot);
    expect(result.findings).toEqual([]);
    expect(result.summary.leafExempt).toBeGreaterThan(0);
  });

  it.skipIf(!hasGlab)('leaves templated tokens unjudged instead of guessing', () => {
    writeDoc('a.md', '```bash\nglab $VERB list\nglab repo "${SUBCOMMAND}"\n```\n');
    const result = inspectDocCliCommands(fixtureRoot);
    expect(result.findings).toEqual([]);
    expect(result.summary.templateSkipped).toBeGreaterThan(0);
  });
});

describe('runCheckDocCliCommands — CLI contract', () => {
  it('SKIPs silently with exit 0 when neither binary is installed', () => {
    // A CI runner without `glab` must not go red. Emitting WARN or FAIL here
    // would make binary availability, not doc correctness, decide the build.
    const result = spawnSync(process.execPath, [checkScript, repoRoot], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '/nonexistent-path-for-skip-test' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('SKIP: `gh` is not installed');
    expect(result.stdout).toContain('SKIP: `glab` is not installed');
    expect(result.stdout).not.toMatch(/^ {2}FAIL:/m);
  });

  it('never emits a bare FAIL: line on the census path', () => {
    // scripts/validate-plugin.mjs tallies /^[ ]{2}FAIL:/gm module-wide, so one
    // FAIL: line from this WARN-only check would red the entire validator.
    const result = spawnSync(process.execPath, [checkScript, repoRoot], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/^ {2}FAIL:/m);
  });
});
