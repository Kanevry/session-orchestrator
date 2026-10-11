import type { EngineInterface, Register } from 'claude-code'
import type { SoBeacon, SoProfile, SoSnapshot } from '../types/index'
import { ageBeacon, completeState, findings, statusText, validId, validateBeacon } from './logic'

// Only these closures cross helper boundaries; the engine table never does.
type IO = {
  run: EngineInterface['process']['run']
  read: (path: string) => Promise<string>
  list: EngineInterface['fs']['list']
  now: EngineInterface['clock']['now']
  env: () => ReturnType<EngineInterface['env']['get']>
  storeGet: EngineInterface['store']['get']
  storeSet: EngineInterface['store']['set']
  sessionId: EngineInterface['session']['id']
  cwd: EngineInterface['session']['cwd']
  model: EngineInterface['session']['model']
  usage: EngineInterface['session']['usage']
  pluginRoot: () => string
}

export const register: Register = (on, options) => {
  let io: IO
  let current: SoSnapshot | null = null
  let own: SoBeacon | null = null
  let interactive = false
  let refreshing = false
  let ending = false
  let cancel: (() => void) | undefined
  let beaconWrites: Promise<unknown> = Promise.resolve()
  const problems = new Set<string>()
  const profile: SoProfile = options.strictness === 'locker' || options.strictness === 'streng' ? options.strictness : 'ausgewogen'
  const helper = async (io: IO, action: string, id = '', input: unknown = null) => {
    const result = await io.run(['node', `${io.pluginRoot()}/hooks/beacon-io.mjs`, action, id], { stdin: JSON.stringify(input), timeoutMs: 3000 })
    if (result.exitCode !== 0) throw new Error('beacon-io')
    return JSON.parse(result.stdout) as unknown
  }
  const snapshot = async (io: IO): Promise<SoSnapshot | null> => current ? {
    ...current, age_ms: Math.max(0, await io.now() - Date.parse(current.measured_at)),
    degraded: [...new Set([...current.degraded, ...problems])],
  } : null
  const root = async (io: IO): Promise<string | null> => {
    if (typeof options.soRoot === 'string' && options.soRoot.startsWith('/')) {
      await io.storeSet('so-root', options.soRoot)
      return options.soRoot
    }
    const cached = await io.storeGet('so-root')
    if (typeof cached === 'string' && cached.startsWith('/')) return cached
    const home = await io.env()
    let found: string | null = null
    if (home) {
      try { const p = (await io.read(`${home}/.config/session-orchestrator/hud/so-root`)).trim(); if (p.startsWith('/')) found = p } catch { /* try installed plugins */ }
    }
    if (!found) {
      const result = await io.run(['claude', 'plugin', 'list', '--json'], { timeoutMs: 3000 })
      if (result.exitCode === 0) {
        const data = JSON.parse(result.stdout)
        const rows: unknown[] = Array.isArray(data) ? data : Array.isArray(data.plugins) ? data.plugins : []
        for (const row of rows) {
          const p = row as { name?: string; id?: string; installPath?: string }
          if ((p.name ?? p.id ?? '').split('@')[0] === 'session-orchestrator' && p.installPath?.startsWith('/')) { found = p.installPath; break }
        }
      }
    }
    if (found) await io.storeSet('so-root', found)
    return found
  }
  const write = async (io: IO, change: Partial<SoBeacon> = {}) => {
    if (ending || !own) return
    const now = new Date(await io.now()).toISOString()
    if (ending || !own) return
    own = { ...own, ...change, seit: change.zustand && change.zustand !== own.zustand ? now : own.seit, aktualisiert_at: now }
    const value = { ...own }
    beaconWrites = beaconWrites.catch(() => undefined).then(() => helper(io, 'write', value.session_id, value))
    await beaconWrites.catch(() => { problems.add('beacon-write-failed') })
  }
  const readBeacons = async (io: IO): Promise<SoBeacon[]> => {
    const home = await io.env()
    if (!home) return []
    const dir = `${home}/.config/session-orchestrator/hud/beacons`
    const entries = await io.list(dir).catch(() => [])
    const beacons: SoBeacon[] = []
    for (const f of entries) {
      if (f.kind !== 'file' || f.isLink || f.size > 4096 || !f.name.endsWith('.json')) continue
      try { const b: unknown = JSON.parse(await io.read(`${dir}/${f.name}`)); if (validateBeacon(b) && f.name === `${b.session_id}.json`) beacons.push(b) } catch { /* skip unreadable */ }
    }
    const alive = await helper(io, 'alive', '', beacons.map(b => b.pid)).catch(() => []) as number[]
    const now = await io.now()
    return beacons.map(b => ageBeacon(b, now, b.pid !== null && alive.includes(b.pid)))
  }
  const refresh = async (io: IO) => {
    if (refreshing || ending) return
    refreshing = true
    try {
      const soRoot = await root(io)
      if (!soRoot) throw new Error('not-configured')
      const result = await io.run(['node', `${soRoot}/scripts/so-hud.mjs`, '--json', '--repo-root', await io.cwd()], { timeoutMs: 3000 })
      if (result.exitCode !== 0) throw new Error('collector-failed')
      const value = JSON.parse(result.stdout) as SoSnapshot
      if (value.schema_version !== 1 || !Number.isFinite(Date.parse(value.measured_at)) || !value.wave || !value.state || !value.gate || !value.vault || !Array.isArray(value.peers) || !Array.isArray(value.degraded)) throw new Error('invalid-snapshot')
      current = value
      for (const reason of ['not-configured', 'refresh-failed', 'collector-failed', 'invalid-snapshot']) problems.delete(reason)
    } catch (error) {
      for (const reason of ['not-configured', 'refresh-failed', 'collector-failed', 'invalid-snapshot']) problems.delete(reason)
      const reason = error instanceof Error ? error.message : ''
      problems.add(['not-configured', 'collector-failed', 'invalid-snapshot'].includes(reason) ? reason : 'refresh-failed')
    }
    finally { refreshing = false }
    try {
      const usage = await io.usage()
      await write(io, { kontext_prozent: usage.context.percent ?? null, welle: current?.wave.number ?? null })
    } catch { problems.add('usage-unavailable') }
  }

  const initialize = async (io: IO, cwd: string) => {
    ending = false
    const id = await io.sessionId()
    if (own?.session_id !== id) current = null
    if (validId(id)) {
      const now = new Date(await io.now()).toISOString()
      const identity = await helper(io, 'identity').catch(() => null) as { pid: number } | null
      own = { schema_version: 1, session_id: id, name: null, repo_name: cwd.split('/').at(-1) ?? null, branch: null,
        pid: identity?.pid ?? null, zustand: 'unbekannt', seit: now, warte_grund: null, heuristisch: false,
        kontext_prozent: null, letzter_request_at: null, modell: await io.model().catch(() => null), welle: null, aktualisiert_at: now }
    }
    await refresh(io)
  }

  // Register the whole chain before any engine call. engine.create is post-order, never caught.
  on('engine.create', async (_$, e, next) => {
    const beneath = await next(e)
    io = {
      run: (argv, init) => beneath.process.run(argv, init),
      read: (path) => beneath.fs.read(path),
      list: (path) => beneath.fs.list(path),
      now: () => beneath.clock.now(),
      env: () => beneath.env.get('HOME'),
      storeGet: (key) => beneath.store.get(key),
      storeSet: (key, value) => beneath.store.set(key, value),
      sessionId: () => beneath.session.id(),
      cwd: () => beneath.session.cwd(),
      model: () => beneath.session.model(),
      usage: () => beneath.session.usage(),
      pluginRoot: () => beneath.plugin.root,
    }
    return { ...beneath, so: { version: () => 1 as const, snapshot: () => snapshot(io), beacons: () => readBeacons(io), profile: () => profile } }
  })
  on('session.start', async ($, e, next) => {
    interactive = e.isInteractive
    await initialize(io, e.cwd)
    const updateUI = async () => {
      if (interactive && !ending) {
        $.ui.status(statusText(await snapshot(io), profile, 'de', [...problems]))
        $.ui.invalidate('ui.render')
      }
    }
    await updateUI()
    cancel?.()
    const timer = $.clock.every(15_000, async () => {
      try { await refresh(io); await updateUI() }
      catch { problems.add('refresh-failed') }
    })
    cancel = () => timer.cancel()
    return next(e)
  }).catch(($, e, next) => next(e))
  on('turn.start', async ($, e, next) => {
    if (ending || !own || own.session_id !== await io.sessionId()) {
      await initialize(io, await io.cwd())
      const updateUI = async () => {
        if (interactive && !ending) {
          $.ui.status(statusText(await snapshot(io), profile, 'de', [...problems]))
          $.ui.invalidate('ui.render')
        }
      }
      await updateUI()
      cancel?.()
      const timer = $.clock.every(15_000, async () => {
        try { await refresh(io); await updateUI() }
        catch { problems.add('refresh-failed') }
      })
      cancel = () => timer.cancel()
    }
    await write(io, { zustand: 'arbeitet', warte_grund: null, heuristisch: false, letzter_request_at: new Date(await io.now()).toISOString() })
    return next(e)
  }).catch(($, e, next) => next(e))
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) await write(io, completeState(e.answer))
    return next(e)
  }).catch(($, e, next) => next(e))
  on('tool.call', async ($, e, next) => {
    if (e.agentId) return next(e)
    if (e.tool === 'AskUserQuestion') await write(io, { zustand: 'wartet', warte_grund: 'dialog', heuristisch: false })
    else if (own?.warte_grund === 'freigabe') await write(io, { zustand: 'arbeitet', warte_grund: null, heuristisch: false })
    const result = await next(e)
    // No telemetry error can cause this tool to execute twice.
    await write(io, { zustand: 'arbeitet', warte_grund: null, heuristisch: false }).catch(() => { problems.add('beacon-write-failed') })
    return result
  }).catch(($, e, next) => next(e))
  on('tool.check', async ($, e, next) => {
    const result = await next(e)
    if (result.decision === 'ask' && !e.agentId && e.tool_use_id && e.tool !== 'AskUserQuestion') await write(io, { zustand: 'wartet', warte_grund: 'freigabe', heuristisch: false }).catch(() => { problems.add('beacon-write-failed') })
    return result
  }).catch(($, e, next) => next(e))
  on('session.end', async ($, e, next) => {
    ending = true
    cancel?.()
    await beaconWrites.catch(() => undefined)
    if (own) await helper(io, 'remove', own.session_id).catch(() => { problems.add('beacon-remove-failed') })
    own = null
    return next(e)
  }).catch(($, e, next) => next(e))
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const usage = await io.usage()
    const lines = findings(await snapshot(io), usage.context, own?.letzter_request_at ?? null, await io.now(), [...problems])
    if (!lines.length) return next(e)
    const below = await next(e)
    const { Box, Text } = $.ui.resolve(e)
    return <Box flexDirection="column"><Text color="yellow">{lines.join(' · ')}</Text>{below}</Box>
  }).catch(($, e, next) => next(e))
}
