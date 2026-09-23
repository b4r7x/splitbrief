#!/bin/sh
# --deadline is a loop counter: coreutils `timeout` is absent on stock macOS.

usage() {
  printf 'usage: wait-attempt.sh <run dir> <T00N> <attempt> [--deadline SECONDS]\n' >&2
  printf '       wait-attempt.sh --reconcile <run dir>\n' >&2
  exit 2
}

latest_attempt() {
  latest=0
  for pidfile in "$1"/attempt-*.pid; do
    [ -f "$pidfile" ] || continue
    n=${pidfile##*/attempt-}
    n=${n%.pid}
    if [ "$n" -gt "$latest" ]; then latest=$n; fi
  done
  printf '%s\n' "$latest"
}

kill_group() {
  pgid=$(ps -o pgid= -p "$1" 2>/dev/null | tr -d ' ')
  self=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')
  # Killing -$pgid when the attempt shares this shell's group would kill the caller.
  if [ -n "$pgid" ] && [ "$pgid" != "$self" ]; then target="-$pgid"; else target=$1; fi
  kill -TERM -- "$target" 2>/dev/null
  sleep 2
  kill -KILL -- "$target" 2>/dev/null
}

reconcile() {
  run=$1
  progress="$run/progress.md"
  if [ ! -f "$progress" ]; then
    printf 'wait-attempt.sh: no %s\n' "$progress" >&2
    exit 2
  fi
  grep -E '^\|[[:space:]]*T[0-9]+[[:space:]]*\|.*\|[[:space:]]*running[[:space:]]*\|' "$progress" |
    sed -E 's/^\|[[:space:]]*(T[0-9]+).*/\1/' |
    while IFS= read -r task; do
      n=$(latest_attempt "$run/$task")
      done_file="$run/$task/attempt-$n.done"
      pid_file="$run/$task/attempt-$n.pid"
      if [ "$n" -gt 0 ] && [ -f "$done_file" ]; then
        printf '%s: done %s\n' "$task" "$(cat "$done_file")"
      elif [ "$n" -gt 0 ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
        printf '%s: alive pid=%s\n' "$task" "$(cat "$pid_file")"
      else
        printf '%s: dead no-done\n' "$task"
      fi
    done
}

[ $# -ge 1 ] || usage

if [ "$1" = '--reconcile' ]; then
  [ $# -eq 2 ] || usage
  reconcile "$2"
  exit 0
fi

[ $# -ge 3 ] || usage
run=$1
task=$2
attempt=$3
shift 3
deadline=1200
while [ $# -gt 0 ]; do
  case $1 in
    --deadline)
      [ $# -ge 2 ] || usage
      deadline=$2
      shift 2
      ;;
    *) usage ;;
  esac
done

pid_file="$run/$task/attempt-$attempt.pid"
log_file="$run/$task/attempt-$attempt.log"
done_file="$run/$task/attempt-$attempt.done"

if [ ! -f "$pid_file" ]; then
  printf '%s attempt %s: missing-pid\n' "$task" "$attempt"
  exit 2
fi

pid=$(cat "$pid_file")
elapsed=0
state=no-done
while :; do
  if [ -f "$done_file" ]; then
    state=$(cat "$done_file")
    break
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    if [ -f "$done_file" ]; then state=$(cat "$done_file"); fi
    break
  fi
  if [ "$elapsed" -ge "$deadline" ]; then
    kill_group "$pid"
    printf 'exit=timeout\n' >"$done_file"
    state=timeout
    break
  fi
  step=5
  remaining=$((deadline - elapsed))
  if [ "$remaining" -lt "$step" ]; then step=$remaining; fi
  sleep "$step"
  elapsed=$((elapsed + step))
done

tail_text=$(tail -n 60 "$log_file" 2>/dev/null | tr 'A-Z' 'a-z')
halt=''
# generated: halt-signatures-sh
case "$tail_text" in
  *'access token could not be refreshed'* | *'log out and sign in again'* | *'401 unauthorized'* | *'please run /login'* | *'invalid api key'* | *'oauth token has expired'* | *'oauth token revoked'* | *'authentication_error'* | *'not logged in'* | *'not authenticated'* | *'http 401'* | *'status 401'* | *'"status":401'* | *'login required'* | *'authentication failed'*) halt=auth ;;
  *'rate limit exceeded'* | *'rate limit reached'* | *'usage limit'* | *'quota exceeded'* | *'too many requests'* | *'insufficient_quota'* | *'exceeded your current quota'* | *'credit balance is too low'* | *'http 429'* | *'status 429'* | *'"status":429'* | *'insufficient credits'* | *'quota reached'* | *'resource_exhausted'* | *'exhausted your'*) halt=usage ;;
  *'unknown model'* | *'model not found'* | *'invalid model'*) halt=missing-model ;;
  *'requires permissions'* | *'use --yolo'* | *'blocked by permissions'* | *'not allowed in this mode'* | *'unknown option'* | *'unknown flag'* | *'unrecognized argument'* | *'sandbox required but unavailable'*) halt=spawn ;;
esac
# /generated

line="$task attempt $attempt: $state"
if [ -n "$halt" ]; then line="$line halt=$halt"; fi
printf '%s\n' "$line"
printf '%s\n' "$line" >>"$run/events.log"
exit 0
