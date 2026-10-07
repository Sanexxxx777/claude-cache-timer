/**
 * cache.ts: the pure half of cache-timer (no `$`, no engine), so it is tested
 * without one.
 *
 * The lifetime rules (decideTtl, accountOf) and the timing check (observeTtl)
 * are adapted from prompt-cache-control by claude-code-templates, MIT,
 * https://github.com/davila7/claude-code-templates. See LICENSE.
 *
 * From Anthropic's prompt-caching docs: the cache lives 5 minutes, or 1 hour
 * when asked for; every read refreshes it for free; the lifetime counts from
 * the START of the request that wrote or read it. A prompt is input_tokens
 * (uncached) + cache_read_input_tokens + cache_creation_input_tokens.
 */

export type Ttl = '5m' | '1h'
export type Account = 'subscription' | 'credits' | 'other'

export type CacheEnv = {
  enable1h?: string
  force5m?: string
  /** CLAUDE_CODE_PROMPT_CACHE_TTL */
  ttlVar?: string
}

/** One main-loop request as the API reported it. */
export type Sample = {
  model: string
  /** the effort the request asked for; absent on a model without one */
  effort?: string | number
  /** ms since the epoch when the request started */
  startedAt: number
  read: number
  write: number
  fresh: number
}

const isOn = (v: string | undefined) => v === '1' || v?.toLowerCase() === 'true'
const asTtl = (v: unknown): Ttl | undefined => (v === '5m' || v === '1h' ? v : undefined)

/**
 * The lifetime Claude Code asks for on the main conversation, first match wins
 * (code.claude.com/docs/en/prompt-caching): the mod's own option,
 * FORCE_PROMPT_CACHING_5M, CLAUDE_CODE_PROMPT_CACHE_TTL, the promptCacheTtl
 * setting, ENABLE_PROMPT_CACHING_1H, then the account: 1 hour on a
 * subscription within plan usage, 5 minutes otherwise.
 */
export function decideTtl(option: unknown, env: CacheEnv, setting?: unknown, account?: Account): Ttl {
  return (
    asTtl(option) ??
    (isOn(env.force5m) ? '5m' : undefined) ??
    asTtl(env.ttlVar) ??
    asTtl(setting) ??
    (isOn(env.enable1h) ? '1h' : undefined) ??
    (account === 'subscription' ? '1h' : '5m')
  )
}

/**
 * The account from the rate-limit windows of the last response: a five-hour
 * or seven-day window means a subscription; one at 100% means requests now
 * draw on usage credits (5-minute cache). No window says nothing.
 */
export function accountOf(windows: readonly { kind: string; percentUsed: number }[]): Account {
  const plan = windows.filter(w => w.kind === 'five_hour' || w.kind === 'seven_day')
  if (plan.length === 0) return 'other'
  return plan.some(w => w.percentUsed >= 100) ? 'credits' : 'subscription'
}

/**
 * What the traffic proved holds for one way of billing: a plan that runs out
 * onto usage credits (5 minutes) or a new window back onto it starts over.
 */
export const keepObserved = (observed: Ttl | undefined, was: Account | undefined, now: Account): Ttl | undefined =>
  was === undefined || was === 'other' || now === 'other' || was === now ? observed : undefined

export const ttlMs = (ttl: Ttl) => (ttl === '1h' ? 3_600_000 : 300_000)
export const promptTokens = (s: Sample) => s.read + s.write + s.fresh

/** Share of the prompt the cache served, 0 to 1. */
export function hitRatio(s: Sample): number {
  const total = promptTokens(s)
  return total === 0 ? 0 : s.read / total
}

/** A request that read and wrote nothing touched no cache entry: nothing to count down. */
export const touchedCache = (s: Sample) => s.read + s.write > 0

export function remainingMs(s: Sample, ttl: Ttl, now: number): number {
  return touchedCache(s) ? Math.max(0, s.startedAt + ttlMs(ttl) - now) : 0
}

// requests are timed from their start; slack keeps a hit landing just inside
// 5 minutes from reading as proof of the hour
const SLACK_MS = 10_000

/**
 * What the traffic says about the lifetime. The mod API passes only token
 * counts, not the TTL of a write, so: a hit more than 5 minutes after the
 * previous request proves 1 hour (sticky); a same-model miss 5 to 60 minutes
 * later, on a prompt that did not shrink, says 5 minutes (a later hit wins).
 */
export function observeTtl(prev: Sample | undefined, cur: Sample, known: Ttl | undefined): Ttl | undefined {
  if (!prev || !touchedCache(prev) || cur.model !== prev.model) return known
  const gap = cur.startedAt - prev.startedAt
  const before = promptTokens(prev)
  if (gap <= ttlMs('5m') + SLACK_MS) return known
  if (cur.read >= before * 0.5) return '1h'
  if (known === '1h') return known
  const lapsed = cur.write > 0 && promptTokens(cur) >= before * 0.7 && gap < ttlMs('1h') + SLACK_MS
  return lapsed ? '5m' : known
}

/** Why a cache that should still have been warm was written again. */
export type Cause = 'model' | 'effort' | 'other'

