import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseAgentFrontmatter,
  validateAgentFrontmatter,
  validateAgentFile,
} from '@lib/agent-frontmatter.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const TEMPLATES_DIR = join(REPO_ROOT, 'skills', 'bootstrap', 'templates', 'agents');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContents({ name, description, model, color, tools } = {}) {
  const lines = ['---'];
  if (name !== undefined) lines.push(`name: ${name}`);
  if (description !== undefined) lines.push(`description: ${description}`);
  if (model !== undefined) lines.push(`model: ${model}`);
  if (color !== undefined) lines.push(`color: ${color}`);
  if (tools !== undefined) lines.push(`tools: ${tools}`);
  lines.push('---', '', '# Body');
  return lines.join('\n');
}

function validContents(overrides = {}) {
  return makeContents({
    name: 'my-agent',
    description:
      'Use this agent when you need to do something. <example>Context: ... user: "do it" assistant: "sure" <commentary>why</commentary></example>',
    model: 'inherit',
    color: 'blue',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Bootstrap scaffold templates — all must pass
// ---------------------------------------------------------------------------

describe('bootstrap scaffold templates', () => {
  const templateFiles = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.md'));

  it('has at least 3 template files', () => {
    expect(templateFiles.length).toBeGreaterThanOrEqual(3);
  });

  it.each(templateFiles)('%s passes validation', (filename) => {
    const filePath = join(TEMPLATES_DIR, filename);
    const result = validateAgentFile(filePath);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseAgentFrontmatter
// ---------------------------------------------------------------------------

describe('parseAgentFrontmatter', () => {
  it('returns ok=false for non-string input', () => {
    expect(parseAgentFrontmatter(null).ok).toBe(false);
    expect(parseAgentFrontmatter(undefined).ok).toBe(false);
    expect(parseAgentFrontmatter(42).ok).toBe(false);
  });

  it('returns ok=false when no frontmatter block found', () => {
    const result = parseAgentFrontmatter('# No frontmatter here\n\nJust text.');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].rule).toBe('missing-frontmatter');
    }
  });

  it('parses a valid frontmatter block', () => {
    const result = parseAgentFrontmatter(validContents());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frontmatter['name']).toBe('my-agent');
      expect(result.frontmatter['model']).toBe('inherit');
      expect(result.frontmatter['color']).toBe('blue');
    }
  });

  it('detects block-scalar description (>) as sentinel', () => {
    const contents = '---\nname: my-agent\ndescription: >\n  multi-line text here\nmodel: inherit\ncolor: blue\n---\n\n# Body';
    const result = parseAgentFrontmatter(contents);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frontmatter['description']).toBe('__BLOCK_SCALAR__');
    }
  });

  it('detects block-scalar description (|) as sentinel', () => {
    const contents = '---\nname: my-agent\ndescription: |\n  multi-line text\nmodel: inherit\ncolor: blue\n---\n\n# Body';
    const result = parseAgentFrontmatter(contents);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frontmatter['description']).toBe('__BLOCK_SCALAR__');
    }
  });
});

// ---------------------------------------------------------------------------
// validateAgentFrontmatter
// ---------------------------------------------------------------------------

