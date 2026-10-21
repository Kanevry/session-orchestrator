import { expect, mock, test, type Plugin } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { SoBeacon, SoSnapshot } from '../types/index'

const at = '2026-10-10T15:10:00.000Z'
const measured: Omit<SoSnapshot, 'age_ms'> = {
  schema_version: 1, measured_at: at, repo: { root: '/repo', name: 'repo' }, lock: null, session: null,
  wave: { running: true, number: 2, role: 'Impl-Core', agents_total: 3, source: '.claude/wave-scope.json' },
  agents: { entries: [], source: 'live-map', at, degraded: null, running: 3, stale_reason: null },
  state: { status: 'active', session_type: 'deep', current_wave: 2, total_waves: 5 },
  gate: { last: { variant: 'full-gate', passed: true, check_failed: null, exit_code: 0, at }, last_green_sha: null },
  peers: [], vault: { enabled: false, mode: 'warn', last_run: null, board: null }, degraded: [],
}
function world(on: On, collector: 'ok' | 'failed' | 'invalid' | 'missing' = 'ok') {
  const writes: SoBeacon[] = []
  const statuses: string[] = []
  const calls = { pluginList: 0 }
  const clock = mock.clock(on, { now: Date.parse(at) })
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
    else if (e.argv.some(a => a.endsWith('/scripts/so-hud.mjs'))) {
      if (collector === 'failed') return { value: { exitCode: 6, stdout: '', stderr: 'measurement failed', isStdoutTruncated: false, isStderrTruncated: false } }
      stdout = collector === 'invalid' ? '{}' : JSON.stringify(measured)
    }
    else if (collector === 'missing' && e.argv.includes('list')) { calls.pluginList++; stdout = '[]' }
    else if (e.argv.includes('alive')) stdout = '[123]'
    else throw new Error(`Unexpected process: ${e.argv[0]}`)
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.status', (_$, e) => { statuses.push(e.text ?? ''); return { value: undefined } })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  return { writes, statuses, calls, clock }
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

for (const failure of ['failed', 'invalid', 'missing'] as const) {
  test(`first measurement exposes ${failure} instead of losing the reason`, { options: failure === 'missing' ? {} : { soRoot: '/so' } }, async ($, on) => {
    const { statuses } = world(on, failure)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    const status = statuses.at(-1) ?? ''
    if (failure === 'missing') expect(status).toContain('nicht eingerichtet')
    else {
      expect(status).toContain('Messung fehlgeschlagen')
      expect(status).toContain(failure === 'failed' ? 'collector-failed' : 'invalid-snapshot')
      expect(status).not.toContain('nicht eingerichtet')
    }
  })
}
// Catches (F13): without a Session Orchestrator root, every 15-second refresh spawning `claude plugin list` (a miss was never cached).
test('without a root, `claude plugin list` runs once per 5 minutes, not on every refresh', async ($, on) => {
  const w = world(on, 'missing')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(w.calls.pluginList).toBe(1)
  await w.clock.advance(15_000)
  expect(w.calls.pluginList).toBe(1)
  await w.clock.advance(285_000)
  expect(w.calls.pluginList).toBe(2)
})

// ---- Profile band and /profile (#1552) --------------------------------------------
const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} }
const STRICTNESS_ROW = { label: 'Strictness profile', kind: 'choice', value: 'ausgewogen', options: ['locker', 'ausgewogen', 'streng'], isLocked: false }
/**
 * No Session Orchestrator root (F13); `denies` answers the config.set calls in order (null = written).
 * `'reload'` stands for a set that reloads the plugin: it is recorded, `reloading` resolves, and the old
 * instance never sees its answer. `'throws'` makes every set throw; `'no-row'` lists no strictness row of this plugin.
 */
function profileWorld(on: On, settings: unknown, denies: (string | null)[] | 'reload' | 'throws' | 'no-row' = []) {
  world(on, 'missing')
  let reached = () => {}
  const reloading = new Promise<void>(resolve => { reached = resolve })
  const sets: { key: string; value: unknown }[] = []
  const toasts: string[] = []
  const turns = { model: 0 }
  on('command.register', (_$, e) => ({ value: { command: (e as unknown as { name: string }).name } }) as never)
  on('settings.read', () => ({ value: settings }) as never)
  // A foreign plugin's strictness row comes first: only this plugin's row may be written.
  on('config.list', () => ({ value: [{ ...STRICTNESS_ROW, key: 'andere.strictness', provider: { plugin: 'andere', tier: 'user' } },
    ...denies === 'no-row' ? [] : [{ ...STRICTNESS_ROW, key: 'so-hud.strictness', provider: { plugin: 'so-hud', tier: 'user' } }]] }) as never)
  on('config.set', (_$, e) => {
    sets.push({ key: e.key, value: e.value })
    if (denies === 'throws') throw new Error('config write failed')
    if (denies === 'reload') {
      reached()
      return new Promise(() => {}) as never
    }
    const deny = Array.isArray(denies) ? denies.shift() ?? null : null
    return (deny === null ? { value: e.value } : { deny }) as never
  })
  on('ui.toast', (_$, e) => { toasts.push(e.text); return { value: undefined } })
  on('command.run', () => { turns.model++; return { text: 'core' } as never })
  on('ui.render', ($, e) => $.ui.resolve(e).Box({}) as never) // another mod's empty band beneath
  return { sets, toasts, turns, reloading }
}
const bandArgs = (hasSurvey = false) => ({ plugin: 'so-hud', surface: 'terminal' as const, component: 'AbovePrompt' as const, props: { ...BAND_PROPS, hasSurvey } as never })

