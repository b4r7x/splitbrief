#!/bin/bash
# Blocks subagents from staging or committing in this repo.
# Input: Claude Code PreToolUse hook JSON on stdin.
# Exit 2 => block (stderr message shown to Claude). Exit 0 => allow.

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# No command field (not a Bash invocation we care about) → allow.
if [ -z "$COMMAND" ]; then
  exit 0
fi

# Patterns use extended regex. Anchored on command boundaries ((^|\s;&|`))
# so chained (foo && git commit), piped, semicolon, and subshell variants all match,
# while substrings inside other words (e.g. mygit_add) are not caught.
# Flag-loop (-[^\s]+\s+)* tolerates top-level git flags before the subcommand
# (e.g. "git -c key=value commit", "git -C /path add", "git --no-pager commit").
BLOCKED_PATTERNS=(
  '(^|[[:space:];&|`])git[[:space:]]+(-[^[:space:]]+[[:space:]]+)*add\b'
  '(^|[[:space:];&|`])git[[:space:]]+(-[^[:space:]]+[[:space:]]+)*stage\b'
  '(^|[[:space:];&|`])git[[:space:]]+(-[^[:space:]]+[[:space:]]+)*commit\b'
  '(^|[[:space:];&|`])git[[:space:]]+-c[[:space:]]+[^[:space:]]+[[:space:]]+(commit|add|stage)\b'
)

for pattern in "${BLOCKED_PATTERNS[@]}"; do
  if echo "$COMMAND" | grep -qE "$pattern"; then
    echo "BLOCKED: '$COMMAND' matches forbidden git pattern." >&2
    echo "Subagents in this repo may not stage or commit. The human commits manually after review." >&2
    exit 2
  fi
done

exit 0
