import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveSoul, loadAndResolveSoul } from '@lib/soul-resolve.mjs';
import { getDefaults, validateOwnerSections } from '@lib/owner-yaml.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SOUL_SESSION_START = join(
  new URL('.', import.meta.url).pathname,
  '../../skills/session-start/soul.md',
);

const SOUL_PLAN = join(
  new URL('.', import.meta.url).pathname,
  '../../skills/plan/soul.md',
);

// ---------------------------------------------------------------------------
// resolveSoul — unit tests (pure function, no I/O)
// ---------------------------------------------------------------------------

describe('resolveSoul', () => {
  it('replaces a single known slot with the value from ownerConfig', () => {
    const config = {
      owner: { language: 'de' },
      tone: { style: 'direct' },
      efficiency: { 'output-level': 'lite', preamble: 'minimal' },
    };
    const { resolved, warnings } = resolveSoul('Respond in {{owner.language}} always.', config);
    expect(resolved).toBe('Respond in de always.');
    expect(warnings).toHaveLength(0);
  });

  it('replaces multiple slots in one template pass', () => {
    const config = {
      owner: { language: 'en' },
      tone: { style: 'friendly' },
      efficiency: { 'output-level': 'ultra', preamble: 'verbose' },
    };
    const template =
      'Lang: {{owner.language}}, Tone: {{tone.style}}, Level: {{efficiency.output-level}}, Pre: {{efficiency.preamble}}.';
    const { resolved, warnings } = resolveSoul(template, config);
    expect(resolved).toBe('Lang: en, Tone: friendly, Level: ultra, Pre: verbose.');
    expect(warnings).toHaveLength(0);
  });

  it('falls back to defaults when ownerConfig is empty', () => {
    const defaults = getDefaults();
    const { resolved, warnings } = resolveSoul('{{owner.language}} {{tone.style}}', {});
    expect(resolved).toBe(`${defaults.owner.language} ${defaults.tone.style}`);
    expect(warnings).toHaveLength(0);
  });

  it('leaves unknown slot paths in place and adds a warning', () => {
    const config = {
      owner: { language: 'en' },
      tone: { style: 'neutral' },
      efficiency: { 'output-level': 'full', preamble: 'minimal' },
    };
    const { resolved, warnings } = resolveSoul('Hello {{owner.unknown-field}} world.', config);
    expect(resolved).toBe('Hello {{owner.unknown-field}} world.');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/unknown slot path/i);
    expect(warnings[0]).toContain('owner.unknown-field');
  });

  it('handles whitespace inside braces — {{ owner.language }}', () => {
    const config = {
      owner: { language: 'de' },
      tone: { style: 'neutral' },
      efficiency: { 'output-level': 'full', preamble: 'minimal' },
    };
    const { resolved, warnings } = resolveSoul('{{ owner.language }}', config);
    expect(resolved).toBe('de');
    expect(warnings).toHaveLength(0);
  });

  it('handles leading/trailing whitespace inside braces for other known slots', () => {
    const config = {
      owner: { language: 'en' },
      tone: { style: 'direct' },
      efficiency: { 'output-level': 'lite', preamble: 'minimal' },
    };
    const { resolved } = resolveSoul('{{  tone.style  }}', config);
    expect(resolved).toBe('direct');
  });

  it('leaves static content outside braces completely unchanged', () => {
    const config = {
      owner: { language: 'en' },
      tone: { style: 'neutral' },
      efficiency: { 'output-level': 'full', preamble: 'minimal' },
    };
    const template = '# Soul\n\nIdentity paragraph stays intact.\n\n{{tone.style}}\n';
    const { resolved } = resolveSoul(template, config);
    expect(resolved).toContain('# Soul\n\nIdentity paragraph stays intact.');
    expect(resolved).toContain('neutral');
    expect(resolved).not.toContain('{{tone.style}}');
  });

  it('round-trip: resolves all 4 documented slots in a single template', () => {
    const config = {
      owner: { language: 'de' },
      tone: { style: 'direct' },
      efficiency: { 'output-level': 'lite', preamble: 'minimal' },
    };
    const template =
      '{{owner.language}} {{tone.style}} {{efficiency.output-level}} {{efficiency.preamble}}';
    const { resolved, warnings } = resolveSoul(template, config);
    expect(resolved).toBe('de direct lite minimal');
    expect(warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// loadAndResolveSoul — integration tests (disk I/O)
// ---------------------------------------------------------------------------

describe('loadAndResolveSoul', () => {
  it('reads session-start/soul.md from disk and resolves slots with defaults when owner.yaml is absent', () => {
    const { resolved, source, warnings } = loadAndResolveSoul(SOUL_SESSION_START, {
      ownerConfigPath: '/tmp/nonexistent-owner-for-soul-resolve-test.yaml',
    });
    expect(source).toBe('defaults');
    expect(warnings).toHaveLength(0);
    // resolved content must not contain unresolved {{...}} for known slots
    expect(resolved).not.toMatch(/\{\{owner\.language\}\}/);
    expect(resolved).not.toMatch(/\{\{tone\.style\}\}/);
    expect(resolved).not.toMatch(/\{\{efficiency\.output-level\}\}/);
    expect(resolved).not.toMatch(/\{\{efficiency\.preamble\}\}/);
    // static content from soul.md should still be present
    expect(resolved).toContain('Session Orchestrator');
  });

  it('reads plan/soul.md from disk and resolves slots with defaults when owner.yaml is absent', () => {
    const { resolved, source } = loadAndResolveSoul(SOUL_PLAN, {
      ownerConfigPath: '/tmp/nonexistent-owner-for-soul-resolve-test.yaml',
    });
    expect(source).toBe('defaults');
    expect(resolved).not.toMatch(/\{\{owner\.language\}\}/);
    expect(resolved).toContain('Plan Skill');
  });
});

// ---------------------------------------------------------------------------
// session-start/soul.md — the file the coordinator reads RAW
//
// No runtime caller resolves slots (see soul-resolve.mjs header), so the bytes
// on disk are the instruction. These guard the two failure modes that made the
// output-level dial inert for ~15 months.
// ---------------------------------------------------------------------------

/** Raw bytes of the soul the session-start skill body tells the coordinator to read. */
function readSessionStartSoul() {
  return readFileSync(SOUL_SESSION_START, 'utf8');
}

/**
 * Output-level values the schema ACCEPTS, derived from product behaviour rather
 * than from a source-text regex: feed the exported validator a value it must
 * reject and read the enum back out of the error it raises.
 *
 * @returns {string[]}
 */
function schemaAcceptedOutputLevels() {
  const { sections } = validateOwnerSections({
    ...getDefaults(),
    efficiency: { 'output-level': '__definitely-not-a-level__', preamble: 'minimal' },
  });
  const message = (sections.efficiency?.errors ?? []).find((e) =>
    e.startsWith('efficiency.output-level must be one of'),
  );
  const match = message?.match(/must be one of (.+), got:/);
  // Fail loudly rather than silently returning [] — an empty enum would make the
  // parity assertion below vacuous in one direction.
  expect(match, `could not derive the output-level enum from: ${message}`).toBeTruthy();
  return match[1].split(',').map((s) => s.trim());
}

/** Level blocks declared in soul.md, keyed by the enum value in the heading. */
function declaredLevelBlocks(soul) {
  const headings = [...soul.matchAll(/^### output-level: (\S+)[ \t]*$/gm)];
  return headings.map((h, i) => {
    const start = h.index + h[0].length;
    const end = i + 1 < headings.length ? headings[i + 1].index : soul.length;
    return { level: h[1], body: soul.slice(start, end) };
  });
}

describe('session-start/soul.md — output-level dial', () => {
  it('leaves no unsubstituted {{slot}} in the bytes the coordinator reads', () => {
    // Bug: the coordinator reads soul.md directly, so a literal
    // "{{efficiency.output-level}}" reaches the model as an instruction that
    // means nothing. Nothing resolves it — there is no runtime caller.
    expect(readSessionStartSoul()).not.toMatch(/\{\{/);
  });

  it('declares exactly one block per schema-accepted output-level, and none for a rejected one', () => {
    // Bug: an operator sets efficiency.output-level to a value the schema
    // accepts but soul.md never mentions — the setting selects nothing and has
    // no observable effect. Fails closed in both directions (missing block AND
    // orphan block for a value the schema would reject).
    const declared = declaredLevelBlocks(readSessionStartSoul()).map((b) => b.level);
    expect([...declared].sort()).toEqual([...schemaAcceptedOutputLevels()].sort());
  });

  it('gives every level a numeric budget and a named escalation, not an exhortation', () => {
    // Bug: a level defined as "be shorter" is unobservable — nothing can be
    // over or under it, so the dial reads as advice and gets ignored. Each
    // block must carry a countable ceiling and a named way to get detail back.
    for (const { level, body } of declaredLevelBlocks(readSessionStartSoul())) {
      const budget = body.match(/^- Budget: (.+)$/m);
      expect(budget, `level "${level}" declares no "- Budget:" line`).toBeTruthy();
      expect(budget[1], `level "${level}" budget carries no number`).toMatch(/\d/);
      expect(body, `level "${level}" declares no "- Escalation:" line`).toMatch(
        /^- Escalation: \S+/m,
      );
    }
  });
});