test('first start without a chosen profile shows the band, without findings and without SO root; a survey keeps it away', async ($, on) => {
  profileWorld(on, {})
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount(bandArgs())
  expect(await band.find({ text: /^Profil: ausgewogen/ })).toBeDefined()
  for (const p of ['locker', 'ausgewogen', 'streng']) expect(await band.find({ key: `profil-${p}` })).toBeDefined()
  expect(await band.find({ key: 'profil-schliessen' })).toBeUndefined()
  expect(await (await $.ui.mount(bandArgs(true))).find({ text: /^Profil:/ })).toBeUndefined()
})
test('a choice writes this plugin\'s /config row and hides the band for good; a deny keeps the band', async ($, on) => {
  const w = profileWorld(on, {}, ['Von der Richtlinie gesperrt', null])
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount(bandArgs())
  await band.press({ key: 'profil-locker' })
  expect(w.sets).toEqual([{ key: 'so-hud.strictness', value: 'locker' }])
  expect(w.toasts.at(-1)).toContain('Von der Richtlinie gesperrt')
  expect(await band.find({ key: 'profil-locker' })).toBeDefined()
  // The refused write put the choice flag back: the next session start still shows the band.
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(await band.find({ key: 'profil-locker' })).toBeDefined()
  await band.press({ key: 'profil-streng' })
  expect(w.sets.at(-1)).toEqual({ key: 'so-hud.strictness', value: 'streng' })
  expect(await band.find({ text: /^Profil:/ })).toBeUndefined()
  // The next session start reads the stored choice: the band stays away.
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(await band.find({ text: /^Profil:/ })).toBeUndefined()
})
// Catches (#1552): a choice that stored nothing leaving the flag it wrote first set, so the band never came back.
for (const [name, mode] of [['no /config row of this plugin', 'no-row'], ['$.config.set throwing', 'throws']] as const) {
  test(`a choice with ${name} puts the flag back: the next session start still shows the band`, async ($, on) => {
    const w = profileWorld(on, {}, mode)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    const band = await $.ui.mount(bandArgs())
    await band.press({ key: 'profil-locker' })
    expect(w.toasts.at(-1)).toContain('Profil nicht gespeichert')
    expect(w.sets).toEqual(mode === 'throws' ? [{ key: 'so-hud.strictness', value: 'locker' }] : [])
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    expect(await band.find({ text: /^Profil:/ })).toBeDefined()
  })
}
// Catches (#1552): "Schließen" on a first-run band only cleared /profile's flag, so the band stayed although closed.
test('closing the first-run band hides it for this session; the next session start shows it again', async ($, on) => {
  profileWorld(on, {})
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount(bandArgs())
  await $.command.run({ command: 'profile', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  await band.press({ key: 'profil-schliessen' })
  expect(await band.find({ text: /^Profil:/ })).toBeUndefined()
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(await band.find({ text: /^Profil:/ })).toBeDefined()
})
// Catches (#1552): the choice flag stored after $.config.set, which reloads the plugin — the old instance never
// reached the store write, choosing the default profile left no setting to read, and the band came back.
test('the choice is stored before the /config write that reloads the plugin', async ($, on) => {
  const w = profileWorld(on, {}, 'reload')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount(bandArgs())
  await band.press({ key: 'profil-ausgewogen' })
  await w.reloading
  expect(w.sets).toEqual([{ key: 'so-hud.strictness', value: 'ausgewogen' }])
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(await band.find({ text: /^Profil:/ })).toBeUndefined()
})
test('/profile answers without a model turn and reopens the band after a choice made in /config', { options: { strictness: 'streng' } }, async ($, on) => {
  const w = profileWorld(on, { pluginConfigs: { 'so-hud@session-orchestrator': { options: { strictness: 'streng' } } } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount(bandArgs())
  expect(await band.find({ text: /^Profil:/ })).toBeUndefined()
  const result = await $.command.run({ command: 'profile', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect((result.text ?? '').split('\n').slice(0, 2)).toEqual(['Profil: streng', 'Regel-Fallen und Kollisionen abgelehnt.'])
  expect(result.context ?? []).toHaveLength(0)
  expect(w.turns.model).toBe(0)
  await band.press({ key: 'profil-schliessen' })
  expect(await band.find({ text: /^Profil:/ })).toBeUndefined()
})
