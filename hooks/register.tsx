/**
 * cache-timer: a cache countdown in the prompt footer, right after the
 * engine's hint line ("auto mode on ...") on the terminal; on the desktop in
 * the slot left of the model picker.
 *
 *   кэш ━━━━━━━━━━ 47 мин · 98%
 *
 * The bar and the time are the cache's life left; the dim percent is how much
 * of the last request the cache served. Light olive while calm, warmer at 10,
 * 5 and 2 minutes left, dimmed once expired with what the next turn will cost.
 *
 *   - turn.step: each main-loop request's usage (subagents have their own cache)
 *   - clock.every(1000): redraws only when the line changes, so from 5 minutes
 *     up it redraws once a minute
 *   - ui.render on PromptHint: the engine's line kept whole, the timer after
 *     it; on a narrow terminal the percent goes first, then bar cells
 *   - ui.render on SessionMode (desktop): the engine's mode labels, then ours
 *
 * Adapted from prompt-cache-control by claude-code-templates (MIT).
 */
import type { EngineInterface, Register } from 'claude-code'
import {
  accountOf,
  decideTtl,
  filledCells,
  fitBar,
  fmtLeft,
  fmtTokens,
  hitRatio,
  langOf,
  observeTtl,
  promptTokens,
  remainingMs,
  STAGE_COLOR,
  stageOf,
  touchedCache,
  WORDS,
} from './cache.ts'
import type { CacheEnv, Fit, Lang, Sample, Stage, Ttl } from './cache.ts'

const BAR = 10
// an expired cache this big is worth a /compact before the next turn rewrites it
const COMPACT_AT = 100_000
// below this a lapsing cache costs too little to interrupt anyone about
const TOAST_MIN_TOKENS = 20_000

let last: Sample | undefined
let prev: Sample | undefined
let ttl: Ttl = '5m'
let observed: Ttl | undefined
let env: CacheEnv = {}
let setting: unknown
let lang: Lang = 'en'
let timer: { cancel: () => void } | undefined
let lastKey = ''
let toastedFor = 0

// the promptCacheTtl setting: local over project over user settings
async function readSetting($: EngineInterface): Promise<unknown> {
  const home = await $.env.get('HOME').catch(() => undefined)
  const cwd = await $.session.cwd().catch(() => undefined)
  const files = [cwd && `${cwd}/.claude/settings.local.json`, cwd && `${cwd}/.claude/settings.json`, home && `${home}/.claude/settings.json`]
  for (const file of files) {
    if (!file) continue
    try {
      const value = JSON.parse(await $.fs.read(file)).promptCacheTtl
      if (value === '5m' || value === '1h') return value
    } catch {
      // missing or unreadable: the next file
    }
  }
  return undefined
}

async function refreshTtl($: EngineInterface, option: unknown) {
  // a subscription that runs out of plan usage moves to credits mid-session
  const account = accountOf((await $.session.usage().catch(() => undefined))?.rateLimits ?? [])
  const base = decideTtl(option, env, setting, account)
  const pinned = option === '5m' || option === '1h'
  ttl = pinned ? base : (observed ?? base)
}

function view(now: number) {
  if (!last || !touchedCache(last)) return undefined
  const left = remainingMs(last, ttl, now)
  const stage: Stage = stageOf(left, ttl)
  return { left, stage, size: promptTokens(last), hit: Math.round(hitRatio(last) * 100) }
}

const keyOf = (v: ReturnType<typeof view>) => (v ? `${v.stage}|${v.stage === 'cold' ? '' : fmtLeft(v.left, lang)}|${v.hit}` : '')

