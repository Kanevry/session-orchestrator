#!/usr/bin/env node
// Native Windows regression probes (#1612). Fresh SessionStart needs npm-registry
// access; unavailable network is explicitly unmeasurable, never a measured PASS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from '../lib/native-command.mjs';
import { isMainModule } from '../lib/is-main-module.mjs';

/**
 * The tool name and input a hook group's probe sends (#1901 4d). A group
 * whose matcher names `PowerShell` gets a PowerShell payload — before, every
 * matcher became `Bash`, so the PowerShell guard group was never probed as
 * PowerShell.
 *
 * @param {string|undefined} matcher - the hooks.json group matcher
 * @param {string} cwd
 * @returns {{ tool: string, input: object }}
 */
export function hookToolPayload(matcher, cwd) {
  const names = !matcher || matcher === '*' ? ['Bash'] : matcher.split('|');
  const tool = names.includes('PowerShell') ? 'PowerShell' : names[0];
  const input = tool === 'Bash' ? { command: 'ls -la' }
    : tool === 'PowerShell' ? { command: 'Get-ChildItem' }
      : tool === 'Skill' ? { skill: 'session-orchestrator:session' }
        : tool === 'Agent' ? { description: 'smoke', prompt: 'smoke' }
          : tool === 'AskUserQuestion' ? { questions: [] }
            : { file_path: path.join(cwd, 'src/a.mjs'), content: 'export const a = 1;\n', old_string: 'x', new_string: 'y' };
  return { tool, input };
}

/**
 * Protected-path removals the PowerShell guard group must deny, in the drive
 * (`C:/…`) and the MSYS (`/c/…`) spelling (#1901 4d). Payload only — never run.
 */
export const POWERSHELL_PROTECTED_COMMANDS = Object.freeze([
  ['rm', '-rf', 'C:/Users/Public/Documents'].join(' '),
  ['rm', '-rf', '/c/Users/Public/Documents'].join(' '),
]);

/**
 * A native win32 path in the three spellings a Bash command on Windows can
 * carry: drive (`C:/…`), MSYS (`/c/…`) and native (`C:\\…`).
 *
 * @param {string} nativePath - absolute win32 path, e.g. `C:\\Users\\x`
 * @returns {{ drive: string, msys: string, native: string }}
 */
export function windowsPathSpellings(nativePath) {
  const native = path.win32.normalize(nativePath);
  const drive = native.split('\\').join('/');
  const msys = drive.replace(/^([A-Za-z]):/, (_, letter) => `/${letter.toLowerCase()}`);
  return { drive, msys, native };
}

/**
 * Bash-group probes that exercise Windows path normalisation in the
 * destructive guard (#1901 4d): a truncating redirect onto the protected
 * `<project>/CLAUDE.md` (rule `redirect-truncate-protected`; one protected
 * instruction file is enough here, its Codex twin AGENTS.md is the same rule) and a delete of the
 * sessions ledger (rule `ledger-delete-protected`), each in every spelling —
 * plus an ALLOW control onto `<project>/NOTES.md`, so a guard that denies
 * everything cannot pass. Payload only — never run.
 *
 * @param {string} project - the probe's real (native win32) project root
 * @returns {{ command: string, expect: 'deny'|'allow' }[]}
 */
export function bashProtectedPathProbes(project) {
  const { drive, msys, native } = windowsPathSpellings(project);
  const redirect = (root, sepChar, file) => `echo x > "${root}${sepChar}${file}"`;
  // Split for the outer shell guard, like the git-reset probe below.
  const remove = (root) => ['rm', '-f', `"${root}/.orchestrator/metrics/sessions.jsonl"`].join(' ');
  return [
    { command: redirect(drive, '/', 'CLAUDE.md'), expect: 'deny' },
    { command: redirect(msys, '/', 'CLAUDE.md'), expect: 'deny' },
    { command: redirect(native, '\\', 'CLAUDE.md'), expect: 'deny' },
    { command: remove(drive), expect: 'deny' },
    { command: remove(msys), expect: 'deny' },
    { command: redirect(drive, '/', 'NOTES.md'), expect: 'allow' },
  ];
}