// a model id without its context tag (`[1m]`), so the engine's and a hook's spellings compare
export const baseModel = (m: string) => m.replace(/\[.*\]$/, '').toLowerCase()

/**
 * A rebuild the countdown did not predict, by the rule Claude Code counts its
 * /usage misses with: the request wrote again more than 5% and at least 2,000
 * tokens of what the warm cache held; what it did not read but did not write
 * either was cut away (/rewind). A prompt that shrank (a compaction, cleared
 * tool results) rebuilds by design, and a lapsed cache already showed as
 * cold. Each model has its own cache; so, on most models, does each effort
 * level (Opus 5.5, Sonnet 5.5 and Fable 5.1 keep theirs). Anything else is a
 * cause the API does not report: fast mode turned on, tools changed, an early
 * eviction.
 */
export function missCause(prev: Sample | undefined, cur: Sample, ttl: Ttl): Cause | undefined {
  if (!prev || !touchedCache(prev)) return undefined
  if (cur.startedAt - prev.startedAt >= ttlMs(ttl) - SLACK_MS) return undefined
  const held = promptTokens(prev)
  if (promptTokens(cur) < held * 0.7) return undefined
  const lost = Math.min(held - cur.read, cur.write + cur.fresh)
  if (lost <= held * 0.05 || lost < 2_000) return undefined
  if (baseModel(prev.model) !== baseModel(cur.model)) return 'model'
  return prev.effort !== cur.effort ? 'effort' : 'other'
}

/**
 * Colour stage by time left. On a 1-hour cache the steps are 10, 5 and 2
 * minutes; a 5-minute cache gets the same fractions of its life (50, 25, 10 s).
 */
export type Stage = 'calm' | 'ten' | 'five' | 'two' | 'cold'

const STEPS_1H_MS = { ten: 600_000, five: 300_000, two: 120_000 }

export function stageOf(leftMs: number, ttl: Ttl): Stage {
  if (leftMs <= 0) return 'cold'
  const k = ttlMs(ttl) / ttlMs('1h')
  if (leftMs <= STEPS_1H_MS.two * k) return 'two'
  if (leftMs <= STEPS_1H_MS.five * k) return 'five'
  if (leftMs <= STEPS_1H_MS.ten * k) return 'ten'
  return 'calm'
}

/** Light olive while calm, then khaki, amber, terracotta; the expired line is dimmed instead. */
export const STAGE_COLOR: Record<Exclude<Stage, 'cold'>, string> = {
  calm: '#A4AE6B',
  ten: '#C6B55E',
  five: '#D79A4C',
  two: '#CF6A4A',
}

export type Lang = 'ru' | 'en'

export const WORDS: Record<
  Lang,
  {
    cache: string
    min: string
    cold: string
    other: string
    rewrite: (t: string) => string
    reset: Record<Cause, string>
    compact: string
    toast: (left: string, t: string) => string
  }
> = {
  ru: {
    cache: 'кэш',
    min: 'мин',
    cold: 'остыл',
    other: 'другая модель',
    rewrite: t => `перезапишет ${t}`,
    reset: { model: 'сброс: модель', effort: 'сброс: усилие', other: 'сброс' },
    compact: '/compact',
    toast: (left, t) => `кэш остынет через ${left}: любое сообщение продлит его (${t} токенов)`,
  },
  en: {
    cache: 'cache',
    min: 'min',
    cold: 'expired',
    other: 'other model',
    rewrite: t => `rewrites ${t}`,
    reset: { model: 'rebuilt: model', effort: 'rebuilt: effort', other: 'rebuilt' },
    compact: '/compact',
    toast: (left, t) => `cache expires in ${left}: any message refreshes it (${t} tokens)`,
  },
}

export const langOf = (option: unknown, envLang: string | undefined): Lang =>
  option === 'ru' || option === 'en' ? option : envLang?.toLowerCase().startsWith('ru') ? 'ru' : 'en'

/** Whole minutes from 5 minutes up (calm, redraws once a minute), m:ss below. */
export function fmtLeft(ms: number, lang: Lang): string {
  const secs = Math.max(0, Math.ceil(ms / 1000))
  if (secs >= 300) return `${Math.ceil(secs / 60)} ${WORDS[lang].min}`
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/** Filled cells for the part of the lifetime left. */
export const filledCells = (leftMs: number, ttl: Ttl, width: number) =>
  Math.round(Math.min(1, Math.max(0, leftMs / ttlMs(ttl))) * width)

export type Fit = { bar: number; hit: boolean }

// the dim "· 98%" and the gap before it
const HIT_COLS = 6
const MIN_BAR = 4

/**
 * How the timer fits `free` columns when `fixed` go to its label, time and
 * gaps: the tail ("· 98%", or a rebuild's cause, `tail` columns with its gap)
 * goes first, then bar cells down to MIN_BAR; undefined when even that does
 * not fit.
 */
export function fitBar(free: number, fixed: number, max: number, tail = HIT_COLS): Fit | undefined {
  const withHit = Math.min(max, free - fixed - tail)
  if (withHit >= MIN_BAR) return { bar: withHit, hit: true }
  const bare = Math.min(max, free - fixed)
  return bare >= MIN_BAR ? { bar: bare, hit: false } : undefined
}
