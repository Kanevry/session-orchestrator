/**
 * tests/scripts/pack-install-lifecycle.test.mjs — #1375
 *
 * Runs the ACTUAL npm lifecycle a consumer runs — `npm pack`, then
 * `npm install <tgz>` into a FRESH throwaway package — and exercises the
 * guard out of the INSTALLED tree, not out of this checkout.
 *
 * ## Which bugs this catches that the rest of the suite cannot
 *
 * `tests/scripts/pack-policy-floor.test.mjs` reads the PACKLIST
 * (`npm pack --dry-run --json`): a NAME appearing in npm's file list. That is a
 * manifest claim. It never unpacks anything, never installs anything, and never
 * runs a single line out of the artefact. Everything else in `tests/` runs the
 * repo checkout, where every tracked file is present by construction — so a
 * `files[]` omission is invisible to all of it.
 *
 * Between "the name is in the packlist" and "an npm consumer has a working
 * guard" sit: the tarball actually written to disk, the install that resolves
 * it, and the hook resolving its own siblings under `$CLAUDE_PLUGIN_ROOT` in a
 * directory that is NOT a git checkout. This file is the only place those three
 * are measured.
 *
 * ## Why the digest assertion is shaped the way it is
 *
 * It compares the sha512 (SRI form) of the tarball THIS test packed against the
 * `integrity` the fresh consumer's own `package-lock.json` recorded for
 * `node_modules/session-orchestrator`. Both ends are measured, neither is
 * self-reported by npm's pack output — so a tarball mutated between pack and
 * install, or a pipeline that installs something other than what it packed,
 * turns this red.
 *
 * It deliberately does NOT re-hash the extracted tree: unpacking does not
 * preserve mtimes bit-for-bit, so a re-tar of `node_modules/session-orchestrator`
 * would differ from the original tarball for reasons that are not defects.
 *
 * ## Cost, and why it is OPT-IN
 *
 * Measured 2026-09-16 @ ca214376 (W1, by hand): `npm pack` ~15 s,
 * `npm install <tgz>` ~3 s / 67 packages. The install reaches the npm registry
 * for the package's own runtime dependencies, so this file is NOT part of the
 * default `npm test`: `vitest.config.mjs` includes `tests/**` and is
 * config-protected, so the gate is an env flag instead —
 * `SO_PACK_TEST=1` (or `npm run test:pack`). Without it the suite below is
 * SKIPPED, which is why the reason is spelled out in the describe title: that
 * line is what vitest prints for a skipped suite.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmpDir, removeTree } from '../_helpers/tmp-fixture.mjs';
import { expectAllow, expectDeny } from '../_helpers/hook-decision.mjs';

const RUN = process.env.SO_PACK_TEST === '1';
const REPO_ROOT = process.cwd();

/**
 * Env for every spawned `npm`.
 *
 * EVERY `npm_config_*` variable is stripped, not just the loglevel pair
 * `pack-policy-floor.test.mjs` documents. Two distinct hazards:
 *   - `npm_config_loglevel` / `NPM_CONFIG_LOGLEVEL` inherited from an outer gate
 *     run make npm suppress the `--json` output this file parses.
 *   - `npm_config_local_prefix` is exported by `npm run` itself and points at
 *     THIS repo. Left in place it follows the child `npm install` into the
 *     throwaway consumer directory, which is precisely the isolation the
 *     consumer exists to provide.
 * Case-insensitive because npm accepts both spellings.
 */
function npmEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^npm_config_/i.test(k)),
  );
}

/** Absolute paths of the three fixture roots, populated by `beforeAll`. */
let packDir = '';
let consumerDir = '';
let installedRoot = '';
/** SRI-form sha512 of the tarball this test packed, computed from its bytes. */
let packedIntegrity = '';
/** The `integrity` the consumer's own lockfile recorded for the package. */
let lockedIntegrity = '';

