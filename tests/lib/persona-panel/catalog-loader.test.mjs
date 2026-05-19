/**
 * tests/lib/persona-panel/catalog-loader.test.mjs
 *
 * Vitest tests for scripts/lib/persona-panel/catalog-loader.mjs (issue #457).
 *
 * Written against the actual implemented API:
 *   loadCatalog(opts?) — opts.projectRoot controls which root to scan under.
 *   validatePersonaSpec(rawSpec, sourcePath) — pure validator; returns {ok, ...}.
 *   preCheckOutputContract(schema) — pure structural pre-check; returns {ok, errors?}.
 *   SAFE_PERSONA_NAME_RE — exported regex for persona name validation.
 *
 * loadCatalog resolves the personas root as:
 *   path.join(opts.projectRoot ?? findProjectRoot(), opts.personasDir ?? '.claude/personas')
 *
 * Tests always pass { projectRoot: tmp } so they point at a tmpdir rather than
 * the real project root.
 *
 * Real tiers (from ALLOWED_TIERS): domain-expert, buyer-persona, auditor, reviewer.
 *
 * Required frontmatter keys (REQUIRED_KEYS in catalog-loader.mjs):
 *   name, schema_version, version, role, model, output_contract, evaluation_criteria, tier
 *
 * Covers (16 tests):
 *  1.  happy-path: 2-persona catalog → Map size 2, keys match persona names
 *  2.  empty-dir: `.claude/personas/` exists, no `.md` files → Map is empty (size 0)
 *  3.  dir-missing: no `.claude/personas/` → throws with "not found" message
 *  4.  malformed-YAML: broken frontmatter → throws with filename info
 *  5.  schema_version-missing → throws/validation errors
 *  6.  schema_version-unknown (999) → throws/validation errors
 *  7.  name-missing → throws/validation errors
 *  8.  model-missing → throws/validation errors
 *  9.  duplicate-name across two files → throws DuplicateNameError with both paths
 *  10. name-not-matching-SAFE_PERSONA_NAME_RE → rejects (path traversal defense)
 *  11. unknown-frontmatter-key → rejects naming the unknown key
 *  12. model-allowlist H2: approved model → accept; unapproved → reject; alias → accept
 *  13. output_contract pre-check H3: forbidden keywords → reject; flat schema → accept
 *  14. symlink-defense L3: symlink to out-of-dir file → rejected
 *  15. evaluation_criteria item > 512 chars → rejects
 *  16. tier outside enum → rejects; all 4 valid tiers → accept
 *
 * Falsification check: every test asserts on the contract output value or the error
 * type/message — removing the implementation causes import failure or assertion failure.
 *
 * macOS `/var/folders → /private/var/folders` symlink: use realpathSync(tmpdir())
 * per #477 learning (conf 0.85).
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
} from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Module-under-test — dynamic import tolerates parallel-agent not-yet-landed
// ---------------------------------------------------------------------------

let loadCatalog;
let _loadPersona;
let validatePersonaSpec;
let preCheckOutputContract;
let _SAFE_PERSONA_NAME_RE;
let importError = null;

beforeAll(async () => {
  try {
    const mod = await import('../../../scripts/lib/persona-panel/catalog-loader.mjs');
    ({
      loadCatalog,
      loadPersona: _loadPersona,
      validatePersonaSpec,
      preCheckOutputContract,
      SAFE_PERSONA_NAME_RE: _SAFE_PERSONA_NAME_RE,
    } = mod);
  } catch (e) {
    importError = e;
  }
  // Approach A (#483 Q1-LOW-4): loud failure if the lib failed to import — no silent skips.
  if (importError) {
    throw new Error(`catalog-loader failed to import — test file cannot run: ${importError.message}`);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** macOS-safe tmpdir: resolves /var → /private/var symlink (#477 learning). */
function makeTmp() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'catalog-loader-test-')));
}

/**
 * Build a minimal valid persona YAML frontmatter + body string.
 * All REQUIRED_KEYS present by default (name, schema_version, version, role,
 * model, output_contract, evaluation_criteria, tier).
 *
 * Callers may override any field. Pass a key with value `null` to omit it.
 */
