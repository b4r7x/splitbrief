# Feature Specification: React Architecture Naming Refactor

**Created:** 2026-05-09
**Status:** Ready for implementation
**Input:** User wants a Bulletproof React-inspired structure, fewer hyphen-heavy names, and clearer domain boundaries for composer, command, reference, palette, and runner modules.

## User Scenarios & Testing

### User Story 1 - Source Layout Reads By Domain (Priority: P1)

As a maintainer or AI agent, I can open the source tree and understand that message composition, runtime commands, file references, and global palette are separate domains.

**Why this priority:** This is the core reason for the refactor.

**Independent Test:** Inspect `src/components`, `src/core`, and `src/features` after implementation and verify old source folders are gone and new folders exist.

**Acceptance Scenarios:**

1. **Given** the source tree, **When** I list `src/components`, **Then** the shared composer lives under `src/components/composer`.
2. **Given** the source tree, **When** I list `src/core`, **Then** runtime command infrastructure lives under `src/core/runtime/commands`.
3. **Given** the source tree, **When** I list `src/features`, **Then** global palette UI lives under `src/features/palette`.

### User Story 2 - Runtime Behavior Is Unchanged (Priority: P1)

As a CLI user, I can still use `/` commands, `@path` references, command palette, help overlay, attachments, history navigation, and input submission exactly as before.

**Why this priority:** This is a refactor. Any behavior regression is a failure.

**Independent Test:** Existing focused composer, command, palette, home, workflow, summary, app-key, and RPC tests pass after path updates.

**Acceptance Scenarios:**

1. **Given** the home screen composer, **When** I type `/mde`, press Tab, then Enter, **Then** `/mode` is dispatched.
2. **Given** the composer has project files, **When** I type `@src/`, choose a result, and continue typing, **Then** the file reference is inserted and cursor behavior remains correct.
3. **Given** the command palette is opened with `Ctrl+K`, **When** I select a runtime command, **Then** the same command dispatcher runs.
4. **Given** RPC receives a command action, **When** it dispatches a runtime command, **Then** behavior matches the previous slash command dispatcher.

### User Story 3 - Active Docs Match New Architecture (Priority: P2)

As a maintainer, I can read active docs without being pointed to stale source paths.

**Why this priority:** The refactor is mostly about mental model; stale docs undo that work.

**Independent Test:** Search active docs for old source paths excluding archival superpowers specs.

**Acceptance Scenarios:**

1. **Given** active docs, **When** I search for `src/components/input-bar`, **Then** no active docs reference it.
2. **Given** active docs, **When** I search for `src/core/slash-commands`, **Then** no active docs reference it.
3. **Given** active docs, **When** they mention slash commands as user syntax, **Then** they clarify that implementation lives in runtime commands.

## Requirements

### Functional Requirements

- **FR-001:** The implementation MUST move `src/components/input-bar` to `src/components/composer`.
- **FR-002:** The implementation MUST rename public `InputBar` usage to `Composer` usage in production code and tests.
- **FR-003:** The implementation MUST move command completion code to `src/components/composer/completion/command`.
- **FR-004:** The implementation MUST move file reference completion code to `src/components/composer/completion/reference`.
- **FR-005:** The implementation MUST move shared completion panel sizing logic to `src/components/composer/completion/layout.ts`.
- **FR-006:** The implementation MUST move `src/core/slash-commands` to `src/core/runtime/commands`.
- **FR-007:** Runtime command exported names SHOULD use `RuntimeCommand` terminology instead of `SlashCommand` terminology in source.
- **FR-008:** The implementation MUST move command shortcut registry to `src/core/keybindings/registry.ts`.
- **FR-009:** The implementation MUST move command palette overlay and palette result aggregation to `src/features/palette`.
- **FR-010:** The implementation MUST move help overlay to `src/features/help/overlay.tsx`.
- **FR-011:** The implementation MUST move app-wide key handling from `src/hooks/use-app-keys.ts` to `src/app/keys.ts`.
- **FR-012:** The implementation MUST move pure `navigate-index.ts` logic out of `src/hooks`.
- **FR-013:** The implementation SHOULD rename `src/features/tool-picker` to `src/features/runners`.
- **FR-014:** The implementation MUST update tests to mirror moved files and changed exported names.
- **FR-015:** The implementation MUST update active docs: `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/STRUCTURE.md`, `docs/LAYERS.md`, `docs/TYPES.md`, `docs/HOOKS.md`, `docs/SUBSYSTEMS.md`, `docs/SLASH-COMMANDS-REFERENCE.md`, and `docs/NO-BARRELS.md` where relevant.
- **FR-016:** The implementation MUST NOT create `index.ts` files, barrel re-exports, compatibility shim files, or duplicate old-path modules.
- **FR-017:** The implementation MUST NOT change user-facing behavior.

### Key Entities

- **Composer:** Shared bottom text composer used by home, workflow, and summary screens.
- **Completion:** Composer-owned interaction that suggests replacements for active text tokens.
- **Command completion:** Completion provider for runtime command lines beginning with `/`.
- **Reference completion:** Completion provider for file references beginning with `@`.
- **Runtime command:** App command model usable by composer syntax, command palette, and RPC.
- **Palette:** Global command/action search overlay.
- **Runner picker:** Feature for selecting planner/implementer tools and models.

## Success Criteria

- **SC-001:** `npm run typecheck`, `npm run lint`, and `npm test` pass.
- **SC-002:** `rg --files src | rg '/index\\.(ts|tsx)$'` returns no files.
- **SC-003:** `rg "components/input-bar|core/slash-commands|features/tool-picker|hooks/use-app-keys" src` returns no production source references.
- **SC-004:** Active docs do not reference stale moved source paths, excluding archival `docs/superpowers/specs/**`.
- **SC-005:** Existing composer, runtime command, palette, app key, RPC, home, workflow, and summary tests pass under their new paths.

## Assumptions

- Historical specs under `docs/superpowers/specs/**` are archival and do not need path rewrites.
- The implementing agent works in one checkout and performs writer work sequentially.
- The user will create the final commit manually.
- The reviewer will run independent verification after the delegated implementation.

