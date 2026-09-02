/**
 * category1.mjs — Category 1: Session Discipline (weight: 10)
 *
 * Checks: state-md-present, sessions-jsonl-growth, learnings-jsonl-nonempty,
 *         orchestrator-layout
 *
 * Stdlib + intra-repo helpers only (node:fs, node:path, ./helpers.mjs,
 * ../../sessions-canonical.mjs).
 */

import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { parseFrontmatter, safeRead, parseJsonl, pass, fail } from './helpers.mjs';
import { canonicalizeSessions } from '../../sessions-canonical.mjs';

export function runCategory1(root) {
  const checks = [];

  // c1.1 state-md-present
  {
    const candidates = [
      join(root, '.claude/STATE.md'),
      join(root, '.codex/STATE.md'),
      join(root, '.cursor/STATE.md'),
      join(root, '.pi/STATE.md'),
    ];
    const found = candidates.find((p) => existsSync(p));
    if (!found) {
      checks.push(fail('state-md-present', 3, '.claude/STATE.md',
        { path: null, hasYaml: false, schemaVersion: null, sessionType: null },
        'STATE.md not found in .claude/, .codex/, .cursor/, or .pi/'));
    } else {
      const text = safeRead(found);
      const size = text ? text.length : 0;
      const fm = text ? parseFrontmatter(text) : null;
      const hasYaml = fm !== null;
      const sv = fm ? fm['schema-version'] : null;
      const st = fm ? fm['status'] : null;
      const stype = fm ? fm['session-type'] : null;
      const hasSchemaV1 = sv === '1';
      const relPath = relative(root, found).split(sep).join('/');
      if (size > 0 && hasYaml && hasSchemaV1 && st && stype) {
        checks.push(pass('state-md-present', 3, 3, relPath,
          { path: relPath, hasYaml: true, schemaVersion: sv, sessionType: stype },
          `STATE.md present, schema-version=${sv}, session-type=${stype}`));
      } else {
        checks.push(fail('state-md-present', 3, relPath,
          { path: relPath, hasYaml, schemaVersion: sv, sessionType: stype },
          `STATE.md found but missing required frontmatter fields (size=${size}, yaml=${hasYaml}, schema-version=${sv})`));
      }
    }
  }

  // c1.2 sessions-jsonl-growth
  {
    const p = join(root, '.orchestrator/metrics/sessions.jsonl');
    const text = safeRead(p);
    const relPath = '.orchestrator/metrics/sessions.jsonl';
    if (!text) {
      checks.push(fail('sessions-jsonl-growth', 3, relPath,
        { lineCount: 0, validLines: 0 }, 'sessions.jsonl missing'));
    } else {
      const { lines, validLines } = parseJsonl(text);
      const requiredKeys = ['session_id', 'session_type', 'started_at'];
      const wellFormed = validLines.filter((l) => requiredKeys.every((k) => k in l));
      // "Growth" means IDENTITIES, not records (#1167): sessions.jsonl is
      // append-only, so one physical session can occupy two lines (an abandoned
      // stub plus the record that supersedes it, or the systemic double-stub
      // pair). A repo whose only two lines are one duplicated session has not
      // grown, and the ≥2 threshold exists to prove the ledger is actually
      // accumulating sessions. The WELL-FORMEDNESS half deliberately stays on
      // raw lines — a malformed or key-missing line is a defect of that line,
      // and collapsing duplicates first would hide it.
      const sessionCount = canonicalizeSessions(validLines).length;
      if (sessionCount >= 2 && wellFormed.length === lines) {
        checks.push(pass('sessions-jsonl-growth', 3, 3, relPath,
          { lineCount: lines, validLines: wellFormed.length, sessionCount },
          `sessions.jsonl has ${sessionCount} distinct sessions in ${lines} valid lines`));
      } else {
        checks.push(fail('sessions-jsonl-growth', 3, relPath,
          { lineCount: lines, validLines: wellFormed.length, sessionCount },
          `sessions.jsonl: sessions=${sessionCount} (need ≥2), lines=${lines}, wellFormed=${wellFormed.length}/${lines}`));
      }
    }
  }

  // c1.3 learnings-jsonl-nonempty
  {
    const p = join(root, '.orchestrator/metrics/learnings.jsonl');
    const text = safeRead(p);
    const relPath = '.orchestrator/metrics/learnings.jsonl';
    if (!text) {
      checks.push(fail('learnings-jsonl-nonempty', 2, relPath,
        { lineCount: 0, validLines: 0 }, 'learnings.jsonl missing'));
    } else {
      const { lines, validLines } = parseJsonl(text);
      const requiredKeys = ['type', 'subject', 'confidence'];
      const wellFormed = validLines.filter((l) => requiredKeys.every((k) => k in l));
      if (lines >= 1 && wellFormed.length === lines) {
        checks.push(pass('learnings-jsonl-nonempty', 2, 2, relPath,
          { lineCount: lines, validLines: wellFormed.length },
          `learnings.jsonl has ${lines} valid lines`));
      } else {
        checks.push(fail('learnings-jsonl-nonempty', 2, relPath,
          { lineCount: lines, validLines: wellFormed.length },
          `learnings.jsonl: lines=${lines} (need ≥1), wellFormed=${wellFormed.length}/${lines}`));
      }
    }
  }

  // c1.4 orchestrator-layout
  {
    const requiredPaths = [
      '.orchestrator',
      '.orchestrator/bootstrap.lock',
      '.orchestrator/policy',
      '.orchestrator/metrics',
    ];
    const presentPaths = requiredPaths.filter((rp) => existsSync(join(root, rp)));
    if (presentPaths.length === requiredPaths.length) {
      checks.push(pass('orchestrator-layout', 2, 2, '.orchestrator/',
        { presentPaths },
        'All required .orchestrator/ paths present'));
    } else {
      const missing = requiredPaths.filter((rp) => !existsSync(join(root, rp)));
      checks.push(fail('orchestrator-layout', 2, '.orchestrator/',
        { presentPaths, missingPaths: missing },
        `Missing: ${missing.join(', ')}`));
    }
  }

  return checks;
}
