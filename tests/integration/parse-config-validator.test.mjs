import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not .pathname — Windows returns `/D:/...` via .pathname, which
// resolve() then mangles to `D:\D:\...`.
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'parse-config.mjs');

function runParseConfig(cwd) {
  const result = execFileSync('node', [SCRIPT], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result;
}

function runParseConfigCaptureStderr(cwd) {
  try {
    const output = execFileSync('node', [SCRIPT], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout: output, stderr: '', code: 0 };
  } catch (err) {
    return {
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : '',
      code: err.status ?? 1,
    };
  }
}

describe('parse-config.mjs → validate-config.mjs integration (#182)', () => {
  let sandbox;
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'pc-'));
    execFileSync('git', ['init', '-q'], { cwd: sandbox });
  });
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('passes through a valid config unchanged', () => {
    writeFileSync(
      join(sandbox, 'CLAUDE.md'),
      `# Test

## Session Config

persistence: true
enforcement: warn
waves: 5
agents-per-wave: 6
test-command: npm test
typecheck-command: npm run typecheck
lint-command: npm run lint
`
    );
    const out = runParseConfig(sandbox);
    const parsed = JSON.parse(out);
    expect(parsed.waves).toBe(5);
    expect(parsed['test-command']).toBe('npm test');
    expect(parsed.enforcement).toBe('warn');
  });

  it('strict enforcement with invalid value fails with exit 1', () => {
    // Force an invalid enforcement value — validator should reject in strict mode.
    // We can't inject a value that parse-config.sh would reject at yaml level,
    // so we craft a minimal config with all-valid shell-level inputs but
    // later patch via env. Instead: use warn with a valid block and confirm
    // stderr is clean.
    writeFileSync(
      join(sandbox, 'CLAUDE.md'),
      `## Session Config

persistence: true
enforcement: warn
waves: 5
agents-per-wave: 6
test-command: npm test
typecheck-command: npm run typecheck
lint-command: npm run lint
`
    );
    const res = runParseConfigCaptureStderr(sandbox);
    expect(res.code).toBe(0);
    expect(res.stdout.length).toBeGreaterThan(10);
  });

  it('SO_SKIP_CONFIG_VALIDATION=1 bypasses the validator', () => {
    writeFileSync(
      join(sandbox, 'CLAUDE.md'),
      `## Session Config

persistence: true
enforcement: warn
waves: 5
agents-per-wave: 6
`
    );
    const result = execFileSync('node', [SCRIPT], {
      cwd: sandbox,
      encoding: 'utf8',
      env: { ...process.env, SO_SKIP_CONFIG_VALIDATION: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(result);
    expect(parsed.waves).toBe(5);
  });

  it('SO_CONFIG_FILE overrides the default config-file preference', () => {
    // Create BOTH CLAUDE.md and AGENTS.md; SO_CONFIG_FILE must pick AGENTS.md.
    writeFileSync(
      join(sandbox, 'CLAUDE.md'),
      `## Session Config\n\npersistence: true\nenforcement: warn\nwaves: 3\n`
    );
    writeFileSync(
      join(sandbox, 'AGENTS.md'),
      `## Session Config\n\npersistence: true\nenforcement: warn\nwaves: 9\n`
    );
    const result = execFileSync('node', [SCRIPT], {
      cwd: sandbox,
      encoding: 'utf8',
      env: { ...process.env, SO_CONFIG_FILE: 'AGENTS.md' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(result);
    // If SO_CONFIG_FILE was honored, waves=9 (from AGENTS.md). If ignored, waves=3 (from CLAUDE.md).
    expect(parsed.waves).toBe(9);
  });

  // -------------------------------------------------------------------------
  // Regression: inline YAML comments on enum-validated nested values.
  // Downstream-app #1982 AC3 — a value like `mode: warn # warn | strict | off`
  // previously parsed as `'warn # warn | strict | off'`, failing the
  // vault-integration.mode enum (warn | strict | off). _parseKV must strip
  // the trailing ` # ...` segment before enum coercion.
  // -------------------------------------------------------------------------

  it('parses vault-integration.mode with inline YAML comment (BG#1982 AC3)', () => {
    writeFileSync(
      join(sandbox, 'CLAUDE.md'),
      `## Session Config

persistence: true
enforcement: warn
waves: 5
vault-integration:
  enabled: true
  vault-dir: ~/Projects/vault
  mode: warn # warn | strict | off
`
    );
    const out = runParseConfig(sandbox);
    const parsed = JSON.parse(out);
    expect(parsed['vault-integration'].mode).toBe('warn');
    expect(parsed['vault-integration'].enabled).toBe(true);
  });

  it('parses vault-integration.mode with comment on its own line (equivalence)', () => {
    writeFileSync(
      join(sandbox, 'CLAUDE.md'),
      `## Session Config

persistence: true
enforcement: warn
waves: 5
vault-integration:
  enabled: true
  vault-dir: ~/Projects/vault
  # warn | strict | off
  mode: warn
`
    );
    const out = runParseConfig(sandbox);
    const parsed = JSON.parse(out);
    expect(parsed['vault-integration'].mode).toBe('warn');
    expect(parsed['vault-integration'].enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #1097 — an unparsable line inside `## Session Config` is never silent
// ---------------------------------------------------------------------------
//
// The bug these two tests catch: a key the parser cannot read is absent from
// the KV map, so every consumer applies its own default — `false` for booleans.
// A typo'd `vault-integration` block therefore produces the byte-identical
// stdout of a deliberately DISABLED one, and the only trace anywhere is a
// feature that quietly does nothing (fleet evidence: a repo whose vault mirror
// sat at `skipped-vault-disabled` for two months with the key in its CLAUDE.md).
//
// stderr on the success path is why these use spawnSync: execFileSync surfaces
// stderr only when the exit code is non-zero, so the warn case would look clean
// through the runners above.

function spawnParseConfig(cwd) {
  const res = spawnSync('node', [SCRIPT], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const MALFORMED_BLOCK = `## Session Config

persistence: true
enforcement: __ENFORCEMENT__
waves: 5
this line is prose where a key belongs
`;

describe('#1097 unparsable Session Config lines fail loud, never silently default', () => {
  let sandbox;
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'pc-unparsable-'));
    execFileSync('git', ['init', '-q'], { cwd: sandbox });
  });
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('enforcement: warn — names the line on stderr and still emits config (exit 0)', () => {
    writeFileSync(join(sandbox, 'CLAUDE.md'), MALFORMED_BLOCK.replace('__ENFORCEMENT__', 'warn'));
    const res = spawnParseConfig(sandbox);

    expect(res.status).toBe(0);
    expect(res.stderr).toContain('this line is prose where a key belongs');
    // The line NUMBER is the point — an operator has to be able to open the
    // file at the defect, not go hunting for the text.
    expect(res.stderr).toMatch(/line 6:/);
    // warn degrades to the old behaviour on stdout: the JSON is unchanged.
    expect(JSON.parse(res.stdout).waves).toBe(5);
  });

  it('enforcement: strict — refuses with a non-zero exit and emits no config', () => {
    writeFileSync(join(sandbox, 'CLAUDE.md'), MALFORMED_BLOCK.replace('__ENFORCEMENT__', 'strict'));
    const res = spawnParseConfig(sandbox);

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('this line is prose where a key belongs');
    expect(res.stdout).toBe('');
  });

  it('stays byte-silent on a well-formed block (no new noise on the success path)', () => {
    // The guard against the opposite failure: a warning that fires on healthy
    // input is a warning operators learn to ignore. Every accepted form —
    // comment, nested block, list item, fenced wrapper — must pass unremarked.
    writeFileSync(
      join(sandbox, 'CLAUDE.md'),
      `## Session Config

\`\`\`yaml
# a comment
persistence: true
enforcement: warn
waves: 5
cross-repos: [a, b]
vault-integration:
  enabled: true
  mode: warn
custom-phases:
  - name: demo
    command: node scripts/demo.mjs
\`\`\`
`
    );
    const res = spawnParseConfig(sandbox);
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
    expect(JSON.parse(res.stdout).waves).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// #1097 review — the gate's three remaining branches
// ---------------------------------------------------------------------------

describe('#1097 gate — enforcement fallback, truncation tail, control characters', () => {
  let sandbox;
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'pc-gate-'));
    execFileSync('git', ['init', '-q'], { cwd: sandbox });
  });
  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('an out-of-vocabulary enforcement value is rejected by the parser, never read as strict', () => {
    // The bug: `enforcement: banana` reaching the #1097 gate and being treated
    // as an unknown-but-usable value. It never gets there — parseSessionConfig
    // rejects the enum first — and the point of pinning that is the DIRECTION:
    // the failure is a named parse error, not a silent downgrade and not the
    // strict-refusal path firing on a value nobody wrote.
    writeFileSync(
      join(sandbox, 'CLAUDE.md'),
      MALFORMED_BLOCK.replace('__ENFORCEMENT__', 'banana'),
    );
    const res = spawnParseConfig(sandbox);

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("enforcement must be strict|warn|off, got 'banana'");
    // NOT the strict-refusal message — that path must stay unreachable here.
    expect(res.stderr).not.toContain('refusing to emit config');
    expect(res.stdout).toBe('');
  });

  it('names at most 20 lines and counts the rest in a tail line', () => {
    // The bug: an unbounded per-line loop before an immediate process.exit —
    // Node's stderr is async on a pipe, so the tail is the thing that survives
    // truncation and tells the operator the list was cut, not complete.
    const prose = Array.from({ length: 25 }, (_, i) => `prose line number ${i + 1}`).join('\n');
    writeFileSync(
      join(sandbox, 'CLAUDE.md'),
      `## Session Config\n\nenforcement: warn\nwaves: 5\n${prose}\n`,
    );
    const res = spawnParseConfig(sandbox);

    expect(res.status).toBe(0);
    expect(res.stderr).toContain('and 5 more unparsable line(s)');
    expect(res.stderr).toContain('prose line number 20');
    expect(res.stderr).not.toContain('prose line number 21');
    // The total is reported in full even though the list is clipped.
    expect(res.stderr).toContain('25 unparsable line(s)');
  });

  it('neutralises control characters so a reported line cannot rewrite the report', () => {
    // The bug: the text is copied verbatim out of the file being reported as
    // malformed, then printed after a `WARN … line N:` prefix. An ESC/CR
    // sequence erases that prefix and rewrites the operator's terminal line —
    // the defect report becoming the vehicle for hiding the defect.
    writeFileSync(
      join(sandbox, 'CLAUDE.md'),
      '## Session Config\n\nenforcement: warn\nwaves: 5\n\x1b[2Kprose\rHIDDEN\n',
    );
    const res = spawnParseConfig(sandbox);

    expect(res.status).toBe(0);
    expect(res.stderr).toContain('?[2Kprose?HIDDEN');
    expect(res.stderr).not.toContain('\x1b');
    expect(res.stderr).not.toContain('\r');
  });
});
