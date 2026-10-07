import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import { accountOf, decideTtl, fitBar, fmtLeft, fmtTokens, keepObserved, langOf, missCause, observeTtl, STAGE_COLOR, stageOf } from '../hooks/cache.ts'
import type { Sample } from '../hooks/cache.ts'

const MIN = 60_000

describe('stages', () => {
  test('a 1-hour cache steps at 10, 5 and 2 minutes', () => {
    expect(stageOf(47 * MIN, '1h')).toBe('calm')
    expect(stageOf(10 * MIN + 1000, '1h')).toBe('calm')
    expect(stageOf(10 * MIN, '1h')).toBe('ten')
    expect(stageOf(5 * MIN, '1h')).toBe('five')
    expect(stageOf(2 * MIN, '1h')).toBe('two')
    expect(stageOf(1000, '1h')).toBe('two')
    expect(stageOf(0, '1h')).toBe('cold')
  })

  test('a 5-minute cache gets the same fractions: 50, 25 and 10 seconds', () => {
    expect(stageOf(4 * MIN, '5m')).toBe('calm')
    expect(stageOf(50_000, '5m')).toBe('ten')
    expect(stageOf(25_000, '5m')).toBe('five')
    expect(stageOf(10_000, '5m')).toBe('two')
  })

  test('calm is light olive and every live stage has its own colour', () => {
    expect(STAGE_COLOR.calm).toBe('#A4AE6B')
    expect(new Set(Object.values(STAGE_COLOR)).size).toBe(4)
  })
})

describe('formatting', () => {
  test('whole minutes from 5 minutes up, m:ss below', () => {
    expect(fmtLeft(60 * MIN, 'ru')).toBe('60 мин')
    expect(fmtLeft(46 * MIN + 1000, 'ru')).toBe('47 мин')
    expect(fmtLeft(5 * MIN, 'en')).toBe('5 min')
    expect(fmtLeft(4 * MIN + 59_000, 'en')).toBe('4:59')
    expect(fmtLeft(103_000, 'ru')).toBe('1:43')
    expect(fmtLeft(0, 'ru')).toBe('0:00')
  })

  test('tokens and language', () => {
    expect(fmtTokens(300)).toBe('300')
    expect(fmtTokens(152_400)).toBe('152k')
    expect(fmtTokens(1_200_000)).toBe('1.2M')
    expect(langOf('auto', 'ru_RU.UTF-8')).toBe('ru')
    expect(langOf('auto', 'en_US.UTF-8')).toBe('en')
    expect(langOf('ru', 'en_US.UTF-8')).toBe('ru')
  })
})

describe('lifetime', () => {
  test('subscription gives an hour, credits and API keys five minutes, env and option win', () => {
    expect(decideTtl('auto', {}, undefined, 'subscription')).toBe('1h')
    expect(decideTtl('auto', {}, undefined, 'credits')).toBe('5m')
    expect(decideTtl('auto', {}, undefined, 'other')).toBe('5m')
    expect(decideTtl('auto', { force5m: '1' }, undefined, 'subscription')).toBe('5m')
    expect(decideTtl('auto', { ttlVar: '1h' }, undefined, 'other')).toBe('1h')
    expect(decideTtl('5m', { enable1h: '1' }, '1h', 'subscription')).toBe('5m')
  })

  test('a full plan window means usage credits', () => {
    expect(accountOf([{ kind: 'five_hour', percentUsed: 40 }])).toBe('subscription')
    expect(accountOf([{ kind: 'seven_day', percentUsed: 100 }])).toBe('credits')
    expect(accountOf([])).toBe('other')
  })

  test('a hit 20 minutes later proves the hour; a miss 20 minutes later says five minutes', () => {
    const a: Sample = { model: 'm', startedAt: 0, read: 0, write: 50_000, fresh: 10 }
    expect(observeTtl(a, { ...a, startedAt: 20 * MIN, read: 50_000, write: 100 }, undefined)).toBe('1h')
    expect(observeTtl(a, { ...a, startedAt: 20 * MIN }, undefined)).toBe('5m')
    expect(observeTtl(a, { ...a, startedAt: 2 * MIN }, undefined)).toBe(undefined)
  })
})

