#!/bin/bash
# Blocks subagents from staging or committing in this repo.
# Input: Claude Code PreToolUse hook JSON on stdin.
# Exit 2 => block (stderr message shown to Claude). Exit 0 => allow.
set -euo pipefail

INPUT=$(cat)

if ! command -v jq >/dev/null 2>&1; then
  echo "BLOCKED: jq is required but not found. Cannot safely validate git commands." >&2
  exit 2
fi

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || {
  echo "BLOCKED: failed to parse input JSON." >&2
  exit 2
}

if [ -z "$COMMAND" ]; then
  exit 0
fi

read -r -a TOKENS <<< "$COMMAND"
N=${#TOKENS[@]}
i=0

while [ $i -lt $N ]; do
  t="${TOKENS[$i]}"

  if [ "$t" = "git" ]; then
    i=$((i + 1))

    # Skip git global options that may consume a value argument before we reach
    # the subcommand.  Each recognised option advances past itself (and its
    # value argument when it takes one).
    while [ $i -lt $N ]; do
      gt="${TOKENS[$i]}"
      case "$gt" in
        -C)
          i=$((i + 2)) ;;                         # -C <path>
        --git-dir|--work-tree|--namespace|--git-common-dir|--super-prefix|--config-env)
          i=$((i + 2)) ;;                         # --opt <value>
        --git-dir=*|--work-tree=*|--namespace=*)
          i=$((i + 1)) ;;                         # --opt=<value>
        -c)
          i=$((i + 2)) ;;                         # -c name=value
        -*)
          i=$((i + 1)) ;;                         # single flag
        add|stage|commit)
          echo "BLOCKED: '$COMMAND' invokes forbidden git subcommand '$gt'." >&2
          echo "Subagents in this repo may not stage or commit. The human commits manually after review." >&2
          exit 2
          ;;
        *)
          break
          ;;
      esac
    done
  else
    i=$((i + 1))
  fi
done

exit 0
