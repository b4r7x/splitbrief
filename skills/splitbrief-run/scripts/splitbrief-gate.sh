#!/bin/sh
set -eu

PROJECT_DIR="${SPLITBRIEF_PROJECT_DIR:-$PWD}"
POINTER="$PROJECT_DIR/.splitbrief/current-run"
[ -f "$POINTER" ] || exit 0

RUN_DIR=$(cd "$PROJECT_DIR" && cd "$(cat "$POINTER")" 2>/dev/null && pwd) || exit 0

PROGRESS="$RUN_DIR/progress.md"
[ -f "$PROGRESS" ] || exit 0

ROW=$(awk -F'|' '
  {
    id = $2
    state = $4
    gsub(/^[ \t]+|[ \t]+$/, "", id)
    gsub(/^[ \t]+|[ \t]+$/, "", state)
    if (id !~ /^T[0-9]+$/ || state == "done") next
    if (first == "") first = id " " state
    if (state == "running" || state == "pending") active = 1
  }
  END { if (active) print first }
' "$PROGRESS")
[ -n "$ROW" ] || exit 0

REASON="splitbrief run $(basename "$RUN_DIR") not finished: $ROW — re-read progress.md and continue"

case "${SPLITBRIEF_HOST:-}" in
  cursor) printf '{"followup_message":"%s"}\n' "$REASON" ;;
  antigravity) printf '{"decision":"continue","reason":"%s"}\n' "$REASON" ;;
  *) printf '{"decision":"block","reason":"%s"}\n' "$REASON" ;;
esac
