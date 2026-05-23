/**
 * tests/scripts/lib/peer-cards/reader.test.mjs — Unit tests for #503 reader.mjs.
 *
 * Uses real fs against a per-test tmp dir for isolation. The reader's contract is
 * to be read-only and never throw on malformed / missing files — these tests
 * verify both the happy parse path and the graceful-degradation behaviour.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { readPeerCards } from '@lib/peer-cards/reader.mjs';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VALID_USER_BODY = `---
id: op-cardguy
type: peer-card
target: user
created: 2026-05-01T10:00:00Z
updated: 2026-05-23T12:00:00Z
source_sessions: ["session-2026-05-23"]
---

## Preferences

Direct tone.
`;

const VALID_AGENT_BODY = `---
id: self-orchestrator
type: peer-card
target: agent
created: 2026-05-01T10:00:00Z
updated: 2026-05-23T12:00:00Z
source_sessions: []
---

## Self-Notes

Agent-side notes.
`;

const STALE_USER_BODY = `---
id: op-cardguy
type: peer-card
target: user
created: 2026-01-01T00:00:00Z
updated: 2026-04-18T12:00:00Z
source_sessions: []
---

Stale.
`;

const MALFORMED_FM_BODY = `---
type: peer-card
target: user
created: 2026-05-01T10:00:00Z
updated: 2026-05-23T12:00:00Z
---

Missing id.
`;

const NO_FRONTMATTER_BODY = `Just markdown, no frontmatter at all.
`;

// ─── Test suite ──────────────────────────────────────────────────────────────

describe('readPeerCards', () => {
  let tmpRoot;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'peer-cards-reader-'));
  });

  afterEach(async () => {
    try {
      await rm(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('returns exists=false when .orchestrator/peers/ does not exist', async () => {
    const result = await readPeerCards(tmpRoot);
    expect(result.exists).toBe(false);
    expect(result.user).toBe(null);
    expect(result.agent).toBe(null);
    expect(result.peersDir).toBe(path.join(tmpRoot, '.orchestrator', 'peers'));
  });

  it('returns exists=true with both cards null when peersDir is empty', async () => {
    await mkdir(path.join(tmpRoot, '.orchestrator', 'peers'), { recursive: true });
    const result = await readPeerCards(tmpRoot);
    expect(result.exists).toBe(true);
    expect(result.user).toBe(null);
    expect(result.agent).toBe(null);
  });

  it('parses USER.md correctly with valid frontmatter', async () => {
    const peersDir = path.join(tmpRoot, '.orchestrator', 'peers');
    await mkdir(peersDir, { recursive: true });
    await writeFile(path.join(peersDir, 'USER.md'), VALID_USER_BODY, 'utf8');

    const now = new Date('2026-05-23T12:00:00Z');
    const result = await readPeerCards(tmpRoot, { now });

    expect(result.exists).toBe(true);
    expect(result.user).not.toBe(null);
    expect(result.user.frontmatter.id).toBe('op-cardguy');
    expect(result.user.frontmatter.type).toBe('peer-card');
    expect(result.user.frontmatter.target).toBe('user');
    expect(result.user.frontmatter.updated).toBe('2026-05-23T12:00:00Z');
    expect(result.user.body).toContain('## Preferences');
    expect(result.user.stalenessDays).toBe(0);
    expect(result.user.isStale).toBe(false);
    expect(result.user.validation.ok).toBe(true);
  });

  it('parses USER.md and AGENT.md in parallel', async () => {
    const peersDir = path.join(tmpRoot, '.orchestrator', 'peers');
    await mkdir(peersDir, { recursive: true });
    await writeFile(path.join(peersDir, 'USER.md'), VALID_USER_BODY, 'utf8');
    await writeFile(path.join(peersDir, 'AGENT.md'), VALID_AGENT_BODY, 'utf8');

    const now = new Date('2026-05-23T12:00:00Z');
    const result = await readPeerCards(tmpRoot, { now });

    expect(result.user).not.toBe(null);
    expect(result.agent).not.toBe(null);
    expect(result.user.frontmatter.target).toBe('user');
    expect(result.agent.frontmatter.target).toBe('agent');
    expect(result.agent.frontmatter.id).toBe('self-orchestrator');
  });

  it('flags malformed frontmatter (missing id) with validation.ok=false', async () => {
    const peersDir = path.join(tmpRoot, '.orchestrator', 'peers');
    await mkdir(peersDir, { recursive: true });
    await writeFile(path.join(peersDir, 'USER.md'), MALFORMED_FM_BODY, 'utf8');

    const now = new Date('2026-05-23T12:00:00Z');
    const result = await readPeerCards(tmpRoot, { now });

    expect(result.user).not.toBe(null);
    expect(result.user.validation.ok).toBe(false);
    expect(result.user.validation.errors.some((e) => e.startsWith('id:'))).toBe(true);
  });

  it('returns null frontmatter and validation.ok=false for body with no frontmatter', async () => {
    const peersDir = path.join(tmpRoot, '.orchestrator', 'peers');
    await mkdir(peersDir, { recursive: true });
    await writeFile(path.join(peersDir, 'USER.md'), NO_FRONTMATTER_BODY, 'utf8');

    const now = new Date('2026-05-23T12:00:00Z');
    const result = await readPeerCards(tmpRoot, { now });

    expect(result.user).not.toBe(null);
    expect(result.user.frontmatter).toBe(null);
    expect(result.user.validation.ok).toBe(false);
    expect(result.user.validation.errors).toEqual(['no frontmatter or malformed YAML']);
    expect(result.user.stalenessDays).toBe(Infinity);
    expect(result.user.isStale).toBe(true);
  });

  it('flags a stale card (>30 days since updated) with isStale=true', async () => {
    const peersDir = path.join(tmpRoot, '.orchestrator', 'peers');
    await mkdir(peersDir, { recursive: true });
    await writeFile(path.join(peersDir, 'USER.md'), STALE_USER_BODY, 'utf8');

    const now = new Date('2026-05-23T12:00:00Z'); // 35 days after 2026-04-18
    const result = await readPeerCards(tmpRoot, { now });

    expect(result.user).not.toBe(null);
    expect(result.user.stalenessDays).toBe(35);
    expect(result.user.isStale).toBe(true);
  });

  it('returns null for the missing file when only one of the two exists', async () => {
    const peersDir = path.join(tmpRoot, '.orchestrator', 'peers');
    await mkdir(peersDir, { recursive: true });
    await writeFile(path.join(peersDir, 'USER.md'), VALID_USER_BODY, 'utf8');

    const now = new Date('2026-05-23T12:00:00Z');
    const result = await readPeerCards(tmpRoot, { now });

    expect(result.user).not.toBe(null);
    expect(result.agent).toBe(null);
  });

  it('throws when repoRoot is missing', async () => {
    await expect(readPeerCards()).rejects.toThrow(/repoRoot is required/);
  });

  it('throws when repoRoot is empty string', async () => {
    await expect(readPeerCards('')).rejects.toThrow(/repoRoot is required/);
  });

  it('throws when repoRoot is not a string', async () => {
    await expect(readPeerCards(42)).rejects.toThrow(/repoRoot is required/);
  });
});