describe('validateAgentFrontmatter', () => {
  it('accepts a fully valid frontmatter object', () => {
    const fm = {
      name: 'my-agent',
      description: 'Use this agent when needed. <example>Context: ... user: "ok" assistant: "done" <commentary>why</commentary></example>',
      model: 'inherit',
      color: 'blue',
    };
    expect(validateAgentFrontmatter(fm).ok).toBe(true);
  });

  it('accepts all valid model values', () => {
    for (const model of ['inherit', 'sonnet', 'opus', 'haiku']) {
      const fm = { name: 'my-agent', description: 'Desc.', model, color: 'blue' };
      expect(validateAgentFrontmatter(fm).ok, `model=${model}`).toBe(true);
    }
  });

  it('accepts all valid color values', () => {
    for (const color of ['blue', 'cyan', 'green', 'yellow', 'magenta', 'red', 'purple', 'orange', 'pink']) {
      const fm = { name: 'my-agent', description: 'Desc.', model: 'inherit', color };
      expect(validateAgentFrontmatter(fm).ok, `color=${color}`).toBe(true);
    }
  });

  it('accepts optional tools as comma-separated string', () => {
    const fm = {
      name: 'my-agent',
      description: 'Desc.',
      model: 'inherit',
      color: 'blue',
      tools: 'Read, Edit, Write',
    };
    expect(validateAgentFrontmatter(fm).ok).toBe(true);
  });

  // --- Tools accepts both comma-string and JSON-array forms (Anthropic canonical) ---
  it('accepts tools as JSON array of strings', () => {
    const result = parseAgentFrontmatter(validContents({ tools: '["Read", "Edit"]' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const v = validateAgentFrontmatter(result.frontmatter);
      expect(v.ok).toBe(true);
    }
  });

  it('rejects tools as JSON array containing non-string element', () => {
    const result = parseAgentFrontmatter(validContents({ tools: '["Read", 42]' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const v = validateAgentFrontmatter(result.frontmatter);
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.errors.some((e) => e.path === 'tools' && e.rule === 'array-strings-only')).toBe(true);
      }
    }
  });

  it('rejects tools as malformed JSON array (trailing comma)', () => {
    const result = parseAgentFrontmatter(validContents({ tools: '["Read",]' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const v = validateAgentFrontmatter(result.frontmatter);
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.errors.some((e) => e.path === 'tools' && e.rule === 'malformed-array')).toBe(true);
      }
    }
  });

  // --- Negative: block-scalar description ---
  it('rejects block-scalar description', () => {
    const contents = '---\nname: my-agent\ndescription: >\n  multi\nmodel: inherit\ncolor: blue\n---\n';
    const parsed = parseAgentFrontmatter(contents);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const v = validateAgentFrontmatter(parsed.frontmatter);
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.errors.some((e) => e.path === 'description' && e.rule === 'no-block-scalar')).toBe(true);
      }
    }
  });

  // --- Negative: invalid color ---
  it('rejects invalid color', () => {
    // 'turquoise' is outside the canonical 8-color palette + magenta
    const result = parseAgentFrontmatter(validContents({ color: 'turquoise' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const v = validateAgentFrontmatter(result.frontmatter);
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.errors.some((e) => e.path === 'color' && e.rule === 'enum')).toBe(true);
      }
    }
  });

  // --- Negative: invalid model ---
  it('rejects invalid model', () => {
    const result = parseAgentFrontmatter(validContents({ model: 'gpt-4' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const v = validateAgentFrontmatter(result.frontmatter);
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.errors.some((e) => e.path === 'model' && e.rule === 'enum')).toBe(true);
      }
    }
  });

  // --- Negative: missing required field (name) ---
  it('rejects when name is absent', () => {
    const contents = '---\ndescription: Desc.\nmodel: inherit\ncolor: blue\n---\n';
    const parsed = parseAgentFrontmatter(contents);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const v = validateAgentFrontmatter(parsed.frontmatter);
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.errors.some((e) => e.path === 'name' && e.rule === 'required')).toBe(true);
      }
    }
  });

  it('rejects when description is absent', () => {
    const contents = '---\nname: my-agent\nmodel: inherit\ncolor: blue\n---\n';
    const parsed = parseAgentFrontmatter(contents);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const v = validateAgentFrontmatter(parsed.frontmatter);
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.errors.some((e) => e.path === 'description' && e.rule === 'required')).toBe(true);
      }
    }
  });

  it('rejects when model is absent', () => {
    const contents = '---\nname: my-agent\ndescription: Desc.\ncolor: blue\n---\n';
    const parsed = parseAgentFrontmatter(contents);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const v = validateAgentFrontmatter(parsed.frontmatter);
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.errors.some((e) => e.path === 'model' && e.rule === 'required')).toBe(true);
      }
    }
  });

  it('rejects when color is absent', () => {
    const contents = '---\nname: my-agent\ndescription: Desc.\nmodel: inherit\n---\n';
    const parsed = parseAgentFrontmatter(contents);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const v = validateAgentFrontmatter(parsed.frontmatter);
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.errors.some((e) => e.path === 'color' && e.rule === 'required')).toBe(true);
      }
    }
  });

  // --- Negative: name format violations ---
  it('rejects name shorter than 3 chars', () => {
    const v = validateAgentFrontmatter({ name: 'ab', description: 'D', model: 'inherit', color: 'blue' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.some((e) => e.path === 'name')).toBe(true);
  });

  it('rejects name with uppercase letters', () => {
    const v = validateAgentFrontmatter({ name: 'My-Agent', description: 'D', model: 'inherit', color: 'blue' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.some((e) => e.path === 'name')).toBe(true);
  });

  it('rejects name with spaces', () => {
    const v = validateAgentFrontmatter({ name: 'my agent', description: 'D', model: 'inherit', color: 'blue' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.some((e) => e.path === 'name')).toBe(true);
  });

  // --- Never throws on garbage ---
  it('never throws on null input', () => {
    expect(() => validateAgentFrontmatter(null)).not.toThrow();
    expect(validateAgentFrontmatter(null).ok).toBe(false);
  });

  it('never throws on undefined input', () => {
    expect(() => validateAgentFrontmatter(undefined)).not.toThrow();
    expect(validateAgentFrontmatter(undefined).ok).toBe(false);
  });

  it('never throws on array input', () => {
    expect(() => validateAgentFrontmatter([])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// docs-writer agent — targeted frontmatter compliance test
// ---------------------------------------------------------------------------

describe('docs-writer agent frontmatter', () => {
  const DOCS_WRITER_PATH = join(REPO_ROOT, 'agents', 'docs-writer.md');

  it('passes full validateAgentFile check', () => {
    const result = validateAgentFile(DOCS_WRITER_PATH);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it('has name === "docs-writer"', () => {
    const parsed = parseAgentFrontmatter(readFileSync(DOCS_WRITER_PATH, 'utf8'));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.frontmatter['name']).toBe('docs-writer');
  });

  it('has color === "cyan"', () => {
    const parsed = parseAgentFrontmatter(readFileSync(DOCS_WRITER_PATH, 'utf8'));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.frontmatter['color']).toBe('cyan');
  });

  it('has model === "inherit"', () => {
    const parsed = parseAgentFrontmatter(readFileSync(DOCS_WRITER_PATH, 'utf8'));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.frontmatter['model']).toBe('inherit');
  });

  it('has tools as a comma-separated string (not array, not block scalar)', () => {
    const parsed = parseAgentFrontmatter(readFileSync(DOCS_WRITER_PATH, 'utf8'));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const tools = parsed.frontmatter['tools'];
      expect(typeof tools).toBe('string');
      expect(tools).not.toMatch(/^\[/);
      expect(tools).not.toBe('__BLOCK_SCALAR__');
      expect(tools).toContain(',');
    }
  });

  it('has description as a single-line string containing <example> and <commentary>', () => {
    const parsed = parseAgentFrontmatter(readFileSync(DOCS_WRITER_PATH, 'utf8'));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const desc = parsed.frontmatter['description'];
      expect(typeof desc).toBe('string');
      expect(desc).not.toBe('__BLOCK_SCALAR__');
      expect(desc).toContain('<example>');
      expect(desc).toContain('<commentary>');
    }
  });
});

// ---------------------------------------------------------------------------
// validateAgentFile
// ---------------------------------------------------------------------------

describe('validateAgentFile', () => {
  it('returns ok=false with read-error for a non-existent file', () => {
    const result = validateAgentFile('/absolutely/does/not/exist/agent.md');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.rule === 'read-error')).toBe(true);
      expect(result.file).toBe('/absolutely/does/not/exist/agent.md');
    }
  });

  it('attaches the file path to successful results', () => {
    const filePath = join(TEMPLATES_DIR, 'project-discovery.md');
    const result = validateAgentFile(filePath);
    expect(result.ok).toBe(true);
    expect(result.file).toBe(filePath);
  });

  it('never throws on garbage path', () => {
    expect(() => validateAgentFile(null)).not.toThrow();
    expect(() => validateAgentFile(undefined)).not.toThrow();
    expect(() => validateAgentFile('')).not.toThrow();
  });
});
