/**
 * tests/hooks/config-protection.test.mjs
 *
 * Tests for hooks/config-protection.mjs (#622).
 *
 * The hook is a PreToolUse Edit|Write guard that intercepts edits to a small
 * allow-list of quality-gate config files (eslint / vitest / tsconfig /
 * prettier / commitlint / gitleaks) and WARNs (stderr + event, exit 0) — or, in
 * `strict` mode, BLOCKS (deny JSON, exit 2) — when an edit LOOSENS a gate.
 * First-time creation, tightening, neutral edits, non-config files, and a
 * Session Config bypass are always allowed.
 *
 * Strategy (mirrors tests/hooks/post-tool-batch.test.mjs + the CLAUDE.md-fixture
 * pattern from tests/hooks/post-subagent-discovery-validator.test.mjs): spawn
 * the hook via node with stdin piped, CLAUDE_PROJECT_DIR pointing to a tmp
 * sandbox, fixture config files written into the sandbox. For Write-loosening
 * cases the OLD file is pre-written; for Edit cases old_string/new_string are
 * passed directly. Assert exit code + the contents of events.jsonl (behaviour,
 * not implementation).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = new URL('../../hooks/config-protection.mjs', import.meta.url).pathname;
const EVENTS_REL = join('.orchestrator', 'metrics', 'events.jsonl');

const CLAUDE_MD_DEFAULT = [
  '# Sandbox',
  '',
  'config-protection:',
  '  enabled: true',
  '  mode: warn',
  '',
  '## Session Config',
  '',
  'allow-config-weakening: false',
  '',
].join('\n');

const CLAUDE_MD_STRICT = [
  '# Sandbox',
  '',
  'config-protection:',
  '  enabled: true',
  '  mode: strict',
  '',
  '## Session Config',
  '',
  'allow-config-weakening: false',
  '',
].join('\n');

const CLAUDE_MD_DISABLED = [
  '# Sandbox',
  '',
  'config-protection:',
  '  enabled: false',
  '  mode: warn',
  '',
].join('\n');

const CLAUDE_MD_BYPASS = [
  '# Sandbox',
  '',
  'config-protection:',
  '  enabled: true',
  '  mode: warn',
  '',
  '## Session Config',
  '',
  'allow-config-weakening: true',
  '',
].join('\n');

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'config-protection-test-'));
});

afterEach(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

/** Write CLAUDE.md into the sandbox so the hook can read the config. */
function writeClaudeMd(content) {
  writeFileSync(join(tmp, 'CLAUDE.md'), content, 'utf8');
}

/** Write a fixture file into the sandbox. Returns its absolute path. */
function writeFixture(relPath, content) {
  const p = join(tmp, relPath);
  writeFileSync(p, content, 'utf8');
  return p;
}

/** Spawn the hook with the given stdin payload object. */
function runHook(payloadObj) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payloadObj),
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: tmp,
      SO_HOOK_PROFILE: 'full',
      SO_DISABLED_HOOKS: '',
    },
    timeout: 10_000,
  });
}

/** Read + parse the events.jsonl records (skips blank lines). */
function readEvents() {
  const p = join(tmp, EVENTS_REL);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Edit payload. */
function editPayload(filePath, oldString, newString) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: filePath, old_string: oldString, new_string: newString },
  };
}

/** Write payload. */
function writePayload(filePath, content) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: filePath, content },
  };
}

