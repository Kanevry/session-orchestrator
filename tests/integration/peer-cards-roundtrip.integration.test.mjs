/**
 * tests/integration/peer-cards-roundtrip.integration.test.mjs
 *
 * Integration test for #503 peer-cards covering three concerns bundled under
 * #530:
 *   - MED-2:  Read → Merge → Write disk round-trip (full 5-step E2E).
 *   - Q5 AC3: session-start staleness banner against a real on-disk stale card.
 *   - Q5 AC4: vault-sync validator accepts peer-card type written by writer.mjs.
 *
 * Unit tests (tests/scripts/lib/peer-cards/*.test.mjs) exercise each helper
 * with synthetic strings + mocked fs. This file is the load-bearing E2E that
 * proves the three helpers compose correctly through actual mkdtemp + writer
 * + reader + on-disk vault-sync subprocess.
 *
 * Cross-references:
 *   - scripts/lib/peer-cards/{reader,writer,merger,staleness-banner,schema}.mjs
 *   - skills/vault-sync/validator.mjs (CLI subprocess, --mode=warn for safety)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { readPeerCards } from '@lib/peer-cards/reader.mjs';
import { writePeerCard } from '@lib/peer-cards/writer.mjs';
import { mergePeerCard } from '@lib/peer-cards/merger.mjs';
import { checkPeerCardsStaleness } from '@lib/peer-cards/staleness-banner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const VALIDATOR_MJS = join(REPO_ROOT, 'skills/vault-sync/validator.mjs');
const VALIDATOR_CWD = join(REPO_ROOT, 'skills/vault-sync');

describe('peer-cards integration (MED-2 + Q5 AC3 + Q5 AC4)', () => {
  let tmpRepo;

  beforeEach(() => {
    tmpRepo = mkdtempSync(join(tmpdir(), 'so-peer-cards-it-'));
  });

  afterEach(() => {
    rmSync(tmpRepo, { recursive: true, force: true });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // MED-2: Read → Merge → Write disk round-trip
  // ─────────────────────────────────────────────────────────────────────────

  describe('MED-2: 5-step disk roundtrip preserves hand-text bytes', () => {
    it('write → read → merge → write merged → re-read preserves hand text + applies managed update', async () => {
      // Step 1: write initial card with hand text + a single managed section
      const handIntro = 'Hand-written intro paragraph that must survive merges.';
      const handFooter = 'Hand-written footer that must also survive.';
      const initialBody = [
        handIntro,
        '',
        '<!-- BEGIN MANAGED: preferences -->',
        'prefers terse output',
        '<!-- END MANAGED: preferences -->',
        '',
        handFooter,
      ].join('\n');

      const initialCard = {
        frontmatter: {
          id: 'usr-roundtrip',
          type: 'peer-card',
          target: 'user',
          created: '2026-05-23T00:00:00Z',
          updated: '2026-05-23T00:00:00Z',
          source_sessions: [],
        },
        body: initialBody,
      };
      const writeResult = await writePeerCard(tmpRepo, 'user', initialCard);
      expect(writeResult).toEqual({
        ok: true,
        path: join(tmpRepo, '.orchestrator', 'peers', 'USER.md'),
      });

      // Step 2: read back
      const readBack = await readPeerCards(tmpRepo);
      expect(readBack.exists).toBe(true);
      expect(readBack.user).not.toBeNull();
      expect(readBack.user.validation).toEqual({ ok: true, data: expect.any(Object) });
      expect(readBack.user.frontmatter.id).toBe('usr-roundtrip');
      expect(readBack.user.frontmatter.type).toBe('peer-card');
      expect(readBack.user.frontmatter.target).toBe('user');
      expect(readBack.user.body).toContain(handIntro);
      expect(readBack.user.body).toContain(handFooter);
      expect(readBack.user.body).toContain('<!-- BEGIN MANAGED: preferences -->');

      // Step 3: merge with new managed update for the existing section
      const mergeResult = mergePeerCard(readBack.user.body, {
        preferences: 'prefers terse output\nprefers code examples',
      });
      expect(mergeResult.conflicts).toEqual([]);
      expect(mergeResult.stats).toEqual({ preserved: 2, replaced: 1, appended: 0 });
      expect(mergeResult.body).toContain(handIntro);
      expect(mergeResult.body).toContain(handFooter);
      expect(mergeResult.body).toContain('prefers code examples');

      // Step 4: write merged
      const mergedCard = {
        frontmatter: {
          ...readBack.user.frontmatter,
          updated: '2026-05-23T01:00:00Z',
        },
        body: mergeResult.body,
      };
      const reWriteResult = await writePeerCard(tmpRepo, 'user', mergedCard);
      expect(reWriteResult).toEqual({
        ok: true,
        path: join(tmpRepo, '.orchestrator', 'peers', 'USER.md'),
      });

      // Step 5: re-read and verify hand text bytes preserved + merged content visible
      const reRead = await readPeerCards(tmpRepo);
      expect(reRead.user).not.toBeNull();
      expect(reRead.user.validation.ok).toBe(true);
      expect(reRead.user.frontmatter.updated).toBe('2026-05-23T01:00:00Z');
      expect(reRead.user.body).toContain(handIntro);
      expect(reRead.user.body).toContain(handFooter);
      expect(reRead.user.body).toContain('prefers terse output');
      expect(reRead.user.body).toContain('prefers code examples');

      // Byte-level: hand-owned regions must NOT have been mutated by the merge round-trip.
      // Slice the body around the managed sentinel boundaries and assert exact match.
      const beginIdx = reRead.user.body.indexOf('<!-- BEGIN MANAGED: preferences -->');
      const endIdx =
        reRead.user.body.indexOf('<!-- END MANAGED: preferences -->') +
        '<!-- END MANAGED: preferences -->'.length;
      expect(beginIdx).toBeGreaterThan(-1);
      const handBefore = reRead.user.body.slice(0, beginIdx);
      const handAfter = reRead.user.body.slice(endIdx);
      // Hand intro is preserved verbatim (including the trailing blank line we wrote).
      expect(handBefore).toBe(handIntro + '\n\n');
      // Hand footer is preserved verbatim (including the leading blank line we wrote).
      expect(handAfter).toBe('\n\n' + handFooter);
    });

    it('idempotent merge: empty managedUpdates leaves body byte-equivalent through the roundtrip', async () => {
      const body = [
        'Stable hand intro.',
        '',
        '<!-- BEGIN MANAGED: x -->',
        'managed content stays',
        '<!-- END MANAGED: x -->',
        '',
        'Stable hand outro.',
      ].join('\n');

      const card = {
        frontmatter: {
          id: 'usr-idemp',
          type: 'peer-card',
          target: 'user',
          created: '2026-05-23T00:00:00Z',
          updated: '2026-05-23T00:00:00Z',
          source_sessions: [],
        },
        body,
      };
      await writePeerCard(tmpRepo, 'user', card);
      const firstRead = await readPeerCards(tmpRepo);
      const merged = mergePeerCard(firstRead.user.body, {});
      expect(merged.stats).toEqual({ preserved: 2, replaced: 0, appended: 0 });
      expect(merged.conflicts).toEqual([]);
      // The merger normalises managed content with a leading + trailing \n around the
      // trimmed inner text. The roundtrip is normalised-equivalent, not raw-equivalent
      // — assert against the normalised form rather than the original.
      const expectedNormalised = [
        'Stable hand intro.',
        '',
        '<!-- BEGIN MANAGED: x -->',
        'managed content stays',
        '<!-- END MANAGED: x -->',
        '',
        'Stable hand outro.',
      ].join('\n');
      expect(merged.body).toBe(expectedNormalised);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Q5 AC3: session-start staleness banner E2E
  // ─────────────────────────────────────────────────────────────────────────

  describe('Q5 AC3: session-start banner E2E', () => {
    it('checkPeerCardsStaleness emits warn banner for USER.md older than 30 days', async () => {
      // Stale card updated 31 days before injected "now" (2026-05-23T00:00:00Z)
      const staleUpdated = '2026-04-22T00:00:00Z';
      const card = {
        frontmatter: {
          id: 'usr-stale',
          type: 'peer-card',
          target: 'user',
          created: staleUpdated,
          updated: staleUpdated,
          source_sessions: [],
        },
        body: 'stale card body',
      };
      const writeRes = await writePeerCard(tmpRepo, 'user', card);
      expect(writeRes.ok).toBe(true);

      const result = await checkPeerCardsStaleness({
        repoRoot: tmpRepo,
        now: new Date('2026-05-23T00:00:00Z'),
      });
      expect(result).not.toBeNull();
      expect(result.severity).toBe('warn');
      expect(result.message).toContain('USER.md');
      expect(result.message).toContain('31d');
      expect(result.message).toContain('/evolve --dialectic');
      expect(result.stale).toEqual([{ target: 'USER.md', days: 31 }]);
    });

    it('returns null when no peer cards exist (peersDir absent)', async () => {
      const result = await checkPeerCardsStaleness({
        repoRoot: tmpRepo,
        now: new Date('2026-05-23T00:00:00Z'),
      });
      expect(result).toBeNull();
    });

    it('returns null when peersDir exists but card is fresh (updated within 30 days)', async () => {
      // Fresh: updated 5 days before injected now (well under 30-day threshold)
      const freshUpdated = '2026-05-18T00:00:00Z';
      const card = {
        frontmatter: {
          id: 'usr-fresh',
          type: 'peer-card',
          target: 'user',
          created: freshUpdated,
          updated: freshUpdated,
          source_sessions: [],
        },
        body: 'fresh body',
      };
      await writePeerCard(tmpRepo, 'user', card);

      const result = await checkPeerCardsStaleness({
        repoRoot: tmpRepo,
        now: new Date('2026-05-23T00:00:00Z'),
      });
      expect(result).toBeNull();
    });

    it('lists both USER.md and AGENT.md when both are stale', async () => {
      const userStale = '2026-04-20T00:00:00Z'; // 33 days
      const agentStale = '2026-04-15T00:00:00Z'; // 38 days
      await writePeerCard(tmpRepo, 'user', {
        frontmatter: {
          id: 'usr-2',
          type: 'peer-card',
          target: 'user',
          created: userStale,
          updated: userStale,
          source_sessions: [],
        },
        body: 'user body',
      });
      await writePeerCard(tmpRepo, 'agent', {
        frontmatter: {
          id: 'agt-2',
          type: 'peer-card',
          target: 'agent',
          created: agentStale,
          updated: agentStale,
          source_sessions: [],
        },
        body: 'agent body',
      });

      const result = await checkPeerCardsStaleness({
        repoRoot: tmpRepo,
        now: new Date('2026-05-23T00:00:00Z'),
      });
      expect(result).not.toBeNull();
      expect(result.severity).toBe('warn');
      expect(result.stale).toEqual([
        { target: 'USER.md', days: 33 },
        { target: 'AGENT.md', days: 38 },
      ]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Q5 AC4: vault-sync validates peer-card type written by writer.mjs
  // ─────────────────────────────────────────────────────────────────────────

  describe('Q5 AC4: vault-sync validates peer-card type', () => {
    it("file written by writePeerCard carries 'type: peer-card' frontmatter", async () => {
      const card = {
        frontmatter: {
          id: 'usr-vault-sync',
          type: 'peer-card',
          target: 'user',
          created: '2026-05-23T00:00:00Z',
          updated: '2026-05-23T00:00:00Z',
          source_sessions: [],
        },
        body: 'vault-sync target',
      };
      const writeRes = await writePeerCard(tmpRepo, 'user', card);
      expect(writeRes.ok).toBe(true);

      const filePath = join(tmpRepo, '.orchestrator', 'peers', 'USER.md');
      const content = readFileSync(filePath, 'utf8');
      expect(content).toContain('type: peer-card');
      expect(content).toContain('id: usr-vault-sync');
      expect(content).toContain('target: user');
    });

    it('vault-sync validator accepts a peer-card placed inside a vault', async () => {
      // Stand up a minimal vault: _meta/ marker + a peer-card placed at the vault
      // root so the validator's recursive walk picks it up.
      mkdirSync(join(tmpRepo, '_meta'), { recursive: true });

      // Write a vault-compliant peer card directly (writer.mjs targets
      // .orchestrator/peers/, which is outside the vault — for AC4 we need the
      // peer-card .md file inside the vault dir so the validator picks it up).
      const peerCardPath = join(tmpRepo, 'peer-card-usr-validation.md');
      const peerCardContent = [
        '---',
        'id: usr-validation',
        'type: peer-card',
        'created: 2026-05-23T00:00:00Z',
        'updated: 2026-05-23T00:00:00Z',
        'title: Validation Test Peer Card',
        '---',
        '',
        'Body content for vault-sync validation.',
        '',
      ].join('\n');
      writeFileSync(peerCardPath, peerCardContent, 'utf8');

      const result = spawnSync('node', [VALIDATOR_MJS, '--mode=warn'], {
        encoding: 'utf8',
        cwd: VALIDATOR_CWD,
        env: { ...process.env, VAULT_DIR: tmpRepo },
      });

      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.status).toBe('ok');
      // No errors specific to the peer-card file we wrote
      const errorsForPeerCard = parsed.errors.filter((e) =>
        e.file && e.file.includes('peer-card-usr-validation'),
      );
      expect(errorsForPeerCard).toEqual([]);
      // files_checked includes our peer-card
      expect(parsed.files_checked).toBeGreaterThanOrEqual(1);
    });

    it('vault-sync validator accepts the actual writer.mjs output (writer→validator chain)', async () => {
      // Stand up vault marker, then write a peer card via writePeerCard into
      // a vault-rooted .md path so we exercise the full writer→on-disk→validator
      // pipeline. This is the load-bearing assertion that the writer's
      // JSON.stringify-quoted ISO timestamps survive vault-sync's YAML.parse.
      mkdirSync(join(tmpRepo, '_meta'), { recursive: true });

      // writePeerCard writes to .orchestrator/peers/USER.md — copy that file
      // into a vault-rooted .md path so the validator's recursive walk finds it.
      const writeRes = await writePeerCard(tmpRepo, 'user', {
        frontmatter: {
          id: 'usr-writer-chain',
          type: 'peer-card',
          target: 'user',
          created: '2026-05-23T00:00:00Z',
          updated: '2026-05-23T00:00:00Z',
          source_sessions: [],
        },
        body: 'writer-chain body',
      });
      expect(writeRes.ok).toBe(true);

      const writerOutput = readFileSync(writeRes.path, 'utf8');
      const inVaultPath = join(tmpRepo, 'peer-card-from-writer.md');
      writeFileSync(inVaultPath, writerOutput, 'utf8');

      const result = spawnSync('node', [VALIDATOR_MJS, '--mode=hard'], {
        encoding: 'utf8',
        cwd: VALIDATOR_CWD,
        env: { ...process.env, VAULT_DIR: tmpRepo },
      });

      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.status).toBe('ok');
      const errorsForWriterCard = parsed.errors.filter((e) =>
        e.file && e.file.includes('peer-card-from-writer'),
      );
      expect(errorsForWriterCard).toEqual([]);
    });

    it('vault-sync validator REJECTS a peer-card with invalid type literal', async () => {
      // Falsification: if the schema didn't actually accept peer-card, the
      // previous test would still pass by luck (no errors observed). Prove
      // the validator is wired up by sending an invalid type and expecting
      // it to surface as an error.
      mkdirSync(join(tmpRepo, '_meta'), { recursive: true });
      const badCardPath = join(tmpRepo, 'bad-card.md');
      const badCardContent = [
        '---',
        'id: usr-bad',
        'type: not-a-real-type',
        'created: 2026-05-23T00:00:00Z',
        'updated: 2026-05-23T00:00:00Z',
        '---',
        '',
        'body',
        '',
      ].join('\n');
      writeFileSync(badCardPath, badCardContent, 'utf8');

      const result = spawnSync('node', [VALIDATOR_MJS, '--mode=hard'], {
        encoding: 'utf8',
        cwd: VALIDATOR_CWD,
        env: { ...process.env, VAULT_DIR: tmpRepo },
      });

      expect(result.status).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.status).toBe('invalid');
      const errorsForBadCard = parsed.errors.filter((e) =>
        e.file && e.file.includes('bad-card'),
      );
      expect(errorsForBadCard.length).toBeGreaterThanOrEqual(1);
      expect(errorsForBadCard[0].path).toBe('type');
    });
  });
});
