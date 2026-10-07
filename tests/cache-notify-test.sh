#!/bin/bash
# Offline test of scripts/cache-notify.sh: a temp file stands in for the terminal.
# Usage: bash tests/cache-notify-test.sh

cd "$(dirname "$0")/.." || exit 1
script=scripts/cache-notify.sh
out=$(mktemp)
trap 'rm -f "$out"' EXIT
fail=0

check() {
    if [ "$2" = "$3" ]; then
        echo "ok   $1"
    else
        echo "FAIL $1"
        printf '  want %q\n  got  %q\n' "$3" "$2"
        fail=1
    fi
}

# OSC 777: notify;<title>;<body>, ended by ST
: > "$out"
CACHE_NOTIFY_TTY="$out" bash "$script" "Claude Code · repo" "cache expires in 2:00"
check frame "$(cat "$out")" $'\e]777;notify;Claude Code · repo;cache expires in 2:00\e\\'

# a ';' would start a new field and ESC or BEL would end the sequence early
: > "$out"
CACHE_NOTIFY_TTY="$out" bash "$script" $'a;b\e]x' $'c\ad;e'
check sanitized "$(cat "$out")" $'\e]777;notify;a,b]x;cd,e\e\\'

# another terminal: no output, exit 0 (without the override it would look for a tty)
res=$(env -u CACHE_NOTIFY_TTY TERM_PROGRAM=Apple_Terminal bash "$script" "t" "b" 2>&1; echo "exit $?")
check "outside ghostty is silent" "$res" "exit 0"

# a target it cannot write: still exit 0, nothing on stderr
res=$(CACHE_NOTIFY_TTY=/nonexistent/dir/tty bash "$script" "t" "b" 2>&1; echo "exit $?")
check "unwritable target exits 0" "$res" "exit 0"

[ "$fail" -eq 0 ] && echo "all passed"
exit "$fail"
