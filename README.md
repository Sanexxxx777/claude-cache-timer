# cache-timer

How long until Claude Code's prompt cache goes cold, in one line above your prompt.

```
cache ━━━━━━━━━━ 47 min · 98%
```

The bar shrinks as the cache ages. The percent is the share of the last request the cache served. With plenty of time left the line is light olive. It turns khaki at 10 minutes left, amber at 5 and terracotta at 2. Once the cache expires the line goes grey and says how many tokens the next turn will write again, with `/compact first` from 100k tokens up.

This is a Claude Code mod: hooks that run inside Claude Code itself. A one-second clock redraws the line, so the countdown moves while you're idle. It only repaints when the text or colour changes, which is once a minute until the last 5 minutes.

## Why it usually says an hour

On a Claude subscription Claude Code asks for the 1-hour cache by itself. API keys, cloud providers and usage credits get 5 minutes. The mod follows Claude Code's documented order (`FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`, the `promptCacheTtl` setting, `ENABLE_PROMPT_CACHING_1H`, then the account), notices when a subscription runs out of plan usage and falls back to credits, and checks itself against request timing: a cache hit 20 minutes after the previous request proves the hour.

On a 5-minute cache the colour steps scale down to 50, 25 and 10 seconds.

## Install

Tested on Claude Code 2.1.289. Mods are early access, and their `$` API may change between releases.

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

## What it touches

Hooks: `session.start`, `session.end`, `turn.step` (main-loop requests only, subagents have their own cache) and `ui.render` on `AbovePrompt`. It reads `HOME`, `LANG` and the three cache variables above, plus `promptCacheTtl` from your settings files. It makes no network calls, writes no files and starts no processes. `claude plugin validate .` prints the same list.

## Tests

```sh
claude plugin test .
```

12 tests: colour stages for both lifetimes, time format, lifetime rules, and the line itself on the terminal and desktop surfaces.

## Credits

The lifetime rules and the timing check are adapted from [prompt-cache-control](https://github.com/davila7/claude-code-templates/tree/main/cli-tool/components/mods/observability/prompt-cache-control) in claude-code-templates by Daniel Ávila (MIT). This mod keeps only the countdown and redraws it as a single line.

MIT, see [LICENSE](LICENSE). Made by Aleksandr_NFA (Telegram) · [Sanexxxx777](https://github.com/Sanexxxx777) (GitHub).