function minimalContent(overrides = {}) {
  const defaults = {
    name: 'test-persona-one',
    schema_version: 1,
    version: '1.0',
    role: 'Domain expert for testing',
    model: 'claude-opus-4-7',
    // output_contract must be a real YAML mapping — plain string is rejected
    // by preCheckOutputContract which requires typeof === 'object'.
    output_contract: { type: 'object' },
    evaluation_criteria: ['Accurate and relevant feedback'],
    tier: 'domain-expert',
  };

  const merged = { ...defaults, ...overrides };

  const lines = ['---'];
  for (const [k, v] of Object.entries(merged)) {
    if (v === null) continue; // allow callers to omit a field

    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) {
        lines.push(`  - "${String(item).replace(/"/g, '\\"')}"`);
      }
    } else if (typeof v === 'object') {
      // Inline JSON-compatible YAML (js-yaml CORE_SCHEMA accepts JSON syntax)
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else {
      lines.push(`${k}: ${typeof v === 'string' ? `"${v.replace(/"/g, '\\"')}"` : v}`);
    }
  }
  lines.push('---', '', 'Persona body.');
  return lines.join('\n');
}

/** Write a `.claude/personas/` directory with files into a tmp root and return the dir path. */
function makePersonasDir(root, files = {}) {
  const dir = join(root, '.claude', 'personas');
  mkdirSync(dir, { recursive: true });
  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(dir, filename), content, 'utf8');
  }
  return dir;
}

// ---------------------------------------------------------------------------
// State — fresh tmpdir per test
// ---------------------------------------------------------------------------

let tmp;

beforeEach(() => {
  tmp = makeTmp();
});