export const register: Register = (on, options) => {
  const wantToast = options.toast !== false

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    last = undefined
    prev = undefined
    observed = undefined
    lastKey = ''
    toastedFor = 0
    const none = () => undefined
    env = {
      enable1h: await $.env.get('ENABLE_PROMPT_CACHING_1H').catch(none),
      force5m: await $.env.get('FORCE_PROMPT_CACHING_5M').catch(none),
      ttlVar: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL').catch(none),
    }
    lang = langOf(options.lang, await $.env.get('LANG').catch(none))
    setting = await readSetting($)
    await refreshTtl($, options.ttl)
    $.ui.log(`cache-timer loaded: ${ttl} cache, lang ${lang}`, { to: 'debug' })

    timer?.cancel()
    timer = $.clock.every(1000, () => {
      const v = view(Date.now())
      const key = keyOf(v)
      if (key !== lastKey) {
        lastKey = key
        $.ui.invalidate('ui.render')
      }
      // one toast per cache entry, on entering the last stage
      if (wantToast && v && last && v.stage === 'two' && v.size >= TOAST_MIN_TOKENS && toastedFor !== last.startedAt) {
        toastedFor = last.startedAt
        $.ui.toast(WORDS[lang].toast(fmtLeft(v.left, lang), fmtTokens(v.size)))
      }
    })
    return r
  })

  on('session.end', async ($, e, next) => {
    // /clear starts a new conversation in the same process, and a new cache
    if (e.reason === 'clear') {
      last = undefined
      prev = undefined
      observed = undefined
      lastKey = ''
      $.ui.invalidate('ui.render')
      return next(e)
    }
    timer?.cancel()
    timer = undefined
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId) return yield* next(e)
    const startedAt = Date.now()
    const r = yield* next(e)
    if (r.usage) {
      prev = last
      last = {
        model: r.usage.model || e.model,
        startedAt,
        read: r.usage.cache_read_input_tokens,
        write: r.usage.cache_creation_input_tokens,
        fresh: r.usage.input_tokens,
      }
      observed = observeTtl(prev, last, observed)
      await refreshTtl($, options.ttl)
      lastKey = ''
      $.ui.invalidate('ui.render')
    }
    return r
  })

  // Terminal: after the engine's hint line ("auto mode on (shift+tab to
  // cycle) · ← 1 agent"), kept whole as the engine draws it; the terminal puts
  // the pair on two rows. The desktop draws no hint line (tried 04.10.2026).
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const v = view(Date.now())
    if (!v || e.surface !== 'terminal') return next(e)
    const fit = fitTerminal(e.viewport?.columns ?? 100, e.props.hint.length, v)
    if (!fit) return next(e)
    const engineLine = await next(e)
    const kit = $.ui.resolve(e)
    return (
      <kit.Box flexDirection="row" columnGap={2}>
        {engineLine}
        {drawTimer(kit, v, fit)}
      </kit.Box>
    )
  })

  // Desktop only: the slot left of the model picker, the engine's mode labels first.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const v = view(Date.now())
    if (!v || e.surface !== 'desktop') return next(e)
    const kit = $.ui.resolve(e)
    const modes = e.props.modes
    return (
      <kit.Box flexDirection="row" columnGap={1}>
        {modes.length > 0 ? <kit.Text dimColor>{`${modes.join(' & ')} ·`}</kit.Text> : null}
        {drawTimer(kit, v, DESKTOP_FIT)}
      </kit.Box>
    )
  })
}

type View = NonNullable<ReturnType<typeof view>>
type Kit = ReturnType<EngineInterface['ui']['resolve']>

// the desktop draws ━ about twice as wide as a letter and cuts the slot at
// about 10 of them plus a word: 5 keep the time and percent whole
const DESKTOP_FIT: Fit = { bar: 5, hit: true }

// the columns left of the terminal row after the hint line and the gap, and what the timer needs besides its bar
function fitTerminal(columns: number, hintLen: number, v: View): Fit | undefined {
  const words = WORDS[lang]
  const fixed = words.cache.length + 2 + (v.stage === 'cold' ? words.cold.length : fmtLeft(v.left, lang).length)
  return fitBar(columns - hintLen - 2, fixed, BAR)
}

/** label, bar, time and percent; once cold an empty dim bar and what the next turn rewrites. */
function drawTimer({ Box, Text }: Kit, v: View, fit: Fit) {
  const w = WORDS[lang]
  if (v.stage === 'cold') {
    const tail = v.size >= COMPACT_AT ? ` · ${w.compact}` : ''
    return (
      <Box flexDirection="row" columnGap={1}>
        <Text dimColor>{w.cache}</Text>
        <Text dimColor>{'━'.repeat(fit.bar)}</Text>
        <Text dimColor wrap="truncate-end">{`${w.cold} · ${w.rewrite(fmtTokens(v.size))}${tail}`}</Text>
      </Box>
    )
  }
  const color = STAGE_COLOR[v.stage]
  const filled = filledCells(v.left, ttl, fit.bar)
  return (
    <Box flexDirection="row" columnGap={1}>
      <Text color={color}>{w.cache}</Text>
      <Box flexDirection="row">
        {filled > 0 ? <Text color={color}>{'━'.repeat(filled)}</Text> : null}
        {filled < fit.bar ? <Text dimColor>{'━'.repeat(fit.bar - filled)}</Text> : null}
      </Box>
      <Text color={color}>{fmtLeft(v.left, lang)}</Text>
      {fit.hit ? <Text dimColor>{`· ${v.hit}%`}</Text> : null}
    </Box>
  )
}
