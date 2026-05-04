# `@` File Path Autocomplete — 09

> **Status:** specified, not yet implemented.
> **Scope:** Mid-text `@` file path autocomplete in the TUI input bar.
> **Write scope:** `src/components/input-bar/`, `src/lib/file-listing.ts`, colocated tests.
> **Out of scope:** Shell completion (bash/zsh/fish), glob expansion, drag-and-drop, `@` in CLI args (already works via `parse-at-files.ts`).

## Problem

`@file` syntax works from the shell (`diptych "refactor auth" @context.md`), but inside the TUI there is no autocomplete when typing `@`. Users must know the exact path from memory. Claude Code, OpenCode, and Kiro all provide `@` file completion — diptych should too.

## Scope

1. **`@` detection:** When user types `@` after a space or at line start, begin file completion mode.
2. **File listing:** Query available files via `git ls-files --cached --others --exclude-standard` (tracked + untracked, respects `.gitignore`). Fallback to `readdir` for non-git projects.
3. **Security exclusions:** Hardcoded ALWAYS_EXCLUDE patterns (`.env*`, `*.pem`, `*.key`, `credentials.*`, `.diptych/sessions/`) never appear in suggestions.
4. **Dropdown UI:** Scrollable suggestion list similar to existing `slash-suggestions.tsx`. Arrow keys navigate, Tab/Enter selects, Esc dismisses.
5. **Fuzzy matching:** Use existing `fzf` dependency for fuzzy filtering as user types after `@`.

## Non-Goals

- Do not build shell completion scripts (bash/zsh/fish).
- Do not build a TUI file picker or tree browser.
- Do not support glob patterns (`@src/**/*.ts`).
- Do not change `@file` CLI parsing (`src/cli/parse-at-files.ts`).
- Do not build a general `.diptychignore` system (separate feature).
- Do not change the planner protocol or attachment pipeline.

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `README.md` | Problem, scope, non-goals. |
| 2 | `decisions.md` | Design decisions. |
| 3 | `execute-prompt.md` | Copy/paste prompt for implementation context. |
| 4 | `agent-briefs/01-at-file-hook-and-ui.md` | Full implementation brief. |
