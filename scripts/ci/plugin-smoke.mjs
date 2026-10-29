#!/usr/bin/env node
// Mirror smoke (#1594): what a user's install needs, checked on the curated GitHub
// tree, which carries no tests/, vitest or eslint config. The full suite runs on
// GitLab. Needs only `npm ci`. One PASS/FAIL line per check on stdout, details on
// stderr, exit 1 on any failure. Never touches the real ~/.claude or ~/.config.
//
// Usage: node scripts/ci/plugin-smoke.mjs   (npm run test:mirror)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { spawnInGroup } from '../lib/process-group.mjs';
import { spawn, spawnSync } from '../lib/native-command.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const HOOK_TIMEOUT_MS = 60_000;
const results = [];

function record(name, ok, detail) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok && detail !== undefined) console.error(`  ${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}

async function probe(name, fn) {
  try {
    await fn();
  } catch (error) {
    record(name, false, error?.stack ?? String(error));
  }
}

/** Tracked-or-not .mjs files below `rel`, skipping node_modules. */
function mjsFiles(rel) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.mjs')) out.push(full);
    }
  };
  walk(path.join(repo, rel));
  return out;
}

/** `node --check` every file, a few at a time: one process per file is what node offers. */
async function checkSyntax(files) {
  const failed = [];
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++];
      const stderr = await new Promise((resolve) => {
        const child = spawn(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        child.stderr.on('data', (chunk) => { err += chunk; });
        child.on('error', (error) => resolve(error.message));
        child.on('close', (code) => resolve(code === 0 ? null : err.trim() || `exit ${code}`));
      });
      if (stderr !== null) failed.push(`${path.relative(repo, file)}: ${stderr.split('\n').slice(0, 5).join(' | ')}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(8, os.availableParallelism())) }, worker));
  return failed;
}

/** The shell Claude Code runs hook commands with: /bin/sh, Git Bash on Windows. */
function hookShell() {
  if (process.platform !== 'win32') return 'sh';
  return path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
}

/**
 * What a healthy SessionStart leaves behind in the isolated sandbox. The hook catches
 * its own failures (bootstrapLock() throwing, a registry write failing) and still
 * prints a valid banner with exit 0, so the banner alone proves nothing about session
 * registration. All four records must name the session id current-session.json holds.
 * @param {{ project: string, registryDir: string }} where sandbox project dir and the
 *   SO_SESSION_REGISTRY_DIR the hook ran with
 * @returns {string[]} one reason per missing effect; empty when all are present
 */
export function sessionStartEffects({ project, registryDir }) {
  const readJson = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  };
  const current = readJson(path.join(project, '.orchestrator', 'current-session.json'));
  const id = typeof current?.session_id === 'string' && current.session_id.length > 0 ? current.session_id : null;
  if (id === null) return ['.orchestrator/current-session.json missing, unreadable or without a session_id'];
  const missing = [];
  if (readJson(path.join(project, '.orchestrator', 'session.lock'))?.session_id !== id) {
    missing.push(`.orchestrator/session.lock missing or not owned by session ${id}`);
  }
  if (!fs.existsSync(path.join(registryDir, 'active', `${id}.json`))) {
    missing.push(`session registry has no active/${id}.json`);
  }
  let ledger = '';
  // ledger-root: the smoke's own fresh `git init` sandbox under tmp, never a linked worktree
  try { ledger = fs.readFileSync(path.join(project, '.orchestrator', 'metrics', 'events.jsonl'), 'utf8'); } catch { /* reported below */ }
  const started = ledger.split('\n').some((line) => {
    try {
      const ev = JSON.parse(line);
      return ev.event === 'orchestrator.session.started' && ev.session_id === id;
    } catch { return false; }
  });
  if (!started) missing.push(`events ledger has no orchestrator.session.started for session ${id}`);
  return missing;
}

