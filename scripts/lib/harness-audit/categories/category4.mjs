/**
 * category4.mjs — Category 4: Persistence Health (weight: 10)
 *
 * Checks: state-md-schema, sessions-jsonl-recent, learnings-prunable,
 *         vault-sync-validator
 *
 * Stdlib only: node:fs, node:path.
 */

import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { parseFrontmatter, safeRead, parseJsonl, pass, fail } from './helpers.mjs';

export function runCategory4(root) {
  const checks = [];

  // c4.1 state-md-schema
  {
    const candidates = [
      join(root, '.claude/STATE.md'),
      join(root, '.codex/STATE.md'),
      join(root, '.cursor/STATE.md'),
    ];
    const found = candidates.find((p) => existsSync(p));
    const relPath = '.claude/STATE.md';
    if (!found) {
      checks.push(fail('state-md-schema', 3, relPath,
        { missingKeys: ['all'] },
        'STATE.md not found'));
    } else {
      const text = safeRead(found);
      const fm = text ? parseFrontmatter(text) : null;
      const requiredKeys = ['schema-version', 'session-type', 'branch', 'status', 'current-wave', 'total-waves'];
      const missingKeys = fm ? requiredKeys.filter((k) => !(k in fm)) : requiredKeys;
      if (missingKeys.length === 0) {
        checks.push(pass('state-md-schema', 3, 3, relative(root, found).split(sep).join('/'),
          { missingKeys: [] },
          'STATE.md has all required frontmatter keys'));
      } else {
        checks.push(fail('state-md-schema', 3, relative(root, found).split(sep).join('/'),
          { missingKeys },
          `STATE.md missing keys: ${missingKeys.join(', ')}`));
      }
    }
  }

  // c4.2 sessions-jsonl-recent
  {
    const p = join(root, '.orchestrator/metrics/sessions.jsonl');
    const text = safeRead(p);
    const relPath = '.orchestrator/metrics/sessions.jsonl';
    if (!text) {
      checks.push(fail('sessions-jsonl-recent', 3, relPath,
        { latestCompletedAt: null, ageInDays: null },
        'sessions.jsonl missing'));
    } else {
      const lines = text.split('\n').filter((l) => l.trim().length > 0);
      if (lines.length === 0) {
        checks.push(fail('sessions-jsonl-recent', 3, relPath,
          { latestCompletedAt: null, ageInDays: null },
          'sessions.jsonl is empty'));
      } else {
        const lastLine = lines[lines.length - 1];
        let lastObj = null;
        try { lastObj = JSON.parse(lastLine); } catch { /* ignore */ }
        const completedAt = lastObj ? lastObj.completed_at : null;
        if (!completedAt) {
          checks.push(fail('sessions-jsonl-recent', 3, relPath,
            { latestCompletedAt: null, ageInDays: null },
            'Last sessions.jsonl entry has no completed_at'));
        } else {
          const ageMs = Date.now() - new Date(completedAt).getTime();
          const ageInDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
          if (ageInDays <= 30) {
            checks.push(pass('sessions-jsonl-recent', 3, 3, relPath,
              { latestCompletedAt: completedAt, ageInDays },
              `Last session completed ${ageInDays} day(s) ago`));
          } else {
            checks.push(fail('sessions-jsonl-recent', 3, relPath,
              { latestCompletedAt: completedAt, ageInDays },
              `Last session ${ageInDays} days ago (> 30 day threshold)`));
          }
        }
      }
    }
  }

  // c4.3 learnings-prunable
  {
    const p = join(root, '.orchestrator/metrics/learnings.jsonl');
    const text = safeRead(p);
    const relPath = '.orchestrator/metrics/learnings.jsonl';
    if (!text) {
      checks.push(fail('learnings-prunable', 2, relPath,
        { totalLines: 0, allHaveExpires: false, confidenceInRange: false },
        'learnings.jsonl missing'));
    } else {
      const { lines, validLines } = parseJsonl(text);
      const allHaveExpires = validLines.length > 0 && validLines.every((l) => typeof l.expires_at === 'string');
      const confidenceInRange = validLines.length > 0 && validLines.every((l) => typeof l.confidence === 'number' && l.confidence >= 0 && l.confidence <= 1);
      if (allHaveExpires && confidenceInRange) {
        checks.push(pass('learnings-prunable', 2, 2, relPath,
          { totalLines: lines, allHaveExpires, confidenceInRange },
          `All ${lines} learnings have expires_at and confidence in [0,1]`));
      } else {
        checks.push(fail('learnings-prunable', 2, relPath,
          { totalLines: lines, allHaveExpires, confidenceInRange },
          `learnings not fully prunable: allHaveExpires=${allHaveExpires}, confidenceInRange=${confidenceInRange}`));
      }
    }
  }

  // c4.4 vault-sync-validator
  {
    const relPath = 'skills/vault-sync/validator.mjs';
    // Parse CLAUDE.md Session Config for vault-integration.enabled
    const claudeMd = safeRead(join(root, 'CLAUDE.md')) || safeRead(join(root, 'AGENTS.md')) || '';
    // Extract ## Session Config block
    const scMatch = /^## Session Config\s*\n([\s\S]*?)(?=^## |\s*$)/m.exec(claudeMd);
    const scBlock = scMatch ? scMatch[1] : '';
    const vaultEnabledMatch = /vault-integration\.enabled:\s*true/i.exec(scBlock) ||
      /vault-integration:\s*\n\s+enabled:\s*true/im.exec(scBlock);
    const vaultEnabled = Boolean(vaultEnabledMatch);

    if (!vaultEnabled) {
      checks.push(pass('vault-sync-validator', 2, 2, relPath,
        { vaultEnabled: false, validatorPresent: null },
        'vault-integration not enabled — skip'));
    } else {
      const validatorPresent = existsSync(join(root, relPath));
      if (validatorPresent) {
        checks.push(pass('vault-sync-validator', 2, 2, relPath,
          { vaultEnabled: true, validatorPresent: true },
          'vault-integration enabled and validator.mjs present'));
      } else {
        checks.push(fail('vault-sync-validator', 2, relPath,
          { vaultEnabled: true, validatorPresent: false },
          'vault-integration enabled but skills/vault-sync/validator.mjs missing'));
      }
    }
  }

  return checks;
}