afterEach(() => {
  if (tmp && existsSync(tmp)) {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 1: happy-path — 2 personas → Map size 2, keys = persona names
// ---------------------------------------------------------------------------

describe('loadCatalog — happy path', () => {
  it('returns a Map of size 2 with persona names as keys when 2 valid persona files present', async () => {
makePersonasDir(tmp, {
      'persona-alpha.md': minimalContent({ name: 'persona-alpha' }),
      'persona-beta.md': minimalContent({ name: 'persona-beta' }),
    });

    const catalog = await loadCatalog({ projectRoot: tmp });
    expect(catalog).toBeInstanceOf(Map);
    expect(catalog.size).toBe(2);
    expect(catalog.has('persona-alpha')).toBe(true);
    expect(catalog.has('persona-beta')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 2: empty-dir → empty Map (loadCatalog does NOT throw on empty dir per source)
// ---------------------------------------------------------------------------

describe('loadCatalog — empty personas directory', () => {
  it('returns an empty Map when the personas directory exists but contains no .md files', async () => {
makePersonasDir(tmp, {});

    const catalog = await loadCatalog({ projectRoot: tmp });
    expect(catalog).toBeInstanceOf(Map);
    expect(catalog.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 3: dir-missing → throws with "not found" / "personas directory" message
// ---------------------------------------------------------------------------

describe('loadCatalog — missing personas directory', () => {
  it('throws an error with "not found" when .claude/personas does not exist', async () => {
// No .claude/personas created — tmp exists but sub-dirs do not
    await expect(loadCatalog({ projectRoot: tmp })).rejects.toThrow(
      /not found|ENOENT|personas.*directory/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Test 4: malformed YAML → throws referencing the filename
// ---------------------------------------------------------------------------

describe('loadCatalog — malformed YAML frontmatter', () => {
  it('throws an error that references the filename when YAML frontmatter is invalid', async () => {
makePersonasDir(tmp, {
      'broken.md': '---\nkey: [unclosed bracket\n---\n',
    });

    let caught;
    try {
      await loadCatalog({ projectRoot: tmp });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(caught.message).toMatch(/broken\.md/);
  });
});

// ---------------------------------------------------------------------------
// Test 5: schema_version missing → rejects
// ---------------------------------------------------------------------------

describe('validatePersonaSpec — schema_version missing', () => {
  it('returns {ok: false} with an error mentioning schema_version when the field is absent', () => {
const spec = {
      name: 'no-version-persona',
      version: '1.0',
      role: 'tester',
      model: 'claude-opus-4-7',
      output_contract: { type: 'object' },
      evaluation_criteria: ['Good feedback'],
      tier: 'domain-expert',
      // schema_version intentionally omitted
    };

    const result = validatePersonaSpec(spec, '/tmp/no-version.md');
    expect(result.ok).toBe(false);
    const errorMessages = result.errors.map((e) => e.message).join(' ');
    expect(errorMessages).toMatch(/schema_version/i);
  });
});

// ---------------------------------------------------------------------------
// Test 6: schema_version unknown (999) → rejects
// ---------------------------------------------------------------------------

describe('validatePersonaSpec — schema_version unknown', () => {
  it('returns {ok: false} with an error when schema_version is 999 (unrecognised)', () => {
const spec = {
      name: 'bad-version-persona',
      schema_version: 999,
      version: '1.0',
      role: 'tester',
      model: 'claude-opus-4-7',
      output_contract: { type: 'object' },
      evaluation_criteria: ['Good feedback'],
      tier: 'domain-expert',
    };

    const result = validatePersonaSpec(spec, '/tmp/bad-version.md');
    expect(result.ok).toBe(false);
    const errorMessages = result.errors.map((e) => e.message).join(' ');
    expect(errorMessages).toMatch(/schema_version/i);
  });
});

// ---------------------------------------------------------------------------
// Test 7: name missing → rejects
// ---------------------------------------------------------------------------

describe('validatePersonaSpec — name missing', () => {
  it('returns {ok: false} with an error mentioning "name" when the name field is absent', () => {
const spec = {
      schema_version: 1,
      version: '1.0',
      role: 'tester',
      model: 'claude-opus-4-7',
      output_contract: { type: 'object' },
      evaluation_criteria: ['Good feedback'],
      tier: 'domain-expert',
      // name intentionally omitted
    };

    const result = validatePersonaSpec(spec, '/tmp/no-name.md');
    expect(result.ok).toBe(false);
    const errorMessages = result.errors.map((e) => e.message + e.path).join(' ');
    expect(errorMessages).toMatch(/\bname\b/i);
  });
});

// ---------------------------------------------------------------------------
// Test 8: model missing → rejects
// ---------------------------------------------------------------------------

describe('validatePersonaSpec — model missing', () => {
  it('returns {ok: false} with an error mentioning "model" when the model field is absent', () => {
const spec = {
      name: 'no-model-persona',
      schema_version: 1,
      version: '1.0',
      role: 'tester',
      output_contract: { type: 'object' },
      evaluation_criteria: ['Good feedback'],
      tier: 'domain-expert',
      // model intentionally omitted
    };

    const result = validatePersonaSpec(spec, '/tmp/no-model.md');
    expect(result.ok).toBe(false);
    const errorMessages = result.errors.map((e) => e.message + e.path).join(' ');
    expect(errorMessages).toMatch(/\bmodel\b/i);
  });
});

// ---------------------------------------------------------------------------
// Test 9: duplicate-name across two files → DuplicateNameError with both paths
// ---------------------------------------------------------------------------

describe('loadCatalog — duplicate persona name', () => {
  it('throws an error mentioning both file paths when two files declare the same persona name', async () => {
makePersonasDir(tmp, {
      'first.md': minimalContent({ name: 'same-name' }),
      'second.md': minimalContent({ name: 'same-name' }),
    });

    let caught;
    try {
      await loadCatalog({ projectRoot: tmp });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    const msg = caught.message ?? '';
    // Both filenames must appear in the error message
    expect(msg).toMatch(/first\.md/);
    expect(msg).toMatch(/second\.md/);
  });
});

// ---------------------------------------------------------------------------
// Test 10: name fails SAFE_PERSONA_NAME_RE (path traversal) → rejects
// ---------------------------------------------------------------------------

describe('validatePersonaSpec — name fails SAFE_PERSONA_NAME_RE', () => {
  it('returns {ok: false} with a format error for a name containing path traversal characters', () => {
const spec = {
      name: '../etc/shadow',
      schema_version: 1,
      version: '1.0',
      role: 'attacker',
      model: 'claude-opus-4-7',
      output_contract: { type: 'object' },
      evaluation_criteria: ['Criteria'],
      tier: 'domain-expert',
    };

    const result = validatePersonaSpec(spec, '/tmp/traversal.md');
    expect(result.ok).toBe(false);
    const errorMessages = result.errors.map((e) => e.message + e.rule).join(' ');
    expect(errorMessages).toMatch(/name|format|SAFE_PERSONA_NAME_RE/i);
  });
});

// ---------------------------------------------------------------------------
// Test 11: unknown frontmatter key → rejects, naming the unknown key
// ---------------------------------------------------------------------------

describe('validatePersonaSpec — unknown frontmatter key', () => {
  it('returns {ok: false} naming the unknown key when frontmatter contains an unrecognised field', () => {
const spec = {
      name: 'bogus-key-persona',
      schema_version: 1,
      version: '1.0',
      role: 'tester',
      model: 'claude-opus-4-7',
      output_contract: { type: 'object' },
      evaluation_criteria: ['Criteria'],
      tier: 'domain-expert',
      bogus_unknown_key: true,
    };

    const result = validatePersonaSpec(spec, '/tmp/bogus-key.md');
    expect(result.ok).toBe(false);
    const errorMessages = result.errors.map((e) => e.message).join(' ');
    expect(errorMessages).toMatch(/bogus_unknown_key/);
  });
});

// ---------------------------------------------------------------------------
// Test 12: model allowlist enforcement (H2)
// ---------------------------------------------------------------------------

describe('validatePersonaSpec — model allowlist (H2)', () => {
  it('returns {ok: true} for a persona declaring an approved full model ID (claude-opus-4-7)', () => {
const spec = {
      name: 'approved-model-persona',
      schema_version: 1,
      version: '1.0',
      role: 'tester',
      model: 'claude-opus-4-7',
      output_contract: { type: 'object' },
      evaluation_criteria: ['Criteria'],
      tier: 'domain-expert',
    };

    const result = validatePersonaSpec(spec, '/tmp/approved.md');
    expect(result.ok).toBe(true);
  });

  it('returns {ok: false} with model-allowlist error for an unrecognised model ID', () => {
const spec = {
      name: 'evil-model-persona',
      schema_version: 1,
      version: '1.0',
      role: 'tester',
      model: 'claude-evil-99-99',
      output_contract: { type: 'object' },
      evaluation_criteria: ['Criteria'],
      tier: 'domain-expert',
    };

    const result = validatePersonaSpec(spec, '/tmp/evil.md');
    expect(result.ok).toBe(false);
    const errorMessages = result.errors.map((e) => e.message).join(' ');
    expect(errorMessages).toMatch(/model/i);
  });

  it('returns {ok: true} for a persona declaring the approved alias "opus"', () => {
const spec = {
      name: 'alias-model-persona',
      schema_version: 1,
      version: '1.0',
      role: 'tester',
      model: 'opus',
      output_contract: { type: 'object' },
      evaluation_criteria: ['Criteria'],
      tier: 'domain-expert',
    };

    const result = validatePersonaSpec(spec, '/tmp/alias.md');
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 13: output_contract pre-check — forbidden and allowed schema keywords
// ---------------------------------------------------------------------------

describe('preCheckOutputContract — structural pre-check (H3)', () => {
  it.each([
    ['$ref forbidden', { $ref: '#/foo' }],
    ['$defs forbidden', { $defs: { foo: { type: 'string' } }, type: 'object' }],
    ['allOf forbidden', { allOf: [{ type: 'string' }] }],
    ['anyOf forbidden', { anyOf: [{ type: 'string' }, { type: 'number' }] }],
    ['oneOf forbidden', { oneOf: [{ type: 'string' }] }],
  ])('%s returns {ok: false, errors containing forbidden keyword info}', (_label, schema) => {
const result = preCheckOutputContract(schema);
    expect(result.ok).toBe(false);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it.each([
    ['flat enum allowed', { type: 'string', enum: ['a', 'b'] }],
    ['flat properties with additionalProperties:false allowed', { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false }],
    ['additionalProperties:false alone allowed', { type: 'object', additionalProperties: false }],
    ['simple type-only object allowed', { type: 'string' }],
  ])('%s returns {ok: true}', (_label, schema) => {
const result = preCheckOutputContract(schema);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 14: symlink defense (L3) — symlink to out-of-dir file → rejected
// ---------------------------------------------------------------------------

describe('loadCatalog — symlink defense (L3)', () => {
  it('rejects a .md file that is a symlink (symlink must not appear in catalog)', async () => {
const personasDir = join(tmp, '.claude', 'personas');
    mkdirSync(personasDir, { recursive: true });

    // Write a real valid persona so we can distinguish symlink-rejection from empty-catalog
    writeFileSync(
      join(personasDir, 'real-persona.md'),
      minimalContent({ name: 'real-persona' }),
      'utf8',
    );

    // Symlink to /etc/hosts (always present on macOS/Linux)
    try {
      symlinkSync('/etc/hosts', join(personasDir, 'symlink.md'));
    } catch {
      // Skip on platforms that disallow symlinks (e.g. Windows without admin rights)
      return;
    }

    // loadCatalog must either throw about the symlink OR
    // succeed while NOT including a persona named "symlink" in the catalog.
    let caught;
    let catalog;
    try {
      catalog = await loadCatalog({ projectRoot: tmp });
    } catch (e) {
      caught = e;
    }

    if (caught) {
      // Throw path: symlink rejected outright — error must mention symlink or the path
      expect(caught.message ?? '').toMatch(/symlink|not.*symbolic|persona.*file/i);
    } else {
      // Silent-skip path: symlink must not be in the catalog
      expect(catalog.has('symlink')).toBe(false);
      // The real persona must still be loaded
      expect(catalog.has('real-persona')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Test 15: evaluation_criteria item > 512 chars → rejects
// ---------------------------------------------------------------------------

describe('validatePersonaSpec — evaluation_criteria item length limit', () => {
  it('returns {ok: false} with a maxLength error when a criterion exceeds 512 characters', () => {
const longCriterion = 'x'.repeat(513);

    const spec = {
      name: 'long-criterion-persona',
      schema_version: 1,
      version: '1.0',
      role: 'tester',
      model: 'claude-opus-4-7',
      output_contract: { type: 'object' },
      evaluation_criteria: [longCriterion],
      tier: 'domain-expert',
    };

    const result = validatePersonaSpec(spec, '/tmp/long-criterion.md');
    expect(result.ok).toBe(false);
    const errorMessages = result.errors.map((e) => e.message + e.rule).join(' ');
    expect(errorMessages).toMatch(/evaluation_criteria|criterion|512|maxLength/i);
  });
});

// ---------------------------------------------------------------------------
// Test 16: tier validation — reject invalid, accept all 4 valid values
// ---------------------------------------------------------------------------

describe('validatePersonaSpec — tier enum validation', () => {
  it('returns {ok: false} with a tier error for tier value "rogue" (not in enum)', () => {
    const spec = {
      name: 'bad-tier-persona',
      schema_version: 1,
      version: '1.0',
      role: 'tester',
      model: 'claude-opus-4-7',
      output_contract: { type: 'object' },
      evaluation_criteria: ['Criteria'],
      tier: 'rogue',
    };

    const result = validatePersonaSpec(spec, '/tmp/bad-tier.md');
    expect(result.ok).toBe(false);
    const errorMessages = result.errors.map((e) => e.message + e.rule).join(' ');
    expect(errorMessages).toMatch(/tier|rogue|enum/i);
  });

  it.each([
    ['domain-expert'],
    ['buyer-persona'],
    ['auditor'],
    ['compliance'],   // Q1-LOW-5 — was missing from original 4-entry list
    ['reviewer'],
    ['custom'],        // Q1-LOW-5 — was missing from original 4-entry list
  ])('returns {ok: true} for valid tier value "%s"', (tier) => {
    const spec = {
      name: `tier-${tier}-persona`,
      schema_version: 1,
      version: '1.0',
      role: 'tester',
      model: 'claude-opus-4-7',
      output_contract: { type: 'object' },
      evaluation_criteria: ['Criteria'],
      tier,
    };

    const result = validatePersonaSpec(spec, `/tmp/tier-${tier}.md`);
    expect(result.ok).toBe(true);
  });
});
