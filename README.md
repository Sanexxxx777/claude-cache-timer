# cache-timer

How long until Claude Code's prompt cache goes cold, in the prompt footer of the terminal and the desktop app.

```
cache ━━━━━━━━━━ 47 min · 98%
```

The bar shrinks as the cache ages. The percent is the share of the last request the cache served. With plenty of time left the line is light olive. It turns khaki at 10 minutes left, amber at 5 and terracotta at 2. Once the cache expires the bar empties, the line goes grey and says how many tokens the next turn will write again, with `/compact` from 100k tokens up.

Where it sits:

- **Terminal:** on the row right under Claude Code's hint line (`auto mode on (shift+tab to cycle)`), which stays as Claude Code draws it. On a narrow window the percent goes first, then bar cells.
- **Desktop app:** under the prompt box, left of the model picker, with a shorter bar (5 cells) because the app draws `━` wider than a letter. The desktop has no hint line to sit beside.

This is a Claude Code mod: hooks that run inside Claude Code itself. A one-second clock redraws the line, so the countdown moves while you're idle. It only repaints when the text or colour changes, which is once a minute until the last 5 minutes.

## Why it usually says an hour

On a Claude subscription Claude Code asks for the 1-hour cache by itself. API keys, cloud providers and usage credits get 5 minutes. The mod follows Claude Code's documented order (`FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, the `promptCacheTtl` setting, `ENABLE_PROMPT_CACHING_1H`, then the account), notices when a subscription runs out of plan usage and falls back to credits, and checks itself against request timing: a cache hit 20 minutes after the previous request proves the hour.

On a 5-minute cache the colour steps scale down to 50, 25 and 10 seconds.

## When the cache is rebuilt early

The countdown assumes the next request reads what the last one cached. Some changes break that before the time runs out, and the line says so.

- **Model switch.** Each model has its own cache. Right after `/model` or the desktop picker, before you send anything, the line turns amber: `cache ━━━━━━━━━━ other model · rewrites 81k`. The number is what the other model will write, less anything it still holds from earlier in the conversation. Switch back and the timer returns.
- **A rebuild the countdown did not predict.** When a request writes again more than 5% and at least 2,000 tokens of what the warm cache held (the rule Claude Code uses for misses in `/usage`), the percent gives way to the cause for the rest of that turn: `· rebuilt: model` when the engine changed the model itself (a fallback, a skill's model), `· rebuilt: effort` when the effort level changed (on most models each level has its own cache), or `· rebuilt` when the cause is out of a mod's sight: fast mode turned on, tools changed, an early eviction. A prompt that shrank (`/compact`, cleared tool results) or went back with `/rewind` does not count.
- **`/compact`.** The line clears until the next request, because the old size no longer applies.
- **Usage credits.** When a subscription runs out of plan usage, Claude Code drops to the 5-minute cache. The mod drops an hour it had proven from timing and counts five minutes.

Claude Code works out the likely cause of a miss itself, for `/usage` and status line scripts (`prompt_cache.last_miss_cause`), but it does not pass it to mods, so the mod reads it from the token counts and the events it can see.

## A notification in Ghostty

In [Ghostty](https://ghostty.org) on macOS, a big cache also raises a desktop notification, so a session in a background tab is not missed:

- 2 minutes before it expires (10 seconds on a 5-minute cache), the same moment as the toast: `cache expires in 0:10: any message refreshes it (170k tokens)`;
- when it is written again and nobody asked for that: the engine changed the model by itself, or the cause is out of sight. Your own `/model` switch and an effort change stay quiet.

By default only prompts of 100k tokens or more raise one; the `notify` option changes that. Other terminals and the desktop app get none, and Ghostty may hold one back while you are looking at that window.

The mod passes the text to a small script that finds the session's terminal and writes the OSC 777 sequence Ghostty turns into a notification. Put the script where the mod looks for it:

```sh
mkdir -p ~/.claude/hooks
cp ~/claude-cache-timer/scripts/cache-notify.sh ~/.claude/hooks/
```

Without it nothing is sent. If no banner shows up, open System Settings → Notifications → Ghostty: notifications can be allowed there with the Desktop box unticked.

## Install

Tested on Claude Code 2.1.289 and 2.1.290. Mods are early access, and their `$` API may change between releases.

```sh
git clone https://github.com/Sanexxxx777/claude-cache-timer ~/claude-cache-timer
```

Try it for one session:

```sh
claude --plugin-dir ~/claude-cache-timer
```

Load it in every session (the desktop app included) through the `env` block of `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "~/claude-cache-timer" } }
```

The line appears after the first request of a session.

## Options

Set them in `~/.claude/settings.json`:

```json
{ "pluginConfigs": { "cache-timer": { "options": { "lang": "ru" } } } }
```

| Option | Values | Default |
| --- | --- | --- |
| `lang` | `auto` reads `LANG` (`ru_*` gives Russian), or `ru` / `en` | `auto` |
| `ttl` | `auto`, or pin `5m` / `1h` | `auto` |
| `toast` | one toast when the last stage starts, for prompts of 20k tokens or more | `true` |
| `notify` | the Ghostty notification: for prompts of `100k` tokens or more, `all`, or `off` | `100k` |

## What it touches

Hooks: `session.start`, `session.end`, `turn.step` (main-loop requests only, subagents have their own cache), `classic.PostModelSwitch` (which model the next request goes to), `classic.PostCompact`, and `ui.render` on `PromptHint` (terminal) and `SessionMode` (desktop). It reads `HOME`, `LANG`, `TERM_PROGRAM` and the three cache variables above, plus `promptCacheTtl` from your settings files. It makes no network calls and writes no files. The one process it starts is the notification script, and only in Ghostty: `bash ~/.claude/hooks/cache-notify.sh <title> <body>`, which writes one escape sequence to the session's terminal and nothing else. `claude plugin validate .` prints the same list.

## Tests

```sh
claude plugin test .
bash tests/cache-notify-test.sh
```

38 tests: colour stages for both lifetimes, time format, lifetime rules, when a rebuild counts and what caused it, how the line fits a narrow terminal, the line itself on the terminal and desktop surfaces, with a model switch, a rebuild and a compaction, and which rebuilds raise a Ghostty notification, from what size, never outside Ghostty or on the desktop. The script test writes to a temp file instead of a terminal: the sequence, its sanitising, silence outside Ghostty, exit 0 when it cannot write.

## Credits

The lifetime rules and the timing check are adapted from [prompt-cache-control](https://github.com/davila7/claude-code-templates/tree/main/cli-tool/components/mods/observability/prompt-cache-control) in claude-code-templates by Daniel Ávila (MIT). This mod keeps only the countdown and draws it in the footer.

MIT, see [LICENSE](LICENSE). Made by Aleksandr_NFA (Telegram) · [Sanexxxx777](https://github.com/Sanexxxx777) (GitHub).