describe('rebuilds the countdown did not predict', () => {
  const a: Sample = { model: 'claude-opus-5-5', effort: 'high', startedAt: 0, read: 80_000, write: 1_000, fresh: 300 }
  const hit: Sample = { ...a, startedAt: 2 * MIN, read: 81_000, write: 900 }

  test('a read of what the cache held is no rebuild', () => {
    expect(missCause(a, hit, '1h')).toBe(undefined)
    expect(missCause(undefined, hit, '1h')).toBe(undefined)
  })

  test('another model writes it all again; a context tag is the same model', () => {
    expect(missCause(a, { ...hit, model: 'claude-fable-5-1', read: 0, write: 82_000 }, '1h')).toBe('model')
    expect(missCause(a, { ...hit, model: 'claude-opus-5-5[1m]', read: 0, write: 82_000 }, '1h')).toBe('other')
  })

  test('an effort change that rebuilt, one that kept the cache, and a rebuild with no cause in sight', () => {
    expect(missCause(a, { ...hit, effort: 'low', read: 0, write: 82_000 }, '1h')).toBe('effort')
    expect(missCause(a, { ...hit, effort: 'low' }, '1h')).toBe(undefined)
    expect(missCause(a, { ...hit, read: 20_000, write: 62_000 }, '1h')).toBe('other')
  })

  test('a lapsed cache, a compaction and a small shortfall are expected', () => {
    expect(missCause(a, { ...hit, startedAt: 61 * MIN, read: 0, write: 82_000 }, '1h')).toBe(undefined)
    expect(missCause(a, { ...hit, startedAt: 6 * MIN, read: 0, write: 82_000 }, '5m')).toBe(undefined)
    expect(missCause(a, { ...hit, read: 0, write: 12_000 }, '1h')).toBe(undefined)
    expect(missCause(a, { ...hit, read: 79_500 }, '1h')).toBe(undefined)
  })

  test('a /rewind reads an earlier prefix and writes little: no rebuild', () => {
    expect(missCause(a, { ...hit, read: 60_000, write: 1_000 }, '1h')).toBe(undefined)
  })

  test('what the traffic proved starts over when the plan runs out onto credits', () => {
    expect(keepObserved('1h', 'subscription', 'credits')).toBe(undefined)
    expect(keepObserved('5m', 'credits', 'subscription')).toBe(undefined)
    expect(keepObserved('1h', 'subscription', 'subscription')).toBe('1h')
    expect(keepObserved('1h', 'subscription', 'other')).toBe('1h')
    expect(keepObserved('1h', undefined, 'credits')).toBe('1h')
  })
})

// The module end to end: a main-loop request draws the timer, a subagent's does not.
function fakeEngine(on: On, env: Record<string, string>, limits: { kind: string; percentUsed: number }[], u = { read: 80_000, write: 1_000 }) {
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: limits } }) as never)
  on('session.start', async ($, e) => ({ cwd: e.cwd }) as never)
  on('session.end', async () => ({ sessionId: 's1' }) as never)
  on('env.get', ($, e) => ({ value: env[e.name] }))
  on('clock.every', () => ({ value: undefined }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('classic.PostModelSwitch', () => ({}) as never)
  on('classic.PostCompact', () => ({}) as never)
  // the engine's own band: nothing
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('turn.step', async function* ($, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 300, output_tokens: 50, cache_read_input_tokens: u.read, cache_creation_input_tokens: u.write },
    } as never
  })
}

async function step($: Engine, over: { agentId?: string; turnId?: string; index?: number; model?: string; effort?: string } = {}) {
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3, ...over } as never)
  for (;;) {
    const n = await stream.next()
    if (n.done) return n.value
  }
}

const SUBSCRIPTION = [{ kind: 'five_hour', percentUsed: 12 }]
const HINT = { isDraft: false, isWorking: false, hint: '▸▸ auto mode on (shift+tab to cycle) · ← 1 agent' }

describe('fitting the terminal row', () => {
  test('the percent goes first, then bar cells, then the whole timer', () => {
    expect(fitBar(60, 10, 10)).toEqual({ bar: 10, hit: true })
    expect(fitBar(22, 10, 10)).toEqual({ bar: 6, hit: true })
    expect(fitBar(19, 10, 10)).toEqual({ bar: 9, hit: false })
    expect(fitBar(14, 10, 10)).toEqual({ bar: 4, hit: false })
    expect(fitBar(13, 10, 10)).toBe(undefined)
  })
})

