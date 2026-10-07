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
 * A rebuild the countdown did not predict puts its cause in the percent's
 * place (· сброс: модель) for the rest of its turn and until the next one
 * reads the cache; after a model switch, before anything is sent, the line
 * says what the other model will write (другая модель · перезапишет 120k).
 * In Ghostty a big cache also raises a macOS notification, through
 * ~/.claude/hooks/cache-notify.sh: 2 minutes before it expires, and on a
 * rebuild nobody asked for, so a session in a background tab is not missed.
 *
 *   - turn.step: each main-loop request's usage (subagents have their own cache)
 *   - classic.PostModelSwitch: the model the next request goes to
 *   - classic.PostCompact: a new, shorter history, nothing cached for it yet
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
  baseModel,
  decideTtl,
  filledCells,
  fitBar,
  fmtLeft,
  fmtTokens,
  hitRatio,
  keepObserved,
  langOf,
  missCause,
  notifyMin,
  notifyRebuild,
  observeTtl,
  promptTokens,
  remainingMs,
  STAGE_COLOR,
  stageOf,
  touchedCache,
  WORDS,
} from './cache.ts'
import type { Account, CacheEnv, Cause, Fit, Lang, Sample, Stage, Ttl } from './cache.ts'

const BAR = 10
// an expired cache this big is worth a /compact before the next turn rewrites it
const COMPACT_AT = 100_000
// below this a lapsing cache costs too little to interrupt anyone about
const TOAST_MIN_TOKENS = 20_000
// a rebuild and a switch's pending rewrite: amber, whatever the time left
const ALERT = STAGE_COLOR.five

let last: Sample | undefined
let prev: Sample | undefined
// each model's own cache: its last main-loop request, by baseModel
const seen = new Map<string, Sample>()
// the model a switch named, until a request goes out
let nextModel: string | undefined
// the model the person last switched to, by baseModel: its rebuild was asked for,
// even when a request already in flight came back on the old one first
let chosenModel: string | undefined
// a rebuild the countdown did not predict, kept while its turn lasts
let reset: { cause: Cause; turnId: string } | undefined
let ttl: Ttl = '5m'
let observed: Ttl | undefined
let account: Account | undefined
let env: CacheEnv = {}
let setting: unknown
let lang: Lang = 'en'
let timer: { cancel: () => void } | undefined
let lastKey = ''
let toastedFor = 0
let notifiedFor = 0
// where a notification can go: Ghostty's tab of this session, by the notifier script
let notifier: { script: string; title: string } | undefined

// the conversation starts over (a new session, /clear, a compaction): nothing of it cached yet
function forget() {
  last = undefined
  prev = undefined
  seen.clear()
  nextModel = undefined
  reset = undefined
  lastKey = ''
}

// fire and forget: the script finds the session's tab itself and stays silent without one
function notify($: EngineInterface, body: string) {
  if (!notifier) return
  void $.process.run(['bash', notifier.script, notifier.title, body], { timeoutMs: 5000 }).catch(() => undefined)
}

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
  const now = accountOf((await $.session.usage().catch(() => undefined))?.rateLimits ?? [])
  observed = keepObserved(observed, account, now)
  if (now !== 'other') account = now
  const base = decideTtl(option, env, setting, now)
  const pinned = option === '5m' || option === '1h'
  ttl = pinned ? base : (observed ?? base)
}

function view(now: number) {
  if (!last || !touchedCache(last)) return undefined
  const left = remainingMs(last, ttl, now)
  const stage: Stage = stageOf(left, ttl)
  const size = promptTokens(last)
  // after a switch the next request reads only what the other model cached itself, if it still holds
  let rewrite: number | undefined
  if (nextModel !== undefined && baseModel(nextModel) !== baseModel(last.model) && stage !== 'cold') {
    const own = seen.get(baseModel(nextModel))
    rewrite = Math.max(0, size - (own && remainingMs(own, ttl, now) > 0 ? promptTokens(own) : 0))
  }
  return { left, stage, size, hit: Math.round(hitRatio(last) * 100), rewrite, reset: reset?.cause }
}

const keyOf = (v: ReturnType<typeof view>) =>
  v ? `${v.stage}|${v.stage === 'cold' ? '' : fmtLeft(v.left, lang)}|${v.hit}|${v.rewrite}|${v.reset}` : ''

