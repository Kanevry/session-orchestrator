/**
 * tests/docs/setup-config-examples.test.mjs
 *
 * Guards the `## Session Config` example blocks in the setup docs against
 * silent drift into unparseable/invalid states (issue #791).
 *
 * The Epic #774 guards (claude-md-drift-check Check 10 docs-parity,
 * docs-staleness) cover count-claims and mtime — neither EXECUTES doc
 * examples against the real parser. This file closes that gap by:
 *
 *   1. Extracting every genuinely-standalone `## Session Config` example
 *      from docs/USER-GUIDE.md, docs/codex-setup.md, docs/cursor-setup.md,
 *      docs/pi-setup.md, docs/templates/AGENTS-session-config.md.
 *   2. Running each through the REAL scripts/parse-config.mjs (spawned
 *      subprocess) — asserting exit 0 + parseable JSON.
 *   3. Running the parsed JSON through validateSessionConfig() from
 *      scripts/lib/config-schema.mjs DIRECTLY IN-PROCESS — asserting
 *      ok:true with zero schema errors.
 *   4. A curated set of round-trip tests hardcode the literal values each
 *      doc example declares (waves, agents-per-wave, persistence, …) and
 *      assert the parsed JSON reproduces them exactly — this catches
 *      format regressions (e.g. a broken bullet-list `- **key:** value`
 *      renderer), not just crashes.
 *
 * docs/session-config-template.md is deliberately EXCLUDED — it documents
 * individual opt-in blocks that are not standalone-complete (per issue
 * #791 scope).
 *
 * -----------------------------------------------------------------------
 * CRITICAL CONTRACT NOTE (validated empirically, not assumed):
 *
 * `node scripts/validate-config.mjs` on malformed JSON stdin EXITS 1 (not
 * 0) — see the "validate-config.mjs CLI contract" describe block below,
 * which pins this down with a real subprocess invocation.
 *
 * The REAL exit-0 trap is different: when `enforcement: warn` (the value
 * every doc example in this repo uses) and the config is SCHEMA-INVALID
 * (e.g. `agents-per-wave: 1`, below the >=2 floor), validate-config.mjs
 * still exits 0 — it prints a warning to stderr and passes the invalid
 * config through to stdout unchanged. An exit-code-only assertion would
 * never catch a doc example that silently drifted into schema-invalid
 * territory as long as `enforcement: warn` stays in the example. That is
 * why step 3 above calls validateSessionConfig() directly in-process and
 * asserts on its `ok` verdict — not on any subprocess exit code.
 * -----------------------------------------------------------------------
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSessionConfig } from '@lib/config-schema.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PARSE_SCRIPT = join(REPO_ROOT, 'scripts', 'parse-config.mjs');
const VALIDATE_SCRIPT = join(REPO_ROOT, 'scripts', 'validate-config.mjs');

// Well below vitest's testTimeout (10s local / 30s CI, vitest.config.mjs).
const SPAWN_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

const TARGET_DOCS = [
  'docs/USER-GUIDE.md',
  'docs/codex-setup.md',
  'docs/cursor-setup.md',
  'docs/pi-setup.md',
  'docs/templates/AGENTS-session-config.md',
];

// A block that declares fewer than this many keys is a documentation
// fragment illustrating ONE setting to add to an existing config (e.g.
// USER-GUIDE.md's "## Session Config\ndiscovery-confidence-threshold: 60"
// snippet under "Findings below the confidence threshold…") — not a
// standalone-complete example a user would paste wholesale. Same reasoning
// that excludes docs/session-config-template.md from TARGET_DOCS entirely.
const MIN_KEYS_FOR_STANDALONE_EXAMPLE = 3;

function countConfigKeys(blockText) {
  let count = 0;
  for (const line of blockText.split(/\r?\n/)) {
    if (/^\s*-\s+\*\*([^*:]+):\*\*\s*(.*)/.test(line)) {
      count += 1;
      continue;
    }
    if (/^\s*(?:-\s+)?([a-zA-Z][a-zA-Z0-9_-]+):\s+(.*)/.test(line)) {
      count += 1;
    }
  }
  return count;
}

// Fenced ``` blocks whose first non-blank inner line is exactly
// "## Session Config" (matches docs/codex-setup.md, docs/cursor-setup.md,
// docs/pi-setup.md, and two of docs/USER-GUIDE.md's blocks).
function extractFencedSessionConfigBlocks(text) {
  const blocks = [];
  const fenceRe = /```[^\n]*\n([\s\S]*?)```/g;
  let match;
  while ((match = fenceRe.exec(text)) !== null) {
    const inner = match[1];
    const firstNonBlank = inner.split(/\r?\n/).find((line) => line.trim() !== '');
    if (firstNonBlank && firstNonBlank.trim() === '## Session Config') {
      blocks.push(inner);
    }
  }
  return blocks;
}

// Unfenced "## Session Config" heading followed by bare markdown (matches
// docs/templates/AGENTS-session-config.md, whose config block is not
// wrapped in a code fence at all). Collects through the next `## ` heading
// or a `---` divider, whichever comes first.
function extractUnfencedSessionConfigBlock(text) {
  const lines = text.split(/\r?\n/);
  const startIdx = lines.findIndex((line) => line.trim() === '## Session Config');
  if (startIdx === -1) return null;
  const collected = [];
  for (let i = startIdx; i < lines.length; i += 1) {
    const line = lines[i];
    if (i > startIdx && /^## /.test(line)) break;
    if (i > startIdx && /^---\s*$/.test(line)) break;
    collected.push(line);
  }
  return collected.join('\n');
}

function extractSessionConfigExamples(text) {
  const fenced = extractFencedSessionConfigBlocks(text);
  const candidates = fenced.length > 0 ? fenced : [extractUnfencedSessionConfigBlock(text)].filter(Boolean);
  return candidates.filter((block) => countConfigKeys(block) >= MIN_KEYS_FOR_STANDALONE_EXAMPLE);
}

function readDoc(relPath) {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

// All qualifying examples across the five target docs, in file-then-
// appearance order. Built once at module load — pure file reads, no I/O
// side effects.
const EXAMPLES = TARGET_DOCS.flatMap((doc) =>
  extractSessionConfigExamples(readDoc(doc)).map((block, index) => ({
    doc,
    index,
    block,
    label: `${doc}#${index}`,
  }))
);

// ---------------------------------------------------------------------------
// parse-config.mjs runner (spawns the real script against a tmp file)
// ---------------------------------------------------------------------------

function runParseConfigOnBlock(blockText) {
  const dir = mkdtempSync(join(tmpdir(), 'sce-'));
  try {
    const file = join(dir, 'CLAUDE.md');
    writeFileSync(file, blockText.endsWith('\n') ? blockText : `${blockText}\n`, 'utf8');
    try {
      const stdout = execFileSync('node', [PARSE_SCRIPT, file, '--json'], {
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      return {
        status: err.status ?? 1,
        stdout: err.stdout ? err.stdout.toString() : '',
        stderr: err.stderr ? err.stderr.toString() : '',
      };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. Floor assertion — the extractor must find a non-trivial number of
//    examples. Floor only (no ceiling) per testing.md's Dynamic Artifact
//    Counts carve-out, as directed by issue #791.
// ---------------------------------------------------------------------------

describe('Session Config example extraction (docs #791)', () => {
  it('finds at least 4 standalone Session Config examples across the five docs', () => {
    expect(EXAMPLES.length).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. Every qualifying example must parse cleanly AND pass schema
//    validation via validateSessionConfig() in-process.
// ---------------------------------------------------------------------------

describe.each(EXAMPLES)('$label', ({ block }) => {
  it('parses via scripts/parse-config.mjs with exit 0 and valid JSON', () => {
    const result = runParseConfigOnBlock(block);
    expect(result.status).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it('passes validateSessionConfig() with ok:true and zero schema errors', () => {
    const result = runParseConfigOnBlock(block);
    const parsed = JSON.parse(result.stdout);
    const verdict = validateSessionConfig(parsed);
    expect(verdict.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Round-trip fidelity — hardcoded literal values lifted from the docs
//    as they exist on disk right now. Catches format regressions (e.g. a
//    broken bullet-list renderer) that a bare exit-0 check would miss.
// ---------------------------------------------------------------------------

describe('round-trip fidelity — hardcoded literal values', () => {
  it('docs/USER-GUIDE.md minimal example round-trips its plain key:value fields', () => {
    const [block] = extractSessionConfigExamples(readDoc('docs/USER-GUIDE.md'));
    const parsed = JSON.parse(runParseConfigOnBlock(block).stdout);
    expect(parsed['test-command']).toBe('npm test');
    expect(parsed['typecheck-command']).toBe('npm run typecheck');
    expect(parsed['lint-command']).toBe('npm run lint');
    expect(parsed['agents-per-wave']).toBe(6);
    expect(parsed.waves).toBe(5);
    expect(parsed.persistence).toBe(true);
    expect(parsed.enforcement).toBe('warn');
    expect(parsed.vcs).toBe('github');
  });

  it('docs/USER-GUIDE.md bullet-format "Example" block round-trips its `- **key:** value` fields', () => {
    const blocks = extractSessionConfigExamples(readDoc('docs/USER-GUIDE.md'));
    // Second qualifying block in file-appearance order (the "### Example"
    // section) — exercises Format 1 (`- **key:** value`) specifically,
    // distinct from the plain `key: value` Format 2 covered above.
    const parsed = JSON.parse(runParseConfigOnBlock(blocks[1]).stdout);
    expect(parsed['agents-per-wave']).toBe(6);
    expect(parsed.waves).toBe(5);
    expect(parsed.pencil).toBe('designs/app.pen');
    expect(parsed.vcs).toBe('gitlab');
    expect(parsed['gitlab-host']).toBe('gitlab.company.com');
    expect(parsed.mirror).toBe('github');
    expect(parsed['ecosystem-health']).toBe(true);
    expect(parsed['test-command']).toBe('pnpm vitest run');
    expect(parsed.persistence).toBe(true);
    expect(parsed.enforcement).toBe('warn');
    expect(parsed.isolation).toBe('auto');
    expect(parsed['max-turns']).toBe('auto');
    expect(parsed['plan-prd-location']).toBe('docs/prd/');
    expect(parsed['plan-retro-location']).toBe('docs/retro/');
    expect(parsed['memory-cleanup-threshold']).toBe(5);
    expect(parsed['stale-issue-days']).toBe(14);
    expect(parsed.special).toBe('Always run database migrations before testing');
  });

  it('docs/codex-setup.md example round-trips its declared fields', () => {
    const [block] = extractSessionConfigExamples(readDoc('docs/codex-setup.md'));
    const parsed = JSON.parse(runParseConfigOnBlock(block).stdout);
    expect(parsed['test-command']).toBe('npm test');
    expect(parsed['typecheck-command']).toBe('npm run typecheck');
    expect(parsed['lint-command']).toBe('npm run lint');
    expect(parsed['agents-per-wave']).toBe(6);
    expect(parsed.waves).toBe(5);
    expect(parsed.persistence).toBe(true);
    expect(parsed.enforcement).toBe('warn');
    expect(parsed.vcs).toBe('github');
  });

  it('docs/cursor-setup.md example round-trips its declared fields', () => {
    const [block] = extractSessionConfigExamples(readDoc('docs/cursor-setup.md'));
    const parsed = JSON.parse(runParseConfigOnBlock(block).stdout);
    expect(parsed['test-command']).toBe('npm test');
    expect(parsed['typecheck-command']).toBe('npm run typecheck');
    expect(parsed['lint-command']).toBe('npm run lint');
    expect(parsed['agents-per-wave']).toBe(6);
    expect(parsed.waves).toBe(5);
    expect(parsed.persistence).toBe(true);
    expect(parsed.enforcement).toBe('warn');
    expect(parsed.vcs).toBe('github');
  });

  it('docs/pi-setup.md example round-trips its declared fields', () => {
    const [block] = extractSessionConfigExamples(readDoc('docs/pi-setup.md'));
    const parsed = JSON.parse(runParseConfigOnBlock(block).stdout);
    expect(parsed['agents-per-wave']).toBe(6);
    expect(parsed.waves).toBe(5);
    expect(parsed.persistence).toBe(true);
    expect(parsed.enforcement).toBe('warn');
    expect(parsed['test-command']).toBe('npm test');
    expect(parsed['typecheck-command']).toBe('npm run typecheck');
    expect(parsed['lint-command']).toBe('npm run lint');
  });

  it('docs/templates/AGENTS-session-config.md example round-trips its declared fields', () => {
    const [block] = extractSessionConfigExamples(readDoc('docs/templates/AGENTS-session-config.md'));
    const parsed = JSON.parse(runParseConfigOnBlock(block).stdout);
    expect(parsed['agents-per-wave']).toBe(6);
    expect(parsed.waves).toBe(5);
    expect(parsed['recent-commits']).toBe(20);
    expect(parsed.persistence).toBe(true);
    expect(parsed.enforcement).toBe('warn');
    expect(parsed.isolation).toBe('auto');
    expect(parsed['max-turns']).toBe('auto');
    expect(parsed['learning-expiry-days']).toBe(30);
    expect(parsed.vcs).toBe('github');
    // "none" is a documented sentinel string that _coerceString() (see
    // scripts/lib/config/coercers.mjs) always maps to JSON null — not a
    // format regression.
    expect(parsed.mirror).toBeNull();
    expect(parsed['test-command']).toBe('npm test');
    expect(parsed['typecheck-command']).toBe('npm run typecheck');
    expect(parsed['lint-command']).toBe('npm run lint');
    expect(parsed['discovery-on-close']).toBe(false);
    expect(parsed['discovery-severity-threshold']).toBe('low');
    expect(parsed['discovery-confidence-threshold']).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Falsification-check sanity — proves the validateSessionConfig() call
// above actually bites. If validateSessionConfig() were broken to always
// return ok:true, every test above would still pass (a blind spot no
// currently-valid doc example can expose). This synthetic case closes
// that gap: it is NOT derived from any doc, and asserts on a REAL schema
// violation (agents-per-wave below the >=2 floor from
// scripts/lib/config-schema.mjs's validateAgentsPerWave).
// ---------------------------------------------------------------------------

describe('validateSessionConfig() sanity (non-doc synthetic case)', () => {
  it('rejects a config with agents-per-wave below the schema floor', () => {
    const badConfig = {
      'test-command': 'npm test',
      'typecheck-command': 'npm run typecheck',
      'lint-command': 'npm run lint',
      'agents-per-wave': 1,
      waves: 5,
      persistence: true,
      enforcement: 'warn',
    };
    const verdict = validateSessionConfig(badConfig);
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.some((e) => e.path === 'agents-per-wave')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validate-config.mjs CLI contract — pinned down empirically (issue #791
// flagged this as possibly "exit 0 even on malformed JSON"; that specific
// claim does NOT hold on the current script — see assertions below). The
// REAL exit-0-with-invalid-content trap is the enforcement:warn case,
// which is why step 3 above never relies on this CLI's exit code.
// ---------------------------------------------------------------------------

describe('validate-config.mjs CLI contract (documented for follow-up)', () => {
  it('exits 1 on malformed JSON stdin', () => {
    let status;
    let stderr = '';
    try {
      execFileSync('node', [VALIDATE_SCRIPT], {
        input: 'not json',
        encoding: 'utf8',
        timeout: SPAWN_TIMEOUT_MS,
      });
      status = 0;
    } catch (err) {
      status = err.status ?? 1;
      stderr = err.stderr ? err.stderr.toString() : '';
    }
    expect(status).toBe(1);
    expect(stderr).toContain('malformed JSON');
  });

  it('exits 0 and passes through an invalid config unchanged when enforcement is warn', () => {
    const input = JSON.stringify({
      'test-command': 'npm test',
      'typecheck-command': 'npm run typecheck',
      'lint-command': 'npm run lint',
      'agents-per-wave': 1,
      waves: 5,
      persistence: true,
      enforcement: 'warn',
    });
    const stdout = execFileSync('node', [VALIDATE_SCRIPT], {
      input,
      encoding: 'utf8',
      timeout: SPAWN_TIMEOUT_MS,
    });
    expect(stdout).toBe(input);
  });
});