describe('config-protection hook', () => {
  // (1) lower vitest statements 70→50 → warn, exit 0, event reasons include
  //     threshold-lowered, action:warned.
  it('Write that lowers vitest statements 70→50 → warn, exit 0, threshold event', () => {
    writeClaudeMd(CLAUDE_MD_DEFAULT);
    const file = writeFixture(
      'vitest.config.ts',
      'export default { test: { coverage: { statements: 70, branches: 70 } } };\n'
    );

    const result = runHook(
      writePayload(file, 'export default { test: { coverage: { statements: 50, branches: 70 } } };\n')
    );

    expect(result.status).toBe(0);
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('orchestrator.config.protection_warning');
    expect(events[0].file).toBe('vitest.config.ts');
    expect(events[0].action).toBe('warned');
    expect(events[0].reasons.some((r) => r.startsWith('threshold-lowered'))).toBe(true);
  });

  // (2) same edit + mode:strict → exit 2, deny JSON, action:blocked.
  it('strict mode + threshold lowered → exit 2, deny JSON, action:blocked', () => {
    writeClaudeMd(CLAUDE_MD_STRICT);
    const file = writeFixture(
      'vitest.config.ts',
      'export default { test: { coverage: { statements: 70 } } };\n'
    );

    const result = runHook(
      writePayload(file, 'export default { test: { coverage: { statements: 50 } } };\n')
    );

    expect(result.status).toBe(2);
    const out = JSON.parse(result.stdout.trim());
    expect(out.permissionDecision).toBe('deny');
    expect(out.reason).toContain('vitest.config.ts');

    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('blocked');
  });

  // (3) added eslint-disable-next-line not in old → warn + event.
  //     The fixture must contain the Edit old_string (PreToolUse reads the
  //     on-disk pre-edit file and reconstructs the whole post-edit file).
  it('Edit that adds an eslint-disable-next-line → warn + event', () => {
    writeClaudeMd(CLAUDE_MD_DEFAULT);
    const file = writeFixture('eslint.config.mjs', 'const x = 1;\n');

    const result = runHook(
      editPayload(
        file,
        'const x = 1;\n',
        'const x = 1;\n// eslint-disable-next-line no-unused-vars\nconst y = 2;\n'
      )
    );

    expect(result.status).toBe(0);
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].file).toBe('eslint.config.mjs');
    expect(events[0].reasons.some((r) => r.startsWith('disable-directive-added'))).toBe(true);
  });

  // (4) widened .gitleaks.toml allowlist → warn + event.
  it('Write that widens a .gitleaks.toml allowlist → warn + event', () => {
    writeClaudeMd(CLAUDE_MD_DEFAULT);
    const file = writeFixture('.gitleaks.toml', 'title = "gitleaks config"\n');

    const result = runHook(
      writePayload(
        file,
        'title = "gitleaks config"\n[[allowlist]]\nregexes = ["fake-secret"]\n'
      )
    );

    expect(result.status).toBe(0);
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].file).toBe('.gitleaks.toml');
    expect(events[0].reasons.some((r) => r.startsWith('gitleaks-allowlist-widened'))).toBe(true);
  });

  // (5) tightening (70→90) → exit 0, NO warning, NO event.
  it('Write that RAISES a threshold 70→90 → allow, no event (tightening)', () => {
    writeClaudeMd(CLAUDE_MD_DEFAULT);
    const file = writeFixture(
      'vitest.config.ts',
      'export default { test: { coverage: { statements: 70 } } };\n'
    );

    const result = runHook(
      writePayload(file, 'export default { test: { coverage: { statements: 90 } } };\n')
    );

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
  });

  // (5b) tightening — removing a disable directive → allow, no event.
  it('Edit that REMOVES an eslint-disable directive → allow, no event (tightening)', () => {
    writeClaudeMd(CLAUDE_MD_DEFAULT);
    const file = writeFixture(
      'eslint.config.mjs',
      '// eslint-disable-next-line no-unused-vars\nconst y = 2;\n'
    );

    const result = runHook(
      editPayload(
        file,
        '// eslint-disable-next-line no-unused-vars\nconst y = 2;\n',
        'const y = 2;\n'
      )
    );

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
  });

  // (6) neutral / comment-only edit → exit 0, no event.
  it('Edit that is comment-only / neutral → allow, no event', () => {
    writeClaudeMd(CLAUDE_MD_DEFAULT);
    const file = writeFixture('eslint.config.mjs', '// old comment\n');

    const result = runHook(
      editPayload(file, '// old comment\n', '// new comment, no rule change\n')
    );

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
  });

  // (7) first-time creation (no old file) → allow, no warning.
  it('Write to a NEW vitest.config.ts (no prior file) → allow, no event', () => {
    writeClaudeMd(CLAUDE_MD_DEFAULT);
    // Note: do NOT pre-write the fixture — file does not exist yet.
    const file = join(tmp, 'vitest.config.ts');

    const result = runHook(
      writePayload(file, 'export default { test: { coverage: { statements: 10 } } };\n')
    );

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
  });

  // (8) loosening + allow-config-weakening:true → exit 0, bypass note, no event.
  it('loosening + allow-config-weakening:true → allow, bypass note, no event', () => {
    writeClaudeMd(CLAUDE_MD_BYPASS);
    const file = writeFixture(
      'vitest.config.ts',
      'export default { test: { coverage: { statements: 70 } } };\n'
    );

    const result = runHook(
      writePayload(file, 'export default { test: { coverage: { statements: 50 } } };\n')
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('config-protection bypassed');
    expect(readEvents()).toEqual([]);
  });

  // (9) non-config file (src/foo.ts) → allow silent.
  it('non-config file (src/foo.ts) → allow, no scan, no event', () => {
    writeClaudeMd(CLAUDE_MD_DEFAULT);
    const file = writeFixture('foo.ts', 'export const statements = 70;\n');

    const result = runHook(
      writePayload(file, 'export const statements = 10;\n')
    );

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
  });

  // (10) config-protection.enabled:false → allow even on loosening.
  it('config-protection.enabled:false → allow even on a loosening edit, no event', () => {
    writeClaudeMd(CLAUDE_MD_DISABLED);
    const file = writeFixture(
      'vitest.config.ts',
      'export default { test: { coverage: { statements: 70 } } };\n'
    );

    const result = runHook(
      writePayload(file, 'export default { test: { coverage: { statements: 50 } } };\n')
    );

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
  });

  // (11) malformed stdin / missing file_path → exit 0, no crash.
  it('malformed stdin (not JSON) → exit 0, no crash, no event', () => {
    writeClaudeMd(CLAUDE_MD_DEFAULT);

    const result = spawnSync(process.execPath, [HOOK], {
      input: 'this is not json',
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: tmp,
        SO_HOOK_PROFILE: 'full',
        SO_DISABLED_HOOKS: '',
      },
      timeout: 10_000,
    });

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
  });

  it('missing file_path in tool_input → exit 0, no crash, no event', () => {
    writeClaudeMd(CLAUDE_MD_DEFAULT);

    const result = runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { content: 'export default {};\n' },
    });

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
  });

  // tsconfig strictness relaxed → warn + event.
  it('Edit that flips tsconfig strict true→false → warn + event', () => {
    writeClaudeMd(CLAUDE_MD_DEFAULT);
    const file = writeFixture('tsconfig.json', '{ "compilerOptions": { "strict": true } }\n');

    const result = runHook(
      editPayload(
        file,
        '"strict": true',
        '"strict": false'
      )
    );

    expect(result.status).toBe(0);
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].file).toBe('tsconfig.json');
    expect(events[0].reasons.some((r) => r.startsWith('tsconfig-strictness-relaxed'))).toBe(true);
  });

  // ----- FIX 1: Edit-path slice-boundary bypass (security MED, PoC) ----------

  // (F1a) PoC: old_string:"90" new_string:"10" — the key name lives OUTSIDE the
  //       slice. Slice-only comparison saw no threshold key → ALLOW. Whole-file
  //       reconstruction sees `statements: 10 < 90` → WARN + event.
  it('Edit slice-bypass (old_string:"90" new_string:"10") is now CAUGHT → warn + event', () => {
    writeClaudeMd(CLAUDE_MD_DEFAULT);
    const file = writeFixture(
      'vitest.config.ts',
      'export default { test: { coverage: { statements: 90, branches: 80 } } };\n'
    );

    const result = runHook(editPayload(file, '90', '10'));

    expect(result.status).toBe(0);
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].file).toBe('vitest.config.ts');
    expect(events[0].action).toBe('warned');
    expect(events[0].reasons.some((r) => r.startsWith('threshold-lowered'))).toBe(true);
  });

  // (F1b) PoC: delete-the-line — old_string is the whole "statements: 90," line,
  //       new_string is "". newT lacks `statements` entirely. Old-key iteration
  //       treats a removed threshold as 0 < 90 → WARN + event.
  it('Edit delete-the-threshold-line bypass is now CAUGHT → warn + event', () => {
    writeClaudeMd(CLAUDE_MD_DEFAULT);
    const file = writeFixture(
      'vitest.config.base.ts',
      [
        'export default {',
        '  test: {',
        '    coverage: {',
        '      statements: 90,',
        '      branches: 80,',
        '    },',
        '  },',
        '};',
        '',
      ].join('\n')
    );

    const result = runHook(editPayload(file, '      statements: 90,\n', ''));

    expect(result.status).toBe(0);
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].file).toBe('vitest.config.base.ts');
    expect(events[0].reasons.some((r) => r.startsWith('threshold-lowered'))).toBe(true);
  });

  // (F1c) whole-file reconstruction does NOT false-positive on a legit tighten
  //       made via a narrow slice (statements 70→90 with key outside the slice).
  it('Edit slice that RAISES a threshold (70→90, key outside slice) → allow, no event', () => {
    writeClaudeMd(CLAUDE_MD_DEFAULT);
    const file = writeFixture(
      'vitest.config.ts',
      'export default { test: { coverage: { statements: 70 } } };\n'
    );

    const result = runHook(editPayload(file, '70', '90'));

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
  });

  // (F1d) Edit whose old_string is absent from the on-disk file → no-op skip,
  //       no false-positive (slice not applied, fullNew === fullOld).
  it('Edit whose old_string is not in the file → allow, no event (no-op skip)', () => {
    writeClaudeMd(CLAUDE_MD_DEFAULT);
    const file = writeFixture(
      'vitest.config.ts',
      'export default { test: { coverage: { statements: 90 } } };\n'
    );

    const result = runHook(editPayload(file, 'nonexistent-anchor', '10'));

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
  });

  // ----- FIX 2: numeric ESLint severities (security MED, PoC) ----------------

  // (F2a) PoC: a rule severity 2→0 (enable→disable) via numeric value. The
  //       word-only matcher missed this; numeric value-position counting catches
  //       the net on→off shift.
  it('Edit that disables an ESLint rule numerically (2→0) is now CAUGHT → warn + event', () => {
    writeClaudeMd(CLAUDE_MD_DEFAULT);
    const file = writeFixture(
      'eslint.config.mjs',
      'export default [{ rules: { "no-console": 2 } }];\n'
    );

    const result = runHook(
      editPayload(
        file,
        '"no-console": 2',
        '"no-console": 0'
      )
    );

    expect(result.status).toBe(0);
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].file).toBe('eslint.config.mjs');
    expect(events[0].reasons.some((r) => r.startsWith('rule-relaxed'))).toBe(true);
  });

  // (F2b) word severity "error"→0 (numeric off) also caught.
  it('Edit that changes a rule "error"→0 is now CAUGHT → warn + event', () => {
    writeClaudeMd(CLAUDE_MD_DEFAULT);
    const file = writeFixture(
      'eslint.config.mjs',
      'export default [{ rules: { "no-console": "error" } }];\n'
    );

    const result = runHook(
      editPayload(
        file,
        '"no-console": "error"',
        '"no-console": 0'
      )
    );

    expect(result.status).toBe(0);
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].reasons.some((r) => r.startsWith('rule-relaxed'))).toBe(true);
  });

  // (F2c) tightening 0→2 (disable→enable) must NOT false-positive.
  it('Edit that ENABLES a rule numerically (0→2) → allow, no event (tightening)', () => {
    writeClaudeMd(CLAUDE_MD_DEFAULT);
    const file = writeFixture(
      'eslint.config.mjs',
      'export default [{ rules: { "no-console": 0 } }];\n'
    );

    const result = runHook(
      editPayload(
        file,
        '"no-console": 0',
        '"no-console": 2'
      )
    );

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
  });

  // ----- FIX 3: MultiEdit interception (qa HIGH + security LOW) --------------

  // (F3a) MultiEdit whose edits[] lower a threshold → warn + event.
  it('MultiEdit that lowers a threshold → warn + event', () => {
    writeClaudeMd(CLAUDE_MD_DEFAULT);
    const file = writeFixture(
      'vitest.config.ts',
      'export default { test: { coverage: { statements: 90, branches: 85 } } };\n'
    );

    const result = runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: file,
        edits: [
          { old_string: 'statements: 90', new_string: 'statements: 50' },
          { old_string: 'branches: 85', new_string: 'branches: 60' },
        ],
      },
    });

    expect(result.status).toBe(0);
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].file).toBe('vitest.config.ts');
    expect(events[0].action).toBe('warned');
    expect(events[0].reasons.some((r) => r.startsWith('threshold-lowered'))).toBe(true);
  });

  // (F3b) MultiEdit that only TIGHTENS → allow, no event (no false-positive).
  it('MultiEdit that raises thresholds → allow, no event (tightening)', () => {
    writeClaudeMd(CLAUDE_MD_DEFAULT);
    const file = writeFixture(
      'vitest.config.ts',
      'export default { test: { coverage: { statements: 70, branches: 70 } } };\n'
    );

    const result = runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: file,
        edits: [
          { old_string: 'statements: 70', new_string: 'statements: 90' },
          { old_string: 'branches: 70', new_string: 'branches: 90' },
        ],
      },
    });

    expect(result.status).toBe(0);
    expect(readEvents()).toEqual([]);
  });

  // (F3c) MultiEdit in strict mode that loosens → exit 2, deny, action:blocked.
  it('MultiEdit loosening in strict mode → exit 2, deny JSON, action:blocked', () => {
    writeClaudeMd(CLAUDE_MD_STRICT);
    const file = writeFixture(
      'vitest.config.ts',
      'export default { test: { coverage: { statements: 90 } } };\n'
    );

    const result = runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: file,
        edits: [{ old_string: 'statements: 90', new_string: 'statements: 10' }],
      },
    });

    expect(result.status).toBe(2);
    const out = JSON.parse(result.stdout.trim());
    expect(out.permissionDecision).toBe('deny');
    expect(out.reason).toContain('vitest.config.ts');
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('blocked');
  });

  // session_id is threaded into the event when present.
  it('event includes session_id when the payload carries one', () => {
    writeClaudeMd(CLAUDE_MD_DEFAULT);
    const file = writeFixture(
      'vitest.config.ts',
      'export default { test: { coverage: { statements: 70 } } };\n'
    );

    const result = runHook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      session_id: 'main-2026-06-04-deep-1',
      tool_input: {
        file_path: file,
        content: 'export default { test: { coverage: { statements: 50 } } };\n',
      },
    });

    expect(result.status).toBe(0);
    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].session_id).toBe('main-2026-06-04-deep-1');
  });
});