describe('the terminal: right after the hint line', () => {
  test('nothing of ours before the first request, then an olive hour after the engine line', { options: { lang: 'ru' } }, async ($, on) => {
    fakeEngine(on, {}, SUBSCRIPTION)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    const empty = await $.ui.mount({ plugin: 'cache-timer', surface: 'terminal', component: 'PromptHint', props: HINT as never })
    expect(await empty.findAll({ type: 'Text' })).toEqual([])
    await empty.unmount()

    await step($)
    const ui = await $.ui.mount({ plugin: 'cache-timer', surface: 'terminal', component: 'PromptHint', props: HINT as never })
    expect((await ui.find({ type: 'Text', text: 'кэш' }))?.props.color).toBe('#A4AE6B')
    expect((await ui.find({ type: 'Text', text: '━━━━━━━━━━' }))?.props.color).toBe('#A4AE6B')
    expect((await ui.find({ type: 'Text', text: /^(60|59) мин$/ }))?.props.color).toBe('#A4AE6B')
    expect(await ui.find({ type: 'Text', text: '· 98%' })).toBeDefined()
    await ui.unmount()
  })

  test('the right-side slot stays the engine\'s on the terminal', async ($, on) => {
    fakeEngine(on, {}, SUBSCRIPTION)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await step($)
    const ui = await $.ui.mount({ plugin: 'cache-timer', surface: 'terminal', component: 'SessionMode', props: { modes: [] } as never })
    expect(await ui.findAll({ type: 'Text' })).toEqual([])
    await ui.unmount()
  })

  test('an API key (no plan window) counts five minutes, in English by LANG', async ($, on) => {
    fakeEngine(on, { LANG: 'en_US.UTF-8' }, [])
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await step($)
    const ui = await $.ui.mount({ plugin: 'cache-timer', surface: 'terminal', component: 'PromptHint', props: HINT as never })
    expect(await ui.find({ type: 'Text', text: 'cache' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^(5 min|4:5\d)$/ })).toBeDefined()
    await ui.unmount()
  })

  test('a subagent request leaves the line to the engine', async ($, on) => {
    fakeEngine(on, {}, SUBSCRIPTION)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await step($, { agentId: 'agent-1' })
    const ui = await $.ui.mount({ plugin: 'cache-timer', surface: 'terminal', component: 'PromptHint', props: HINT as never })
    expect(await ui.findAll({ type: 'Text' })).toEqual([])
    await ui.unmount()
  })
})

describe('the desktop: a short bar so the time stays whole', () => {
  test('SessionMode: five cells, time and percent', { options: { lang: 'ru' } }, async ($, on) => {
    fakeEngine(on, {}, SUBSCRIPTION)
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true } as never)
    await step($)
    const ui = await $.ui.mount({ plugin: 'cache-timer', surface: 'desktop', component: 'SessionMode', props: { modes: [] } as never })
    expect((await ui.find({ type: 'Text', text: '━━━━━' }))?.props.color).toBe('#A4AE6B')
    expect(await ui.find({ type: 'Text', text: /^(60|59) мин$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '· 98%' })).toBeDefined()
    await ui.unmount()
  })

  test('the hint line stays the engine\'s on the desktop', async ($, on) => {
    fakeEngine(on, {}, SUBSCRIPTION)
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true } as never)
    await step($)
    const ui = await $.ui.mount({ plugin: 'cache-timer', surface: 'desktop', component: 'PromptHint', props: HINT as never })
    expect(await ui.findAll({ type: 'Text' })).toEqual([])
    await ui.unmount()
  })

  test('the engine mode labels stay first, dim', async ($, on) => {
    fakeEngine(on, {}, SUBSCRIPTION)
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true } as never)
    await step($)
    const ui = await $.ui.mount({ plugin: 'cache-timer', surface: 'desktop', component: 'SessionMode', props: { modes: ['focus', 'memory paused'] } as never })
    const texts = await ui.findAll({ type: 'Text' })
    expect(texts[0]?.text).toBe('focus & memory paused ·')
    expect(texts[0]?.props.dimColor).toBe(true)
    expect(texts[1]?.text).toBe('cache')
    await ui.unmount()
  })
})

const mountHint = ($: Engine) => $.ui.mount({ plugin: 'cache-timer', surface: 'terminal', component: 'PromptHint', props: HINT as never })
const AMBER = '#D79A4C'

