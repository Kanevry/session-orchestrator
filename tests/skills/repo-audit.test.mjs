import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');

const SKILL_PATH = path.join(repoRoot, 'skills/repo-audit/SKILL.md');
const COMMAND_PATH = path.join(repoRoot, 'commands/repo-audit.md');

/**
 * Minimal frontmatter parser — extracts the YAML block between the opening
 * and closing `---` delimiters and returns a flat key→value map covering the
 * simple scalar fields we need to assert on. Does NOT parse nested YAML.
 */
function parseFrontmatter(absPath) {
  const raw = readFileSync(absPath, 'utf8');
  const match = raw.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n/);
  if (!match) throw new Error(`No frontmatter in ${absPath}`);
  const block = match[1];
  const result = {};
  for (const line of block.split('\n')) {
    const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)/);
    if (kv) {
      const key = kv[1];
      const val = kv[2].trim().replace(/^["']|["']$/g, '');
      result[key] = val === '' ? true : val;
    }
  }
  return result;
}

describe('skills/repo-audit — #215 ported skill', () => {
  describe('SKILL.md presence and frontmatter', () => {
    it('SKILL.md exists', () => {
      expect(existsSync(SKILL_PATH)).toBe(true);
    });

    it('frontmatter has required plugin fields: name, description, model, color', () => {
      const fm = parseFrontmatter(SKILL_PATH);
      expect(fm.name).toBe('repo-audit');
      expect(typeof fm.description).toBe('string');
      expect(fm.description.length).toBeGreaterThan(50);
      expect(fm.model).toBe('inherit');
      expect(fm.color).toBe('cyan');
    });

    it('description follows trigger convention (Use … when)', () => {
      const fm = parseFrontmatter(SKILL_PATH);
      expect(fm.description).toMatch(/Use (this skill )?when/i);
    });

    it('description includes an <example> block with commentary', () => {
      const fm = parseFrontmatter(SKILL_PATH);
      expect(fm.description).toMatch(/<example>/);
      expect(fm.description).toMatch(/<commentary>/);
    });

    it('frontmatter does NOT contain baseline-specific fields (quality-score, context: fork)', () => {
      const raw = readFileSync(SKILL_PATH, 'utf8');
      const fmBlock = raw.match(/^---\r?\n([\s\S]+?)\r?\n---\r?\n/);
      expect(fmBlock).not.toBeNull();
      const block = fmBlock[1];
      expect(block).not.toMatch(/quality-score/);
      expect(block).not.toMatch(/context:\s*fork/);
    });
  });

  describe('SKILL.md body — 9 categories', () => {
    const body = readFileSync(SKILL_PATH, 'utf8');

    const EXPECTED_CATEGORIES = [
      'Configuration',
      'Code Quality',
      'Git Hygiene',
      'CI/CD',
      'Testing',
      'Security',
      'Documentation',
      'Clank Integration',
      'MCP Configuration',
    ];

    for (const category of EXPECTED_CATEGORIES) {
      it(`body contains Category: ${category}`, () => {
        expect(body).toMatch(new RegExp(category, 'i'));
      });
    }

    it('has 9 numbered category sections in body (### Category N:)', () => {
      const matches = body.match(/^### Category \d+:/gm);
      expect(matches).not.toBeNull();
      const count = matches ? matches.length : 0;
      // floor/ceiling per test-quality.md: stable list of exactly 9
      expect(count).toBeGreaterThanOrEqual(9);
      expect(count).toBeLessThanOrEqual(15);
    });
  });

  describe('SKILL.md — Clank opt-in adaptation', () => {
    const body = readFileSync(SKILL_PATH, 'utf8');

    it('Clank section is gated on detection ($CLANK_DETECTED)', () => {
      expect(body).toMatch(/CLANK_DETECTED/);
    });

    it('Clank section marks absent Clank as skipped (not failed)', () => {
      expect(body).toMatch(/skipped.*Clank not detected/i);
    });

    it('Clank detection checks for .clank/ or clank.config.*', () => {
      expect(body).toMatch(/\.clank\//);
      expect(body).toMatch(/clank\.config\./);
    });

    it('ecosystem: baseline flag activates Clank checks when Clank is absent', () => {
      expect(body).toMatch(/ecosystem.*baseline/i);
    });
  });

  describe('SKILL.md — Session Config command resolution', () => {
    const body = readFileSync(SKILL_PATH, 'utf8');

    it('references quality-gates skill for command resolution priority order', () => {
      expect(body).toMatch(/quality-gates/i);
    });

    it('references test-command, typecheck-command, lint-command config keys', () => {
      expect(body).toMatch(/test-command/);
      expect(body).toMatch(/typecheck-command/);
      expect(body).toMatch(/lint-command/);
    });

    it('documents hardcoded defaults (npm test, npm run typecheck, npm run lint)', () => {
      expect(body).toMatch(/npm test/);
      expect(body).toMatch(/npm run typecheck/);
      expect(body).toMatch(/npm run lint/);
    });

    it('documents "skip" literal as a way to bypass a command', () => {
      expect(body).toMatch(/skip/);
    });
  });

  describe('SKILL.md — JSON sidecar output', () => {
    const body = readFileSync(SKILL_PATH, 'utf8');

    it('references .orchestrator/metrics/ as sidecar location', () => {
      expect(body).toMatch(/\.orchestrator\/metrics\//);
    });

    it('sidecar filename includes a timestamp', () => {
      expect(body).toMatch(/repo-audit-.*timestamp/i);
    });

    it('documents schema_version field in JSON output', () => {
      expect(body).toMatch(/schema_version/);
    });

    it('documents overall status logic (pass/fail/warn)', () => {
      expect(body).toMatch(/Overall Status/i);
    });
  });

  describe('SKILL.md — Category 9 MCP server health probe (#707)', () => {
    // Extract only the MCP section for scoped assertions — changes in other
    // categories cannot produce false positives here.
    const body = readFileSync(SKILL_PATH, 'utf8');
    const mcpSectionMatch = body.match(/### Category 9: MCP Configuration[\s\S]+?(?=## Phase 4:|$)/);
    const mcpSection = mcpSectionMatch ? mcpSectionMatch[0] : '';

    it('(a) documents MCP server health-probe method using mcporter list --json', () => {
      // Must fail if Category 9 is reverted to the original 3-row table (no health probe)
      expect(mcpSection.length).toBeGreaterThan(100);
      expect(mcpSection).toMatch(/mcporter list --json/);
    });

    it('(b) scope clarification states it does not cover MCPJungle or global gateway', () => {
      // Must fail if the Scope: line is removed
      expect(mcpSection).toMatch(/MCPJungle/);
      expect(mcpSection).toMatch(/does NOT cover|not cover/i);
    });

    it('(c) mcporter framed as optional: skipped when absent, never a hard dependency', () => {
      // Must fail if the graceful-degrade / SEC-020 framing is removed
      expect(mcpSection).toMatch(/never a hard dependency/i);
      expect(mcpSection).toMatch(/skipped/i);
      expect(mcpSection).toMatch(/npm install -g mcporter/);
    });
  });

  describe('SKILL.md — Category 6 settings-allowlist token guard (SEC-021, #728b)', () => {
    // Throw-on-miss section extraction — gold standard: dispatchCoreBlock() in
    // tests/skills/wave-executor-dispatch-batch.test.mjs. A vacuous '' fallback
    // would let every assertion below silently pass against an empty string.
    function category6Section(text) {
      const start = text.indexOf('### Category 6: Security');
      const end = text.indexOf('### Category 7:');
      if (start === -1 || end === -1 || end <= start) {
        throw new Error('could not locate Category 6: Security section boundaries in repo-audit SKILL.md');
      }
      return text.slice(start, end);
    }

    const body = readFileSync(SKILL_PATH, 'utf8');
    const category6 = category6Section(body);

    it('(a) documents a settings-allowlist token check row', () => {
      expect(category6).toMatch(/PAT\/token in settings-allowlist entries/i);
    });

    it('(b) references settings.local.json (on-disk, untracked) as a scan target', () => {
      expect(category6).toMatch(/settings\.local\.json/);
    });

    it('(c) frames the check as a hard fail, not a warn', () => {
      // Isolate just the new row so a `warn` elsewhere in Category 6 (e.g. the
      // existing "sk-" heuristic row) cannot produce a false positive.
      const rowMatch = category6.match(/^\|.*PAT\/token in settings-allowlist entries[\s\S]*?\|$/m);
      expect(rowMatch).not.toBeNull();
      const row = rowMatch[0];
      expect(row).toMatch(/\bfail\b/i);
      expect(row).not.toMatch(/\bwarn\b/i);
    });

    it('(d) grep pattern includes at least the glpat- and ghp_ token prefixes', () => {
      expect(category6).toMatch(/glpat-/);
      expect(category6).toMatch(/ghp_/);
    });
  });

  describe('commands/repo-audit.md', () => {
    it('command file exists', () => {
      expect(existsSync(COMMAND_PATH)).toBe(true);
    });

    it('command frontmatter has description field', () => {
      const fm = parseFrontmatter(COMMAND_PATH);
      expect(typeof fm.description).toBe('string');
      expect(fm.description.length).toBeGreaterThan(10);
    });

    it('command body references skills/repo-audit/SKILL.md', () => {
      const body = readFileSync(COMMAND_PATH, 'utf8');
      expect(body).toMatch(/skills\/repo-audit\/SKILL\.md/);
    });

    it('command body differentiates from /discovery and /harness-audit', () => {
      const body = readFileSync(COMMAND_PATH, 'utf8');
      expect(body).toMatch(/discovery/i);
      expect(body).toMatch(/harness-audit/i);
    });

    it('command instructs not to auto-fix findings', () => {
      const body = readFileSync(COMMAND_PATH, 'utf8');
      expect(body).toMatch(/do not.*auto.?fix|report only/i);
    });
  });
});
