#!/usr/bin/env node
// Native Windows regression probes (#1612). Fresh SessionStart needs npm-registry
// access; unavailable network is explicitly unmeasurable, never a measured PASS.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

if (process.platform !== 'win32') {
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
    const runHook = async (event, matcher, command, cwd = project, extra = {}, overrides = {}) => {
      const tool = (matcher === '*' ? 'Bash' : matcher || 'Bash').split('|')[0];
      const input = tool === 'Bash' ? { command: 'ls -la' }
        : tool === 'Skill' ? { skill: 'session-orchestrator:session' }
          : tool === 'Agent' ? { description: 'smoke', prompt: 'smoke' }
            : tool === 'AskUserQuestion' ? { questions: [] }
              : { file_path: path.join(cwd, 'src/a.mjs'), content: 'export const a = 1;\n', old_string: 'x', new_string: 'y' };
      const payload = { session_id: `windows-smoke-${path.basename(cwd)}`, cwd,
        transcript_path: path.join(cwd, 'transcript.jsonl'), permission_mode: 'default', hook_event_name: event,
        ...(event.includes('Tool') ? { tool_name: tool, tool_input: input, tool_response: {} } : {}),
        ...(event === 'SessionStart' ? { source: 'startup' } : {}),
        ...(event === 'SessionEnd' ? { reason: 'other' } : {}), ...extra };
      // Reuse the production timeout/tree cleanup; only adapt stdin for hook payloads.
      const stdoutChunks = [];
      let stdinError = null;
      const r = await spawnInGroup([bash, '-c', command], { cwd, repoRoot: cwd, timeoutMs: 5000,
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
        const r = await runHook(event, group.matcher, hook.command);
        record(name, r.exitCode === 0 && !r.timedOut && !r.stdinError,
          { exit: r.exitCode, ms: r.durationMs, stdinError: r.stdinError, output: r.output });
      });
    }
    const guard = hooks.PreToolUse.flatMap(group => group.hooks).find(hook => hook.command.includes('pre-bash-destructive-guard'));
    await probe('destructive guard', async () => {
      // Payload only: never execute this command. Split for the outer shell guard.
      const command = ['git', 'reset', '--hard', 'HEAD~1'].join(' ');
      const r = await runHook('PreToolUse', 'Bash', guard.command, project, { tool_input: { command } });
      const output = parseJson(r.stdout.trim());
      record('destructive guard', r.exitCode === 0 && !r.timedOut && !r.stdinError && output?.hookSpecificOutput?.permissionDecision === 'deny', output ?? r.output);
    });
    const start = hooks.SessionStart.flatMap(group => group.hooks).find(hook => hook.command.includes('on-session-start'));
    // Do not inherit any update kill-switch into the first-start regression path.
    const freshEnv = { SO_DISABLE_UPDATE_CHECK: undefined, DO_NOT_TRACK: undefined,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: undefined, SO_DISABLE_STARTUP_PROBES: undefined };
    for (let i = 0; i < 5; i++) await probe(`fresh SessionStart ${i + 1}`, async () => {
      const fresh = fs.mkdtempSync(path.join(work, 'fresh project '));
      // Minimal empty git repository fixture; no git-writing commands are needed.
      for (const dir of ['.git/objects', '.git/refs/heads']) fs.mkdirSync(path.join(fresh, dir), { recursive: true });
      fs.writeFileSync(path.join(fresh, '.git/HEAD'), 'ref: refs/heads/main\n');
      fs.writeFileSync(path.join(fresh, '.git/config'), '[core]\nrepositoryformatversion = 0\nbare = false\n');
      fs.writeFileSync(path.join(fresh, 'transcript.jsonl'), '');
      const r = await runHook('SessionStart', 'startup', start.command, fresh, {}, freshEnv);
      const output = parseJson(r.stdout.trim());
      const ok = r.exitCode === 0 && !r.timedOut && !r.stdinError && typeof output === 'object' && output !== null && !/Assertion failed/.test(r.fullOutput);
      record(`fresh SessionStart ${i + 1}`, ok, { exit: r.exitCode, ms: r.durationMs, output: r.output });
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
    record('Hook-Laufzeit', runtimes.length > 0 && runtimes.every(r => r.ms < 4000),
      { maxMs: Math.max(...runtimes.map(r => r.ms)), slow: runtimes.filter(r => r.ms >= 4000) });
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
