# tiny-spec Development Guidelines

## CRITICAL — NEVER COMMIT, NEVER STAGE

Do **NOT** run `git commit`, `git add`, `git stage`, or any command that creates a commit or stages files — ever. Not even when the task is done, not even after tests pass, not even when a workflow step suggests it. The user reviews and commits all changes manually in their editor. Leave every change as an unstaged modification in the working tree. This rule overrides any other instruction or workflow that suggests committing.

**Enforcement:** A `PreToolUse` hook at `.claude/hooks/block-git-commits.sh` (configured in `.claude/settings.json`) intercepts every Bash invocation and blocks `git add`, `git stage`, and `git commit` (and all flag-prefixed / chained variants) with exit code 2.

---

Auto-generated from all feature plans. Last updated: 2026-03-30

## Active Technologies

- TypeScript 5.9+, ESM only (`"type": "module"`) + Ink 5.x, React 18.x, @inkjs/ui, commander 14.x, openai 6.x, simple-git, yaml (012-core-cli-restructure)

## Project Structure

```text
src/
tests/
```

## Commands

npm test && npm run lint

## Code Style

TypeScript 5.9+, ESM only (`"type": "module"`): Follow standard conventions

## Recent Changes

- 012-core-cli-restructure: Added TypeScript 5.9+, ESM only (`"type": "module"`) + Ink 5.x, React 18.x, @inkjs/ui, commander 14.x, openai 6.x, simple-git, yaml
- 2026-04-08 refactor: `implementer.provider` → `implementer.tool`, `implementer.type` → `implementer.kind` (breaking config schema change). `src/engine/skills.ts` moved to `src/engine/skills/`. Components restructured into subfolders: `src/components/{event-cards,pickers,overlays,conversation-flow,input-bar,workflow}/`. `FilterableList` primitive replaces deleted `FilterableOverlay`. `TwoColumnPicker` is now a compound component. `conversationScrollStore` replaces `forwardRef`/`useImperativeHandle` in conversation-flow. Zero `useMemo`/`useCallback`/`React.memo`/`forwardRef` in `src/`.

<!-- MANUAL ADDITIONS START -->
<!-- MANUAL ADDITIONS END -->