describe('a model switch, a rebuild, a compaction', () => {
  test('after /model the line says what the other model writes; back again the timer returns', { options: { lang: 'ru' } }, async ($, on) => {
    fakeEngine(on, {}, SUBSCRIPTION)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await step($)
    await $.classic.PostModelSwitch({ from_model: 'claude-opus-5-5', to_model: 'claude-fable-5-1[1m]', requested_model: 'fable', prompt_cache_warm: true } as never)
    let ui = await mountHint($)
    expect((await ui.find({ type: 'Text', text: 'другая модель · перезапишет 81k' }))?.props.color).toBe(AMBER)
    expect((await ui.find({ type: 'Text', text: '━━━━━━━━━━' }))?.props.dimColor).toBe(true)
    expect(await ui.findAll({ type: 'Text', text: /мин$/ })).toEqual([])
    await ui.unmount()

    await $.classic.PostModelSwitch({ from_model: 'claude-fable-5-1[1m]', to_model: 'claude-opus-5-5', requested_model: 'opus', prompt_cache_warm: true } as never)
    ui = await mountHint($)
    expect(await ui.find({ type: 'Text', text: '· 98%' })).toBeDefined()
    await ui.unmount()
  })

  test('a switch back to a model whose own cache still holds counts only what it lacks', { options: { lang: 'ru' } }, async ($, on) => {
    const u = { read: 80_000, write: 1_000 }
    fakeEngine(on, {}, SUBSCRIPTION, u)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await step($, { turnId: 't1' })
    u.read = 0
    u.write = 91_000
    await step($, { turnId: 't2', model: 'claude-opus-5' })
    await $.classic.PostModelSwitch({ from_model: 'claude-opus-5', to_model: 'claude-opus-5-5', requested_model: 'opus', prompt_cache_warm: true } as never)
    const ui = await mountHint($)
    expect(await ui.find({ type: 'Text', text: 'другая модель · перезапишет 10k' })).toBeDefined()
    await ui.unmount()
  })

  test('a request on another model shows the rebuild for its turn, until a later one reads the cache', { options: { lang: 'ru' } }, async ($, on) => {
    const u = { read: 80_000, write: 1_000 }
    fakeEngine(on, {}, SUBSCRIPTION, u)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await step($, { turnId: 't1' })
    u.read = 0
    u.write = 81_000
    await step($, { turnId: 't2', model: 'claude-fable-5-1' })
    u.read = 81_000
    u.write = 900
    await step($, { turnId: 't2', index: 1, model: 'claude-fable-5-1' })
    let ui = await mountHint($)
    expect((await ui.find({ type: 'Text', text: '· сброс: модель' }))?.props.color).toBe(AMBER)
    expect(await ui.find({ type: 'Text', text: /^(60|59) мин$/ })).toBeDefined()
    await ui.unmount()

    await step($, { turnId: 't3', model: 'claude-fable-5-1' })
    ui = await mountHint($)
    expect(await ui.findAll({ type: 'Text', text: /сброс/ })).toEqual([])
    expect(await ui.find({ type: 'Text', text: /^· \d+%$/ })).toBeDefined()
    await ui.unmount()
  })

  test('an effort change that rebuilt says so, in English by LANG', async ($, on) => {
    const u = { read: 80_000, write: 1_000 }
    fakeEngine(on, { LANG: 'en_US.UTF-8' }, SUBSCRIPTION, u)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await step($, { turnId: 't1', effort: 'high' })
    u.read = 0
    u.write = 81_000
    await step($, { turnId: 't2', effort: 'low' })
    const ui = await mountHint($)
    expect(await ui.find({ type: 'Text', text: '· rebuilt: effort' })).toBeDefined()
    await ui.unmount()
  })

  test('the desktop shows the rebuild in the same place', { options: { lang: 'ru' } }, async ($, on) => {
    const u = { read: 80_000, write: 1_000 }
    fakeEngine(on, {}, SUBSCRIPTION, u)
    await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true } as never)
    await step($, { turnId: 't1' })
    u.read = 20_000
    u.write = 61_000
    await step($, { turnId: 't2' })
    const ui = await $.ui.mount({ plugin: 'cache-timer', surface: 'desktop', component: 'SessionMode', props: { modes: [] } as never })
    expect((await ui.find({ type: 'Text', text: '· сброс' }))?.props.color).toBe(AMBER)
    await ui.unmount()
  })

  test('a compaction leaves nothing to count until the next request', async ($, on) => {
    fakeEngine(on, {}, SUBSCRIPTION)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
    await step($)
    await $.classic.PostCompact({ trigger: 'manual', compact_summary: 'summary' } as never)
    const ui = await mountHint($)
    expect(await ui.findAll({ type: 'Text' })).toEqual([])
    await ui.unmount()
  })
})
