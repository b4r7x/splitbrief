# React Architecture Naming Refactor - 2026-05-09

> **Status:** Ready for delegated implementation.
> **Recommended mode:** single implementation pass in one commit, with sequential phases and full validation.
> **Scope:** Rename and relocate React/Ink UI architecture seams so folders describe domain responsibilities instead of trigger syntax or screen placement.
> **Primary goal:** Make the repo closer to a Bulletproof React-style `shared -> features -> app` architecture without adding barrels, compatibility shims, or behavior changes.

## Problem

The current UI structure is mostly healthy, but some names are too tied to implementation details:

- `src/components/input-bar` is not just a bar; it is the shared bottom message composer used by home, workflow, and summary.
- `src/core/slash-commands` describes one invocation syntax (`/`) even though the same commands are used by the TUI composer, command palette, and RPC.
- `use-at-file-autocomplete` and `at-file-suggestions` describe the `@` syntax instead of the domain concept: file references in a composed message.
- `features/workflow/components/command-palette-overlay.tsx` is a global palette, not workflow-only UI.
- `src/hooks/use-app-keys.ts` is app shell behavior, while `src/hooks/navigate-index.ts` is pure list navigation logic, not a hook.

This makes the code harder to scan and gives future agents the wrong mental model.

## Target Architecture

Use folder context instead of long hyphenated file names:

```text
src/app/
  keys.ts
  keys.test.tsx
  command-context.ts

src/components/
  composer/
    composer.tsx
    composer.integration.test.tsx
    attachments.tsx
    history.ts
    history.test.ts
    use-history.ts
    completion/
      layout.ts
      layout.test.ts
      command/
        hook.ts
        hook.test.ts
        menu.tsx
        menu.test.tsx
      reference/
        hook.ts
        hook.test.tsx
        menu.tsx
        menu.test.tsx
        token.ts
        token.test.ts

src/core/
  keybindings/
    registry.ts
  runtime/
    commands/
      types.ts
      registry.ts
      registry.test.ts
      dispatch.ts
      dispatch.test.ts
      lookup.ts
      lookup.test.ts

src/features/
  palette/
    overlay.tsx
    overlay.test.tsx
    results.ts
    results.test.ts
    sources.ts
  help/
    overlay.tsx
  runners/
    picker.tsx
    components/
    hooks/
    catalog/
```

## Naming Rules

- Prefer one-word folders: `composer`, `completion`, `command`, `reference`, `runtime`, `palette`, `runners`.
- Use nested folders to provide context instead of long file names.
- Keep user-facing `/` terminology where it explains the actual CLI syntax, but do not use `slash` as a source folder or type name for runtime command infrastructure.
- Keep user-facing `@file` terminology where it explains syntax, but source modules should use `reference`.
- Do not add `index.ts` barrels or re-export shim files.
- Do not use `git mv`, `git add`, `git stage`, `git commit`, or `git stash`.

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `README.md` | Scope, target shape, naming rules |
| 2 | `decisions.md` | Architectural decisions and trade-offs |
| 3 | `spec.md` | Speckit-style requirements and acceptance criteria |
| 4 | `tasks.md` | Checklist for one-pass implementation |
| 5 | `agent-briefs/00-coordinator.md` | Coordinator instructions |
| 6 | `agent-briefs/01-composer.md` | Composer move and completion rename |
| 7 | `agent-briefs/02-runtime-commands.md` | Runtime command core rename |
| 8 | `agent-briefs/03-palette-help.md` | Palette/help feature extraction |
| 9 | `agent-briefs/04-app-runners-docs.md` | App hooks, runners rename, docs |
| 10 | `verification.md` | Required validation and residual checks |
| 11 | `execute-prompt.md` | Copy-paste prompt for the implementing agent |

## Non-Goals

- No behavior changes to `/` command execution, command palette search, `@path` completion, file attachments, history, overlays, or keyboard shortcuts.
- No rewrite of stores or workflow internals.
- No broad `workflow/components` reshuffle such as `event-cards -> events` in this pass.
- No public compatibility alias modules.
- No import barrels.
- No staging or committing by the implementing agent.

