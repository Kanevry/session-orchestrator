/**
 * tests/scripts/lib/peer-cards/writer.test.mjs — Unit tests for #503 writer.mjs.
 *
 * Real fs against per-test tmp dirs. Verifies AC1 (first-write produces valid
 * frontmatter + body) and the EARS unwanted-behaviour gate (missing id → no
 * write, errors returned). Round-trips through validatePeerCardFrontmatter to
 * confirm the writer's output is schema-valid by construction.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { writePeerCard } from '@lib/peer-cards/writer.mjs';
import { validatePeerCardFrontmatter } from '@lib/peer-cards/schema.mjs';
import { parseStateMd } from '@lib/state-md/yaml-parser.mjs';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const USER_CARD = {
  frontmatter: { id: 'op-cardguy' },
  body: '## Preferences\n\nDirect tone.\n',
};

const AGENT_CARD = {
  frontmatter: { id: 'self-orchestrator' },
  body: '## Self-Notes\n\nAgent-side notes.\n',
};

// ─── Test suite ──────────────────────────────────────────────────────────────

describe('writePeerCard', () => {
  let tmpRoot;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-cards-writer-'));
  });

  afterEach(async () => {
    try {
      await rm(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // ─── AC1: first-write ─────────────────────────────────────────────────────

  it('AC1: writes USER.md with valid frontmatter and non-empty body', async () => {
    const result = await writePeerCard(tmpRoot, 'user', USER_CARD);

    expect(result.ok).toBe(true);
    expect(result.path).toBe(path.join(tmpRoot, '.orchestrator', 'peers', 'USER.md'));
    expect(await fileExists(result.path)).toBe(true);

    const content = await readFile(result.path, 'utf8');
    const parsed = parseStateMd(content);
    expect(parsed).not.toBe(null);
    expect(parsed.frontmatter.id).toBe('op-cardguy');
    expect(parsed.frontmatter.type).toBe('peer-card');
    expect(parsed.frontmatter.target).toBe('user');
    expect(typeof parsed.frontmatter.created).toBe('string');
    expect(typeof parsed.frontmatter.updated).toBe('string');
    expect(parsed.frontmatter.source_sessions).toEqual([]);
    expect(parsed.body).toContain('## Preferences');
  });

  it('AC1: writes AGENT.md with target=agent', async () => {
    const result = await writePeerCard(tmpRoot, 'agent', AGENT_CARD);

    expect(result.ok).toBe(true);
    expect(result.path).toBe(path.join(tmpRoot, '.orchestrator', 'peers', 'AGENT.md'));

    const content = await readFile(result.path, 'utf8');
    const parsed = parseStateMd(content);
    expect(parsed.frontmatter.target).toBe('agent');
    expect(parsed.frontmatter.id).toBe('self-orchestrator');
  });

  // ─── Round-trip schema validity ───────────────────────────────────────────

  it('written frontmatter validates against schema (round-trip)', async () => {
    const result = await writePeerCard(tmpRoot, 'user', USER_CARD);
    expect(result.ok).toBe(true);

    const content = await readFile(result.path, 'utf8');
    const parsed = parseStateMd(content);
    const validation = validatePeerCardFrontmatter(parsed.frontmatter);
    expect(validation.ok).toBe(true);
  });

  // ─── EARS unwanted-behaviour gate ─────────────────────────────────────────

  it('EARS: returns ok=false with errors when id is missing and writes nothing', async () => {
    const result = await writePeerCard(tmpRoot, 'user', {
      frontmatter: {},
      body: 'body without id',
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['peer-card missing required field: id']);

    const userPath = path.join(tmpRoot, '.orchestrator', 'peers', 'USER.md');
    expect(await fileExists(userPath)).toBe(false);
  });

  it('EARS: returns ok=false when frontmatter is empty (no id explicitly)', async () => {
    const result = await writePeerCard(tmpRoot, 'agent', { frontmatter: {}, body: '' });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBe('peer-card missing required field: id');
  });

  // ─── Auto-fill semantics ──────────────────────────────────────────────────

  it('auto-fills type=peer-card when caller omits it', async () => {
    const result = await writePeerCard(tmpRoot, 'user', {
      frontmatter: { id: 'op-cardguy' },
      body: 'x',
    });
    expect(result.ok).toBe(true);
    const parsed = parseStateMd(await readFile(result.path, 'utf8'));
    expect(parsed.frontmatter.type).toBe('peer-card');
  });

  it('auto-fills target from argument', async () => {
    const result = await writePeerCard(tmpRoot, 'agent', {
      frontmatter: { id: 'self-orchestrator' },
      body: 'x',
    });
    expect(result.ok).toBe(true);
    const parsed = parseStateMd(await readFile(result.path, 'utf8'));
    expect(parsed.frontmatter.target).toBe('agent');
  });

  it('auto-fills updated with current ISO timestamp when omitted', async () => {
    const before = new Date().toISOString();
    const result = await writePeerCard(tmpRoot, 'user', {
      frontmatter: { id: 'op-cardguy' },
      body: 'x',
    });
    const after = new Date().toISOString();
    expect(result.ok).toBe(true);
    const parsed = parseStateMd(await readFile(result.path, 'utf8'));
    expect(parsed.frontmatter.updated >= before).toBe(true);
    expect(parsed.frontmatter.updated <= after).toBe(true);
  });

  it('auto-fills created to mirror updated when omitted', async () => {
    const result = await writePeerCard(tmpRoot, 'user', {
      frontmatter: { id: 'op-cardguy' },
      body: 'x',
    });
    expect(result.ok).toBe(true);
    const parsed = parseStateMd(await readFile(result.path, 'utf8'));
    expect(parsed.frontmatter.created).toBe(parsed.frontmatter.updated);
  });

  it('auto-fills source_sessions to []', async () => {
    const result = await writePeerCard(tmpRoot, 'user', {
      frontmatter: { id: 'op-cardguy' },
      body: 'x',
    });
    expect(result.ok).toBe(true);
    const parsed = parseStateMd(await readFile(result.path, 'utf8'));
    expect(parsed.frontmatter.source_sessions).toEqual([]);
  });

  it('does NOT auto-fill id (EARS gate guard)', async () => {
    // Confirm omitting id triggers the gate (cross-check with EARS test above).
    const result = await writePeerCard(tmpRoot, 'user', {
      frontmatter: { type: 'peer-card', target: 'user' },
      body: 'x',
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('peer-card missing required field: id');
  });

  it('preserves caller-supplied created/updated when provided', async () => {
    const result = await writePeerCard(tmpRoot, 'user', {
      frontmatter: {
        id: 'op-cardguy',
        created: '2026-01-01T00:00:00Z',
        updated: '2026-05-23T12:00:00Z',
      },
      body: 'x',
    });
    expect(result.ok).toBe(true);
    const parsed = parseStateMd(await readFile(result.path, 'utf8'));
    expect(parsed.frontmatter.created).toBe('2026-01-01T00:00:00Z');
    expect(parsed.frontmatter.updated).toBe('2026-05-23T12:00:00Z');
  });

  // ─── Input validation (throws) ────────────────────────────────────────────

  it('throws when target is invalid', async () => {
    await expect(
      writePeerCard(tmpRoot, 'invalid', USER_CARD),
    ).rejects.toThrow(/target must be 'user' or 'agent'/);
  });

  it('throws when repoRoot is missing', async () => {
    await expect(
      writePeerCard(undefined, 'user', USER_CARD),
    ).rejects.toThrow(/repoRoot is required/);
  });

  it('throws when repoRoot is empty string', async () => {
    await expect(
      writePeerCard('', 'user', USER_CARD),
    ).rejects.toThrow(/repoRoot is required/);
  });

  it('throws when card is not an object', async () => {
    await expect(
      writePeerCard(tmpRoot, 'user', 'not-an-object'),
    ).rejects.toThrow(/card must be an object/);
  });

  // ─── Re-write semantics ───────────────────────────────────────────────────

  it('re-writes overwrite prior content', async () => {
    const first = await writePeerCard(tmpRoot, 'user', {
      frontmatter: { id: 'op-cardguy' },
      body: 'first version',
    });
    expect(first.ok).toBe(true);

    const second = await writePeerCard(tmpRoot, 'user', {
      frontmatter: { id: 'op-cardguy' },
      body: 'second version',
    });
    expect(second.ok).toBe(true);

    const content = await readFile(first.path, 'utf8');
    expect(content).toContain('second version');
    expect(content).not.toContain('first version');
  });
});