export const register: Register = (on, options) => {
  const wantToast = options.toast !== false
  const minNotify = notifyMin(options.notify)

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    forget()
    observed = undefined
    account = undefined
    toastedFor = 0
    notifiedFor = 0
    chosenModel = undefined
    const none = () => undefined
    env = {
      enable1h: await $.env.get('ENABLE_PROMPT_CACHING_1H').catch(none),
      force5m: await $.env.get('FORCE_PROMPT_CACHING_5M').catch(none),
      ttlVar: await $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL').catch(none),
    }
    lang = langOf(options.lang, await $.env.get('LANG').catch(none))
    setting = await readSetting($)
    const home = await $.env.get('HOME').catch(none)
    const inGhostty = e.surface === 'terminal' && (await $.env.get('TERM_PROGRAM').catch(none)) === 'ghostty'
    notifier =
      inGhostty && home && minNotify !== undefined
        ? { script: `${home}/.claude/hooks/cache-notify.sh`, title: `Claude Code · ${e.cwd.split('/').filter(Boolean).pop() ?? e.cwd}` }
        : undefined
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
      // one toast per cache entry, on entering the last stage; after a switch no message refreshes it
      if (wantToast && v && last && v.stage === 'two' && v.rewrite === undefined && v.size >= TOAST_MIN_TOKENS && toastedFor !== last.startedAt) {
        toastedFor = last.startedAt
        $.ui.toast(WORDS[lang].toast(fmtLeft(v.left, lang), fmtTokens(v.size)))
      }
      // the same moment for a tab out of sight, from the notify option's size up
      if (notifier && minNotify !== undefined && v && last && v.stage === 'two' && v.rewrite === undefined && v.size >= minNotify && notifiedFor !== last.startedAt) {
        notifiedFor = last.startedAt
        notify($, WORDS[lang].toast(fmtLeft(v.left, lang), fmtTokens(v.size)))
      }
    })
    return r
  })

  on('session.end', async ($, e, next) => {
    // /clear starts a new conversation in the same process, and a new cache
    if (e.reason === 'clear') {
      forget()
      observed = undefined
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
        // the engine's id, as a model switch names it; the API's only when it gave none
        model: e.model || r.usage.model,
        effort: e.effort,
        startedAt,
        read: r.usage.cache_read_input_tokens,
        write: r.usage.cache_creation_input_tokens,
        fresh: r.usage.input_tokens,
      }
      observed = observeTtl(prev, last, observed)
      await refreshTtl($, options.ttl)
      const cause = missCause(prev, last, ttl)
      if (cause) reset = { cause, turnId: e.turnId }
      else if (reset?.turnId !== e.turnId) reset = undefined
      const size = promptTokens(last)
      const byUser = nextModel !== undefined || baseModel(last.model) === chosenModel
      if (cause && minNotify !== undefined && size >= minNotify && notifyRebuild(cause, byUser)) {
        notify($, WORDS[lang].rebuilt(fmtTokens(size), cause))
      }
      seen.set(baseModel(last.model), last)
      nextModel = undefined
      lastKey = ''
      $.ui.invalidate('ui.render')
    }
    return r
  })

  // /model, the desktop picker, the SDK: the next request reads only the new model's own cache.
  // Ours runs before next, and a failure of it passes the event on untouched
  on('classic.PostModelSwitch', ($, e, next) => {
    nextModel = e.to_model
    chosenModel = baseModel(e.to_model)
    lastKey = ''
    $.ui.invalidate('ui.render')
    return next(e)
  }).catch(($, e, next) => next(e))

  // the history is now a summary: the next request caches it afresh, by design
  on('classic.PostCompact', ($, e, next) => {
    forget()
    $.ui.invalidate('ui.render')
    return next(e)
  }).catch(($, e, next) => next(e))

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

// after the time: the percent, or a rebuild's cause in its place
const tailOf = (v: View) => (v.reset ? `· ${WORDS[lang].reset[v.reset]}` : `· ${v.hit}%`)

// the columns left of the terminal row after the hint line and the gap, and what the timer needs besides its bar
function fitTerminal(columns: number, hintLen: number, v: View): Fit | undefined {
  const words = WORDS[lang]
  const head = v.stage === 'cold' ? words.cold : v.rewrite !== undefined ? words.other : fmtLeft(v.left, lang)
  // cold and switched lines truncate their own tail; a live one makes room for the percent or the cause
  const tail = v.stage === 'cold' || v.rewrite !== undefined ? undefined : tailOf(v).length + 1
  return fitBar(columns - hintLen - 2, words.cache.length + 2 + head.length, BAR, tail)
}

/**
 * label, bar, time and percent (or a rebuild's cause); once cold an empty dim
 * bar and what the next turn rewrites; after a model switch an empty bar and
 * what the other model will write.
 */
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
  if (v.rewrite !== undefined) {
    return (
      <Box flexDirection="row" columnGap={1}>
        <Text color={ALERT}>{w.cache}</Text>
        <Text dimColor>{'━'.repeat(fit.bar)}</Text>
        <Text color={ALERT} wrap="truncate-end">{`${w.other} · ${w.rewrite(fmtTokens(v.rewrite))}`}</Text>
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
      {fit.hit ? (
        v.reset ? (
          <Text color={ALERT} wrap="truncate-end">
            {tailOf(v)}
          </Text>
        ) : (
          <Text dimColor>{tailOf(v)}</Text>
        )
      ) : null}
    </Box>
  )
}