/**
 * The timeout the harness gives this hook, in ms (#1920): hooks.json's
 * `timeout` (seconds), or Claude Code's 5 s fallback when the entry has none.
 * Before, the smoke killed every hook after a hard-coded 5 s although
 * SessionStart is granted 10 s — a loaded host then failed a hook that the
 * real harness would have let finish.
 *
 * @param {object} _group - the hooks.json group (matcher); timeouts live on the entry
 * @param {{ timeout?: number }} hookEntry
 * @returns {number}
 */
export function hookTimeoutMs(_group, hookEntry) {
  const seconds = hookEntry?.timeout;
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5000;
}

/**
 * Where a fresh SessionStart spent its time (#1920): `hook_phase_ms` and, when
 * present, `hook_skipped` and `hook_git_timeouts` (#1934 — which git call hit
 * its timeout, the open question for slow Windows starts) of the
 * `orchestrator.session.started` event in that
 * project's ledger. A killed hook writes no event — then the split is
 * `nicht messbar`, never an empty measurement. Unreadable lines are skipped
 * AND counted (`malformed_lines`), so a torn ledger is visible.
 *
 * @param {string|null} ledgerText - the ledger's content, null when it does not exist
 * @returns {object}
 */
export function sessionStartSplit(ledgerText) {
  let started = null;
  let malformed = 0;
  for (const line of (ledgerText ?? '').split('\n')) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { malformed++; continue; }
    if (record?.event === 'orchestrator.session.started') started = record;
  }
  const split = started
    ? {
      hook_phase_ms: started.hook_phase_ms ?? null,
      ...(started.hook_skipped ? { hook_skipped: started.hook_skipped } : {}),
      ...(started.hook_git_timeouts ? { hook_git_timeouts: started.hook_git_timeouts } : {}),
    }
    : { split: 'nicht messbar: no started event' };
  return malformed > 0 ? { ...split, malformed_lines: malformed } : split;
}