describe.skipIf(!RUN)(
  'pack-install lifecycle (#1375) — opt-in: SO_PACK_TEST=1, or `npm run test:pack` (~20 s, needs the npm registry)',
  () => {
    beforeAll(() => {
      packDir = makeTmpDir('so-pack-');
      consumerDir = makeTmpDir('so-consumer-');
      installedRoot = join(consumerDir, 'node_modules', 'session-orchestrator');

      const env = npmEnv();

      const pack = spawnSync(
        'npm',
        ['pack', '--pack-destination', packDir, '--json'],
        { cwd: REPO_ROOT, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 },
      );
      // Fail CLOSED and say so — an unparseable pack must never read as "no finding".
      if (pack.status !== 0) {
        throw new Error(
          `npm pack failed (exit ${pack.status}): ${(pack.stderr || '').trim().slice(-400)}`,
        );
      }
      const parsed = JSON.parse(pack.stdout);
      // npm <= 11 emits `[ { filename } ]`; npm >= 12.0.2 emits `{ "<name>": { filename } }`.
      const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed ?? {})[0];
      const tgzPath = join(packDir, entry?.filename ?? '');
      if (!entry?.filename || !existsSync(tgzPath)) {
        throw new Error(`npm pack reported no tarball on disk: ${JSON.stringify(entry?.filename)}`);
      }

      // Subresource-Integrity form — the same encoding npm writes into a lockfile.
      packedIntegrity = `sha512-${createHash('sha512').update(readFileSync(tgzPath)).digest('base64')}`;

      // A hand-written manifest instead of `npm init -y`: one spawn fewer, and
      // the consumer's identity is then fixed rather than derived from a tmp name.
      writeFileSync(
        join(consumerDir, 'package.json'),
        `${JSON.stringify({ name: 'so-pack-consumer', version: '1.0.0', private: true }, null, 2)}\n`,
      );

      const install = spawnSync(
        'npm',
        ['install', '--ignore-scripts', '--no-audit', '--no-fund', tgzPath],
        { cwd: consumerDir, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 },
      );
      if (install.status !== 0) {
        throw new Error(
          `npm install <tgz> failed (exit ${install.status}): ${(install.stderr || '').trim().slice(-400)}`,
        );
      }

      const lock = JSON.parse(readFileSync(join(consumerDir, 'package-lock.json'), 'utf8'));
      lockedIntegrity = lock.packages?.['node_modules/session-orchestrator']?.integrity ?? '';
    }, 300_000);

    afterAll(() => {
      removeTree(packDir);
      removeTree(consumerDir);
    });

    it('packs a tarball whose sha512 the fresh consumer lockfile records verbatim', () => {
      expect(packedIntegrity.startsWith('sha512-')).toBe(true);
      expect(packedIntegrity.length).toBeGreaterThan(20); // vacuum guard: an empty digest proves nothing
      expect(lockedIntegrity).toBe(packedIntegrity);
    });

    it('denies rm -rf from the INSTALLED hooks/pre-bash-destructive-guard.mjs with a single PreToolUse deny envelope on stdout', () => {
      const res = runInstalledGuard('rm -rf /');
      expectDeny(res, 'rm -rf');
    });

    it('allows a benign command from the INSTALLED guard with empty stdout', () => {
      const res = runInstalledGuard('ls -la');
      expectAllow(res);
    });

    it('ships hooks/run-node.sh and hooks/hooks.json so the manifest wrapper resolves under $CLAUDE_PLUGIN_ROOT', () => {
      const manifestPath = join(installedRoot, 'hooks', 'hooks.json');
      expect(existsSync(manifestPath)).toBe(true);

      // PARSE the manifest and read the `command` strings it really declares —
      // a file-wide regex over the raw JSON would also match a path inside a
      // comment-ish string that no hook entry uses.
      const referenced = pluginRootPaths(JSON.parse(readFileSync(manifestPath, 'utf8')));

      // Floor, not a pinned count: the manifest grows. It still catches a
      // manifest that parsed to nothing, which would make `missing` vacuously empty.
      expect(referenced.length).toBeGreaterThanOrEqual(10);
      expect(referenced).toContain('hooks/run-node.sh');
      expect(referenced.filter((rel) => !existsSync(join(installedRoot, rel)))).toEqual([]);
    });
  },
);

/**
 * Run the INSTALLED destructive guard exactly as the harness does: one
 * PreToolUse payload on stdin, `$CLAUDE_PLUGIN_ROOT` pointing at the installed
 * package, `$CLAUDE_PROJECT_DIR` at the consumer — a directory with no
 * `.orchestrator/policy/` of its own, so the floor policy must come out of the
 * packed tree or the guard fails open.
 *
 * @param {string} command  the Bash command the guard is asked to judge. It is
 *   only ever INSPECTED — nothing here executes it.
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runInstalledGuard(command) {
  return spawnSync(
    process.execPath,
    [join(installedRoot, 'hooks', 'pre-bash-destructive-guard.mjs')],
    {
      cwd: consumerDir,
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: 'pack-lifecycle',
        tool_name: 'Bash',
        tool_input: { command },
        cwd: consumerDir,
        hook_event_name: 'PreToolUse',
      }),
      env: {
        ...npmEnv(),
        CLAUDE_PLUGIN_ROOT: installedRoot,
        CLAUDE_PROJECT_DIR: consumerDir,
      },
    },
  );
}

/**
 * Every `$CLAUDE_PLUGIN_ROOT`-relative path the manifest's `command` strings
 * reference, de-duplicated and sorted.
 *
 * @param {unknown} manifest  the parsed `hooks/hooks.json`.
 * @returns {string[]}
 */
function pluginRootPaths(manifest) {
  const commands = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== 'object') return;
    if (typeof node.command === 'string') commands.push(node.command);
    Object.values(node).forEach(walk);
  };
  walk(manifest);

  const re = /\$(?:\{)?CLAUDE_PLUGIN_ROOT(?:\})?\/([A-Za-z0-9._/-]+)/g;
  return [...new Set(commands.flatMap((c) => [...c.matchAll(re)].map((m) => m[1])))].sort();
}
