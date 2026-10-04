/**
 * cache-timer: one quiet line above the prompt.
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
 *   - ui.render on AbovePrompt: the band; nothing before the first request
 *
 * Adapted from prompt-cache-control by claude-code-templates (MIT).
 */
import type { EngineInterface, Register } from 'claude-code'
import {
  accountOf,
  decideTtl,
  filledCells,
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
import type { CacheEnv, Lang, Sample, Stage, Ttl } from './cache.ts'

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

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const v = view(Date.now())
    if (!v) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const w = WORDS[lang]

    if (v.stage === 'cold') {
      const tail = v.size >= COMPACT_AT ? ` · ${w.compact}` : ''
      return (
        <Box flexDirection="row" columnGap={1}>
          <Text dimColor>{`${w.cache} ${w.cold}`}</Text>
          <Text dimColor wrap="truncate-end">{`· ${w.rewrite(fmtTokens(v.size))}${tail}`}</Text>
        </Box>
      )
    }

    const color = STAGE_COLOR[v.stage]
    const narrow = (e.viewport?.columns ?? 100) < 40
    const width = narrow ? 6 : BAR
    const filled = filledCells(v.left, ttl, width)
    return (
      <Box flexDirection="row" columnGap={1}>
        <Text color={color}>{w.cache}</Text>
        <Box key="bar" flexDirection="row">
          {filled > 0 ? <Text color={color}>{'━'.repeat(filled)}</Text> : null}
          {filled < width ? <Text dimColor>{'━'.repeat(width - filled)}</Text> : null}
        </Box>
        <Text color={color}>{fmtLeft(v.left, lang)}</Text>
        <Text dimColor>{`· ${v.hit}%`}</Text>
      </Box>
    )
  })
}