if (!isMainModule(import.meta.url)) {
  // Imported (tests): export the payload helpers only.
} else if (process.platform !== 'win32') {
  console.log('windows-smoke: nur win32');
  console.log('SUMMARY 0/0');
} else {
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const { runCheck } = await import('../lib/gates/gate-helpers.mjs');
  const { spawnInGroup } = await import('../lib/process-group.mjs');
  const { REGISTRY_URL, CACHE_FILENAME, readCachedLatest } = await import('../lib/plugin-update-banner.mjs');
  const { httpRequest } = await import('../lib/http-request.mjs');
  // Hook stdout is untrusted: a crashed hook prints nothing or a stack trace.
  const parseJson = (text) => { try { return JSON.parse(text); } catch { return null; } };
  const results = [];
  const record = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} :: ${JSON.stringify(detail)}`);
  };
  const probe = async (name, fn) => {
    try { await fn(); } catch (error) { record(name, false, error.message); }
  };
  let work;
  try {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'so windows smoke '));
    const config = path.join(work, 'private config');
    const env = {
      ...process.env,
      SO_CONFIG_HOME: config,
      SO_SESSION_REGISTRY_DIR: path.join(config, 'sessions'),
      SO_HOST_ALIASES_FILE: path.join(config, 'host-aliases.json'),
      SO_LOOP_GUARD_DIR: path.join(work, 'loop guard'),
      SO_VAULT_DIR: path.join(work, 'vault'),
      NAVIGATOR_CONFIG_DIR: path.join(work, 'navigator'),
      SO_EVENTS_LEDGER_SANDBOX: path.join(work, 'events.jsonl'),
      CLANK_EVENT_URL: '', CLANK_EVENT_SECRET: '',
      CLAUDE_CONFIG_DIR: path.join(work, 'claude config'),
      XDG_CONFIG_HOME: path.join(work, 'xdg'),
      TMPDIR: work, TMP: work, TEMP: work,
      SO_TELEMETRY_DISABLED: '1',
      SO_DISABLE_UPDATE_CHECK: '1',
      SO_DISABLE_STARTUP_PROBES: '1',
      SO_HOOK_PROFILE: 'full', SO_DISABLED_HOOKS: '',
    };
    for (const dir of [config, env.SO_SESSION_REGISTRY_DIR, env.SO_LOOP_GUARD_DIR,
      env.SO_VAULT_DIR, env.CLAUDE_CONFIG_DIR, env.XDG_CONFIG_HOME]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const node = `"${process.execPath}"`;
    await probe('gate capture', async () => {
      const r = await runCheck(`${node} -e "console.log('out-äöü-€'); console.error('err-line')"`, { repoRoot: work, cwd: work, env });
      record('gate capture', r.status === 'pass' && r.fullOutput.includes('out-äöü-€') && r.fullOutput.includes('err-line'), r.fullOutput);
    });
    for (const code of [0, 3]) await probe(`gate exit ${code}`, async () => {
      const r = await runCheck(`${node} -e "process.exit(${code})"`, { repoRoot: work, cwd: work, env });
      record(`gate exit ${code}`, r.exitCode === code && r.status === (code === 0 ? 'pass' : 'fail'), { exit: r.exitCode, status: r.status });
    });
    await probe('gate missing command', async () => {
      const r = await runCheck('so-windows-smoke-definitely-not-a-command', { repoRoot: work, cwd: work, env });
      // `cmd /d /s /c` exits 1 for an unknown command (9009 only inside batch
      // files), so the hint text is absent on Windows; what must hold is that a
      // missing command is a failure, never a skip (#1612, GH#76 point 5).
      record('gate missing command', r.status === 'fail' && r.exitCode !== 0, { status: r.status, exitCode: r.exitCode });
    });
    await probe('gate timeout tree', async () => {
      const pidsDir = path.join(work, 'pids');
      fs.mkdirSync(pidsDir);
      const grandchild = path.join(work, 'grandchild.mjs');
      const child = path.join(work, 'child.mjs');
      fs.writeFileSync(grandchild, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(pidsDir)} + '/gc-' + process.pid, ''); setInterval(() => {}, 1000);`);
      fs.writeFileSync(child, `import fs from 'node:fs'; import { spawn } from 'node:child_process'; fs.writeFileSync(${JSON.stringify(pidsDir)} + '/ch-' + process.pid, ''); for (let i=0;i<2;i++) spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`);
      const r = await runCheck(`${node} "${child}"`, { repoRoot: work, cwd: work, env, timeoutMs: 4000 });
      const pids = fs.readdirSync(pidsDir).map(f => Number(f.split('-')[1]));
      await new Promise(resolve => setTimeout(resolve, 1500));
      const still = pids.filter(pid => {
        const check = spawnSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', timeout: 5000 });
        if (check.error || check.status !== 0) throw new Error(`tasklist failed: ${check.error?.message ?? check.status}`);
        return check.stdout.includes(`"${pid}"`);
      });
      record('gate timeout tree', r.status === 'fail' && r.timedOut && pids.length === 3 && still.length === 0 && r.survivors?.length === 0,
        { pids, still, timedOut: r.timedOut, survivors: r.survivors, output: r.output });
      for (const pid of still) {
        const killed = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', timeout: 5000 });
        if (killed.error || killed.status !== 0) throw new Error(`survivor cleanup failed: ${pid}`);
      }
    });
    await probe('argv literal', async () => {
      const dir = path.join(work, "dir with space's");
      fs.mkdirSync(dir);
      const script = path.join(dir, 'argv.mjs');
      fs.writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(1)));');
      const args = [script, 'a b', "it's", '%PATH%', '&echo x'];
      const r = await spawnInGroup([process.execPath, ...args], { repoRoot: work, cwd: work, env, timeoutMs: 20000 });
      const parsed = JSON.parse(r.fullOutput.trim());
      record('argv literal', r.exitCode === 0 && JSON.stringify(parsed) === JSON.stringify(args), parsed);
    });

    const bash = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
    const hooks = JSON.parse(fs.readFileSync(path.join(repo, 'hooks/hooks.json'), 'utf8')).hooks;
    const project = path.join(work, 'project with spaces');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'transcript.jsonl'), '');
    const runtimes = [];
    const runHook = async (event, group, hook, cwd = project, extra = {}, overrides = {}) => {
      const { command } = hook;
      const { tool, input } = hookToolPayload(group.matcher, cwd);
      const payload = { session_id: `windows-smoke-${path.basename(cwd)}`, cwd,
        transcript_path: path.join(cwd, 'transcript.jsonl'), permission_mode: 'default', hook_event_name: event,
        ...(event.includes('Tool') ? { tool_name: tool, tool_input: input, tool_response: {} } : {}),
        ...(event === 'SessionStart' ? { source: 'startup' } : {}),
        ...(event === 'SessionEnd' ? { reason: 'other' } : {}), ...extra };
      // Reuse the production timeout/tree cleanup; only adapt stdin for hook payloads.
      const stdoutChunks = [];
      let stdinError = null;
      const r = await spawnInGroup([bash, '-c', command], { cwd, repoRoot: cwd, timeoutMs: hookTimeoutMs(group, hook),
        env: { ...env, CLAUDE_PLUGIN_ROOT: repo, CLAUDE_PROJECT_DIR: cwd, ...overrides },
        spawnFn: (executable, args, options) => {
          const child = spawn(executable, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
          child.stdout.on('data', chunk => { stdoutChunks.push(chunk); });
          child.stdin.on('error', error => {
            stdinError = error.message;
          });
          child.stdin.end(JSON.stringify(payload));
          return child;
        } });
      runtimes.push({ event, command, ms: r.durationMs });
      return { ...r, stdout: Buffer.concat(stdoutChunks).toString('utf8'), stdinError };
    };
    for (const [event, groups] of Object.entries(hooks)) for (const group of groups) for (const hook of group.hooks) {
      const name = `${event}/${path.basename(hook.command.split('"').at(-2) || hook.command)}`;
      await probe(name, async () => {
        const r = await runHook(event, group, hook);
        record(name, r.exitCode === 0 && !r.timedOut && !r.stdinError,
          { exit: r.exitCode, ms: r.durationMs, stdinError: r.stdinError, output: r.output });
      });
    }
    const guardGroup = hooks.PreToolUse.find(group => group.hooks.some(hook => hook.command.includes('pre-bash-destructive-guard')));
    const guard = guardGroup.hooks.find(hook => hook.command.includes('pre-bash-destructive-guard'));
    await probe('destructive guard', async () => {
      // Payload only: never execute this command. Split for the outer shell guard.
      const command = ['git', 'reset', '--hard', 'HEAD~1'].join(' ');
      const r = await runHook('PreToolUse', { ...guardGroup, matcher: 'Bash' }, guard, project, { tool_input: { command } });
      const output = parseJson(r.stdout.trim());
      record('destructive guard', r.exitCode === 0 && !r.timedOut && !r.stdinError && output?.hookSpecificOutput?.permissionDecision === 'deny', output ?? r.output);
    });
    const psGroup = hooks.PreToolUse.find(group => (group.matcher || '').split('|').includes('PowerShell'));
    const psGuard = psGroup?.hooks.find(hook => hook.command.includes('pre-bash-destructive-guard'));
    for (const command of POWERSHELL_PROTECTED_COMMANDS) await probe(`destructive guard PowerShell ${command}`, async () => {
      if (!psGuard) throw new Error('no PowerShell group carries pre-bash-destructive-guard');
      const r = await runHook('PreToolUse', psGroup, psGuard, project, { tool_input: { command } });
      const output = parseJson(r.stdout.trim());
      record(`destructive guard PowerShell ${command}`, r.exitCode === 0 && !r.timedOut && !r.stdinError
        && output?.hookSpecificOutput?.permissionDecision === 'deny', output ?? r.output);
    });
    for (const { command, expect } of bashProtectedPathProbes(fs.realpathSync.native(project))) await probe(`destructive guard Bash ${expect} ${command}`, async () => {
      const r = await runHook('PreToolUse', { ...guardGroup, matcher: 'Bash' }, guard, project, { tool_input: { command } });
      const output = parseJson(r.stdout.trim());
      const denied = output?.hookSpecificOutput?.permissionDecision === 'deny';
      record(`destructive guard Bash ${expect} ${command}`, r.exitCode === 0 && !r.timedOut && !r.stdinError
        && denied === (expect === 'deny'), output ?? r.output);
    });
    const startGroup = hooks.SessionStart.find(group => group.hooks.some(hook => hook.command.includes('on-session-start')));
    const start = startGroup.hooks.find(hook => hook.command.includes('on-session-start'));
    // Do not inherit any update kill-switch into the first-start regression path.
    const freshEnv = { SO_DISABLE_UPDATE_CHECK: undefined, DO_NOT_TRACK: undefined,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: undefined, SO_DISABLE_STARTUP_PROBES: undefined };
    const FRESH_RUNS = 5;
    // #1920 revisit signal (a): fresh starts the harness timeout killed (exit 124).
    let freshKilled = 0;
    for (let i = 0; i < FRESH_RUNS; i++) await probe(`fresh SessionStart ${i + 1}`, async () => {
      const fresh = fs.mkdtempSync(path.join(work, 'fresh project '));
      // Minimal empty git repository fixture; no git-writing commands are needed.
      for (const dir of ['.git/objects', '.git/refs/heads']) fs.mkdirSync(path.join(fresh, dir), { recursive: true });
      fs.writeFileSync(path.join(fresh, '.git/HEAD'), 'ref: refs/heads/main\n');
      fs.writeFileSync(path.join(fresh, '.git/config'), '[core]\nrepositoryformatversion = 0\nbare = false\n');
      fs.writeFileSync(path.join(fresh, 'transcript.jsonl'), '');
      const r = await runHook('SessionStart', { ...startGroup, matcher: 'startup' }, start, fresh, {}, freshEnv);
      if (r.exitCode === 124) freshKilled++;
      // #1920: the hook's own phase split from the fresh project's ledger
      // (CLAUDE_PROJECT_DIR = fresh, under the temp root, so not sandboxed;
      // fresh is a standalone repo, never a linked worktree).
      let ledger = null;
      const ledgerPath = path.join(fresh, '.orchestrator', 'metrics', 'events.jsonl'); // ledger-root: throwaway standalone fixture repo, not a linked worktree
      try { ledger = fs.readFileSync(ledgerPath, 'utf8'); } catch { /* no ledger → nicht messbar */ }
      const output = parseJson(r.stdout.trim());
      const ok = r.exitCode === 0 && !r.timedOut && !r.stdinError && typeof output === 'object' && output !== null && !/Assertion failed/.test(r.fullOutput);
      record(`fresh SessionStart ${i + 1}`, ok, { exit: r.exitCode, ms: r.durationMs, ...sessionStartSplit(ledger), output: r.output });
      if (!ok) return;
      const cacheDir = path.join(fresh, '.orchestrator/runtime');
      const cache = readCachedLatest({ cacheDir });
      if (cache) record(`fresh update ${i + 1}`, true, { version: cache.version });
      else {
        // A missing cache alone cannot distinguish offline from a broken hook.
        let reachable = false;
        try {
          // Never fetch here: fetch + exit is the Windows crash this smoke guards (#1612).
          const response = await httpRequest(REGISTRY_URL, { timeoutMs: 2000 });
          reachable = response.ok && typeof (await response.json())?.version === 'string';
        } catch (error) {
          console.log(`INFO fresh update ${i + 1} :: ${JSON.stringify(error.message)}`);
        }
        if (reachable || fs.existsSync(path.join(cacheDir, CACHE_FILENAME))) {
          record(`fresh update ${i + 1}`, false, 'registry reachable or cache invalid, but hook wrote no usable cache');
        } else console.log(`SKIP fresh update ${i + 1} :: nicht messbar: npm registry unavailable (network required)`);
      }
    });
    console.log(`INFO fresh SessionStart killed (exit 124) :: ${freshKilled}/${FRESH_RUNS}`);
    // SessionStart is exempt (#1920): its budget is 10 s and it carries the
    // startup probes plus the npm update check; the other hooks keep 4 s.
    const timed = runtimes.filter(r => r.event !== 'SessionStart');
    record('Hook-Laufzeit', timed.length > 0 && timed.every(r => r.ms < 4000),
      { maxMs: Math.max(...timed.map(r => r.ms)), slow: timed.filter(r => r.ms >= 4000) });
  } catch (error) {
    record('smoke setup', false, error.message);
  } finally {
    if (work) {
      try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); }
      catch (error) { record('cleanup', false, error.message); }
    }
    console.log(`SUMMARY ${results.filter(Boolean).length}/${results.length}`);
    process.exitCode = results.every(Boolean) ? 0 : 1;
  }
}
