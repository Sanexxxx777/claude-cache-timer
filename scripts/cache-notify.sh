#!/bin/bash
# cache-notify.sh: a macOS notification through Ghostty for the cache-timer mod.
# Usage: cache-notify.sh <title> <body>
#
# Writes OSC 777 (notify) to the terminal of the Claude Code session that ran it;
# Ghostty turns it into a desktop notification. Outside Ghostty or without a tty
# it does nothing. Always exits 0: the mod fires it and forgets it.
# CACHE_NOTIFY_TTY overrides the target (tests only; unset in real use).

[ "$TERM_PROGRAM" = "ghostty" ] || [ -n "$CACHE_NOTIFY_TTY" ] || exit 0

# The session's terminal: up the parent chain to the first process with a tty.
# Same walk as alice-face.sh: a child of the mod has no tty of its own.
find_tty() {
    local pid="$1" i=0 tty ppid
    while [ "$i" -lt 15 ]; do
        case "$pid" in ''|0|1) return 1 ;; esac
        # read -r, never set --: ps prints ?? for no tty, and unquoted it globs
        read -r tty ppid <<< "$(ps -o tty=,ppid= -p "$pid" 2>/dev/null)"
        case "$tty" in
            ttys[0-9]*) printf '/dev/%s' "$tty"; return 0 ;;
        esac
        pid="$ppid"
        i=$((i + 1))
    done
    return 1
}

# OSC 777 splits its fields at ';' and ends at ESC or BEL: no separators, no control bytes
clean() { printf '%s' "$1" | LC_ALL=C tr -d '\000-\037\177' | LC_ALL=C tr ';' ','; }

target="${CACHE_NOTIFY_TTY:-$(find_tty "$$")}"
[ -n "$target" ] || exit 0
{ printf '\033]777;notify;%s;%s\033\\' "$(clean "$1")" "$(clean "$2")" > "$target"; } 2>/dev/null
exit 0
