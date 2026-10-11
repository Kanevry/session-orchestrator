import { expect, mock, test, type Plugin } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { SoBeacon, SoSnapshot } from '../types/index'

const at = '2026-10-10T15:10:00.000Z'
const measured: Omit<SoSnapshot, 'age_ms'> = {
  schema_version: 1, measured_at: at, repo: { root: '/repo', name: 'repo' }, lock: null, session: null,
  wave: { running: true, number: 2, role: 'Impl-Core', agents_total: 3, source: '.claude/wave-scope.json' },
  agents: { entries: [], source: null, at: null, degraded: null },
  state: { status: 'active', session_type: 'deep', current_wave: 2, total_waves: 5 },
  gate: { last: { variant: 'full-gate', passed: true, check_failed: null, exit_code: 0, at }, last_green_sha: null },
  peers: [], vault: { enabled: false, mode: 'warn', last_run: null, board: null }, degraded: [],
}
function world(on: On) {
  const writes: SoBeacon[] = []
  const statuses: string[] = []
  mock.clock(on, { now: Date.parse(at) })
  mock.env(on, { HOME: '/home/test' })
  mock.store(on)
  on('fs.read', () => ({ value: '' }))
  on('fs.list', () => ({ value: [] }))
  on('session.id', () => ({ value: 'test-session' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.model', () => ({ value: 'sonnet' }))
  on('session.usage', () => ({ value: { startedAt: Date.parse(at), context: { window: 200000, tokens: 40000, percent: 20 }, rateLimits: [] } }))
  on('process.run', (_$, e) => {
    let stdout = 'null'
    if (e.argv.includes('identity')) stdout = '{"pid":123}'
    else if (e.argv.includes('write')) writes.push(JSON.parse(e.init?.stdin ?? '{}') as SoBeacon)
    else if (e.argv.some(a => a.endsWith('/scripts/so-hud.mjs'))) stdout = JSON.stringify(measured)
    else if (e.argv.includes('alive')) stdout = '[123]'
    else throw new Error(`Unexpected process: ${e.argv[0]}`)
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.status', (_$, e) => { statuses.push(e.text ?? ''); return { value: undefined } })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  return { writes, statuses }
}

// A real consumer module is scanned for custom-interface calls; the test's
// engine event table itself does not expose plugin-defined nouns.
const consumer: Plugin = {
  name: 'so-consumer',
  register(on) {
    on('turn.complete', async ($) => ({ text: JSON.stringify({
      version: await $.so.version(), snapshot: await $.so.snapshot(),
      beacons: await $.so.beacons(), profile: await $.so.profile(),
    }) }))
  },
}
const probe = { answer: 'Probe', turnId: 'probe', durationMs: 0, isAborted: false, reason: 'answer' as const }

test('$.so v1 is installed and is empty before the first measurement', { options: { soRoot: '/so' }, plugins: [consumer] }, async ($, on) => {
  world(on)
  const result = await $.turn.complete(probe)
  expect(JSON.parse(result.text)).toEqual({ version: 1, snapshot: null, beacons: [], profile: 'ausgewogen' })
})
test('main turn writes working, question-wait and ready; subagent completion cannot overwrite it', { options: { soRoot: '/so' } }, async ($, on) => {
  const { writes } = world(on)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'Los', turnId: 'turn-1' })
  expect(writes.at(-1)?.zustand).toBe('arbeitet')
  await $.turn.complete({ answer: 'Soll ich weitermachen?', turnId: 'turn-1', durationMs: 10, isAborted: false, reason: 'answer' })
  expect(writes.at(-1)?.warte_grund).toBe('frage')
  expect(writes.at(-1)?.heuristisch).toBe(true)
  await $.turn.complete({ answer: 'Fertig.', agentId: 'worker', turnId: 'worker-turn', durationMs: 10, isAborted: false, reason: 'answer' })
  expect(writes.at(-1)?.warte_grund).toBe('frage')
  await $.turn.complete({ answer: 'Fertig.', turnId: 'turn-2', durationMs: 10, isAborted: false, reason: 'answer' })
  expect(writes.at(-1)?.zustand).toBe('bereit')
})
test('status uses the measured sequence and selected profile', { options: { soRoot: '/so', strictness: 'locker' }, plugins: [consumer] }, async ($, on) => {
  const { statuses } = world(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(statuses.at(-1)).toMatch(/^deep · W2\/5 · Impl-Core · 3 Agents · Gate ok \d\d:\d\d · 0 Peer · Vault aus · locker$/)
  const result = JSON.parse((await $.turn.complete(probe)).text)
  expect(result.snapshot.age_ms).toBe(0)
  expect(result.profile).toBe('locker')
})