async function main() {
  let work;
  try {
    await probe('plugin manifests', async () => {
      const r = spawnSync(process.execPath, [path.join(repo, 'scripts/validate-plugin-manifests.mjs'), repo],
        { encoding: 'utf8', timeout: 120_000 });
      record('plugin manifests', r.status === 0, `exit ${r.status ?? r.error?.message}\n${r.stdout}${r.stderr}`.trim());
    });

    await probe('syntax hooks/ scripts/', async () => {
      const files = [...mjsFiles('hooks'), ...mjsFiles('scripts')];
      const failed = await checkSyntax(files);
      record(`syntax hooks/ scripts/ (${files.length} files)`, files.length > 0 && failed.length === 0,
        files.length === 0 ? 'no .mjs files found' : failed.join('\n  '));
    });

    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      await probe(`dependency ${dep}`, async () => {
        // Import, not just resolve: a half-extracted package resolves and still throws.
        // A bare specifier resolves from this script's own node_modules (the repo root).
        await import(dep);
        record(`dependency ${dep}`, true);
      });
    }

    await probe('SessionStart hook', async () => {
      work = fs.mkdtempSync(path.join(os.tmpdir(), 'so-plugin-smoke-'));
      const config = path.join(work, 'config');
      const project = path.join(work, 'project');
      // Same isolation set as scripts/ci/windows-smoke.mjs: nothing reaches the real host config.
      const env = {
        ...process.env,
        SO_CONFIG_HOME: config,
        SO_SESSION_REGISTRY_DIR: path.join(config, 'sessions'),
        SO_HOST_ALIASES_FILE: path.join(config, 'host-aliases.json'),
        SO_LOOP_GUARD_DIR: path.join(work, 'loop-guard'),
        SO_VAULT_DIR: path.join(work, 'vault'),
        NAVIGATOR_CONFIG_DIR: path.join(work, 'navigator'),
        SO_EVENTS_LEDGER_SANDBOX: path.join(work, 'events.jsonl'),
        CLANK_EVENT_URL: '', CLANK_EVENT_SECRET: '',
        CLAUDE_CONFIG_DIR: path.join(work, 'claude-config'),
        XDG_CONFIG_HOME: path.join(work, 'xdg'),
        TMPDIR: work, TMP: work, TEMP: work,
        SO_TELEMETRY_DISABLED: '1',
        SO_DISABLE_UPDATE_CHECK: '1',
        SO_DISABLE_STARTUP_PROBES: '1',
        SO_HOOK_PROFILE: 'full', SO_DISABLED_HOOKS: '',
        CLAUDE_PLUGIN_ROOT: repo.replace(/[\\/]$/, ''),
        CLAUDE_PROJECT_DIR: project,
      };
      for (const dir of [config, env.SO_SESSION_REGISTRY_DIR, env.SO_LOOP_GUARD_DIR, env.SO_VAULT_DIR,
        env.CLAUDE_CONFIG_DIR, env.XDG_CONFIG_HOME, project]) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const init = spawnSync('git', ['init', '-q', project], { encoding: 'utf8', env, timeout: 30_000 });
      if (init.status !== 0) throw new Error(`git init failed: ${init.stderr || init.error?.message}`);
      fs.writeFileSync(path.join(project, 'transcript.jsonl'), '');

      // The exact command Claude Code runs, from hooks.json.
      const hooks = JSON.parse(fs.readFileSync(path.join(repo, 'hooks/hooks.json'), 'utf8')).hooks;
      const start = hooks.SessionStart.flatMap((group) => group.hooks).find((hook) => hook.command.includes('on-session-start'));
      if (!start) throw new Error('hooks.json has no on-session-start SessionStart hook');
      const payload = { session_id: 'plugin-smoke', cwd: project, transcript_path: path.join(project, 'transcript.jsonl'),
        permission_mode: 'default', hook_event_name: 'SessionStart', source: 'startup' };
      const stdoutChunks = [];
      const r = await spawnInGroup([hookShell(), '-c', start.command], { cwd: project, env, timeoutMs: HOOK_TIMEOUT_MS,
        // Reuse the production timeout and tree cleanup; only adapt stdin for the hook payload.
        spawnFn: (executable, args, options) => {
          const child = spawn(executable, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
          child.stdout.on('data', (chunk) => { stdoutChunks.push(chunk); });
          child.stdin.on('error', () => {});
          child.stdin.end(JSON.stringify(payload));
          return child;
        } });
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim();
      let output = null;
      try { output = JSON.parse(stdout); } catch { /* a crashed hook prints nothing or a stack trace */ }
      const ok = r.exitCode === 0 && !r.timedOut && typeof output?.systemMessage === 'string';
      record('SessionStart hook', ok, { exit: r.exitCode, timedOut: r.timedOut, ms: r.durationMs, stdout: stdout.slice(0, 2000), output: r.output });
      if (!ok) return;
      const missing = sessionStartEffects({ project, registryDir: env.SO_SESSION_REGISTRY_DIR });
      record('SessionStart effects (lock, current-session, registry, session.started event)', missing.length === 0, missing.join('\n  '));
    });
  } finally {
    if (work) {
      try {
        fs.rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      } catch (error) {
        record('cleanup', false, error.message);
      }
    }
    console.log(`SUMMARY ${results.filter(Boolean).length}/${results.length}`);
    process.exitCode = results.length > 0 && results.every(Boolean) ? 0 : 1;
  }
}

// Importable without running: tests call sessionStartEffects() directly.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) await main();
