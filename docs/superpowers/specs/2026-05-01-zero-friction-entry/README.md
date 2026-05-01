# Zero-Friction Entry - 2026-05-01

> **Status:** specified, not yet implemented.
> **Scope:** CLI shorthand invocation, @file context enrichment, and example-rich help output.
> **Write scope for this pack:** `src/cli/cli.ts`, `src/cli/commands/start.ts`, `src/cli/parse-at-files.ts`, `src/cli/help-examples.ts`, and colocated tests.
> **Out of scope:** TUI drag-and-drop, interactive file picker, MCP resource expansion, and shell completion scripts.

## Problem

The current happy path requires typing `diptych start "feature description"` every time. Three friction points:

1. **Unnecessary subcommand** -- `start` is the dominant entry point but still requires explicit naming. Users coming from tools like `git commit -m "..."` or `claude "prompt"` expect the primary action to be the default.
2. **No inline context** -- enriching planner context requires either editing config or using the TUI `/attach` command. There is no way to pass supporting files directly from the shell invocation.
3. **Sparse help** -- `diptych --help` shows flag descriptions but no real-world examples. Users must read docs to understand common invocation patterns.

## Scope

This pack specifies three capabilities:

1. **CLI shorthand:** `diptych "feature description"` works identically to `diptych start "feature description"`.
2. **@file syntax:** `diptych "refactor auth" @context.md @screenshot.png` reads file contents and injects them into planner context (text files inlined, images routed through existing attachment pipeline).
3. **Help examples:** `diptych --help` outputs 10+ real-world usage examples after the standard flag listing.

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `README.md` | Problem, scope, non-goals, and pack map. |
| 2 | `decisions.md` | ADR-style product and architecture decisions. |
| 3 | `execute-prompt.md` | Copy/paste prompt for handing this pack to a fresh implementation context. |
| 4 | `agent-briefs/01-cli-shorthand.md` | Default command registration worker brief. |
| 5 | `agent-briefs/02-at-file-syntax.md` | @file parsing and planner context enrichment worker brief. |
| 6 | `agent-briefs/03-help-examples.md` | Rich help output worker brief. |

## Non-Goals

- Do not build shell completion (bash/zsh/fish).
- Do not build a TUI file picker or drag-and-drop attachment flow.
- Do not expand MCP resource URIs from the CLI.
- Do not add glob expansion for @file patterns.
- Do not change the planner protocol or planner schema.
- Do not add new planner capabilities or flags.
- Do not build a config-file alternative to @file.
