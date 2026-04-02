---

description: "Task list for restructuring TUI to bulletproof-react features architecture"
---

# Tasks: Restructure TUI to Bulletproof-React Features Architecture

**Input**: Design documents from `/specs/011-tui-bulletproof-structure/`
**Prerequisites**: plan.md, spec.md, data-model.md, contracts/import-boundaries.md, research.md, quickstart.md

**Tests**: NOT requested - existing unit tests will be run as validation, not as separate tasks

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Single project**: `src/tui/` is the root for all TUI restructuring
- **Feature domains**: `src/tui/features/{conversation,workflow,input,layout}/`
- **Shared**: `src/tui/components/`, `src/tui/hooks/`, `src/tui/types/`, `src/tui/utils/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create new directory structure for feature-based organization

- [ ] T001 Create feature domain directories: `src/tui/features/conversation/`, `src/tui/features/workflow/`, `src/tui/features/input/`, `src/tui/features/layout/`
- [ ] T002 Create shared directories: `src/tui/components/`, `src/tui/hooks/`, `src/tui/types/`, `src/tui/utils/`
- [ ] T003 [P] Create `index.ts` barrel files in each feature domain and shared folder

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Prepare for file moves - identify all imports that need updating

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T004 Analyze current import graph: scan all `src/tui/**/*.ts*` files and document all cross-file imports
- [ ] T005 Create import mapping spreadsheet: old path → new path for every component
- [ ] T006 Backup current state: ensure git working tree is clean before restructuring

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - Developer can locate TUI components by feature domain (Priority: P1) 🎯 MVP

**Goal**: Move all TUI components from flat structure into feature domain folders based on functional cohesion

**Independent Test**: Developer can navigate to `src/tui/features/` and find components grouped by functional domain within 30 seconds

### Implementation for User Story 1

- [ ] T007 [P] [US1] Move conversation domain files to `src/tui/features/conversation/`: `conversation-flow.tsx`, `event-card.tsx`, `dialog-card.tsx`, `diff-view.tsx`, `task-result.tsx`, `changes-card.tsx`
- [ ] T008 [P] [US1] Move workflow domain files to `src/tui/features/workflow/`: `pipeline-bar.tsx`, `task-preview.tsx`, `task-summary.tsx`, `review-gate.tsx`
- [ ] T009 [P] [US1] Move input domain files to `src/tui/features/input/`: `prompt.tsx`, `question-prompt.tsx`, `user-input.tsx`, `picker.tsx`, `mode-picker.tsx`, `slash-input.tsx`
- [ ] T010 [P] [US1] Move layout domain files to `src/tui/features/layout/`: `layout.tsx`, `header.tsx`, `cost-footer.tsx`, `summary.tsx`, `home-screen.tsx`, `help-overlay.tsx`
- [ ] T011 [US1] Move `use-interaction.ts` hook to `src/tui/features/conversation/hooks/` (conversation-specific hook)
- [ ] T012 [US1] Update all import paths in moved files to use relative paths within feature domains
- [ ] T013 [US1] Update imports in `src/app.tsx` and `src/cli.ts` to reference new feature paths
- [ ] T014 [US1] Verify TypeScript compilation succeeds: `npm run build`
- [ ] T015 [US1] Run all existing unit tests to ensure functionality preserved: `npm test`

**Checkpoint**: At this point, User Story 1 should be fully functional and testable independently - all components are in feature domains

---

## Phase 4: User Story 2 - Developer can identify shared vs feature-specific components (Priority: P2)

**Goal**: Extract shared components and hooks used by 2+ features into dedicated shared folders

**Independent Test**: Developer can correctly identify whether a component belongs in `features/` or `components/` folder based on documented criteria

### Implementation for User Story 2

- [ ] T016 [P] [US2] Move `flow-arrow.tsx` to `src/tui/components/` (used by conversation and layout)
- [ ] T017 [P] [US2] Move `use-workflow.ts` to `src/tui/hooks/` (used by workflow, layout, conversation)
- [ ] T018 [P] [US2] Move `use-app-navigation.ts` to `src/tui/hooks/` (used by layout, input)
- [ ] T019 [US2] Create `src/tui/components/index.ts` barrel file exporting all shared components
- [ ] T020 [US2] Create `src/tui/hooks/index.ts` barrel file exporting all shared hooks
- [ ] T021 [US2] Update all imports in feature domains to import shared components from `@/tui/components/` and shared hooks from `@/tui/hooks/`
- [ ] T022 [US2] Create feature barrel files: `src/tui/features/conversation/index.ts`, `src/tui/features/workflow/index.ts`, `src/tui/features/input/index.ts`, `src/tui/features/layout/index.ts` with selective exports
- [ ] T023 [US2] Verify TypeScript compilation succeeds: `npm run build`
- [ ] T024 [US2] Run all existing unit tests: `npm test`

**Checkpoint**: At this point, User Stories 1 AND 2 should both work independently - shared extraction complete

---

## Phase 5: User Story 3 - Automated enforcement prevents architectural violations (Priority: P3)

**Goal**: Add ESLint rules to enforce import boundaries and unidirectional architecture

**Independent Test**: Running code quality checks catches and reports cross-feature imports or violations of architectural rules

### Implementation for User Story 3

- [ ] T025 [US3] Add `no-restricted-paths` rule configuration to ESLint config file (`.eslintrc.js` or `eslint.config.js`)
- [ ] T026 [US3] Configure zone-based restrictions for each feature domain to prevent cross-feature imports
- [ ] T027 [US3] Configure unidirectional architecture rules (shared → features → app)
- [ ] T028 [US3] Run ESLint in warning mode first: `npm run lint` to identify violations
- [ ] T029 [US3] Fix all ESLint violations (update imports to comply with boundaries)
- [ ] T030 [US3] Re-run ESLint to verify zero violations
- [ ] T031 [US3] Verify TypeScript compilation still succeeds: `npm run build`
- [ ] T032 [US3] Run all existing unit tests one final time: `npm test`

**Checkpoint**: All user stories complete - import boundaries enforced automatically

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Documentation and final validation

- [ ] T033 [P] Update `docs/NEXT.md` to reflect TUI restructuring completion
- [ ] T034 [P] Update `CLAUDE.md` with new TUI structure reference
- [ ] T035 [P] Create migration guide for future developers (reference: `quickstart.md`)
- [ ] T036 [P] Run final validation: `npm run build && npm test`
- [ ] T037 [P] Create git commit with descriptive message for entire restructuring
- [ ] T038 Verify all success criteria from spec.md are met:
  - SC-001: Developer can locate component within 30 seconds
  - SC-002: Zero cross-feature imports (ESLint verified)
  - SC-003: All tests pass
  - SC-004: Zero broken imports (TypeScript verified)
  - SC-005: New developer can place component correctly

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Story 1 (Phase 3)**: Depends on Foundational phase completion
- **User Story 2 (Phase 4)**: Depends on User Story 1 completion (file moves must be done first)
- **User Story 3 (Phase 5)**: Depends on User Story 2 completion (shared extraction must be done before enforcing rules)
- **Polish (Phase 6)**: Depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - No dependencies on other stories
- **User Story 2 (P2)**: Depends on US1 completion (components must be in feature folders before extracting shared)
- **User Story 3 (P3)**: Depends on US2 completion (boundaries must exist before enforcing them)

### Within Each User Story

- File moves within a story marked [P] can run in parallel (different files)
- Import updates must happen after file moves
- Validation (build + test) must happen after all changes in that story

### Parallel Opportunities

- **Phase 1 (Setup)**: T001, T002, T003 can all run in parallel
- **Phase 2 (Foundational)**: T004, T005, T006 can all run in parallel
- **Phase 3 (US1)**: T007, T008, T009, T010 can all run in parallel (different feature domains)
- **Phase 4 (US2)**: T016, T017, T018 can all run in parallel (different shared extractions)
- **Phase 5 (US3)**: T025, T026, T027 can run in parallel (ESLint config tasks)

---

## Parallel Example: User Story 1

```bash
# Launch all feature domain file moves together:
Task: "Move conversation domain files to src/tui/features/conversation/"
Task: "Move workflow domain files to src/tui/features/workflow/"
Task: "Move input domain files to src/tui/features/input/"
Task: "Move layout domain files to src/tui/features/layout/"

# These can run in parallel because they touch different directories
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (create directories)
2. Complete Phase 2: Foundational (analyze imports, prepare mapping)
3. Complete Phase 3: User Story 1 (move all files to feature domains)
4. **STOP and VALIDATE**: Run `npm run build && npm test`
5. Verify: Developer can navigate to `src/tui/features/` and find components grouped

### Incremental Delivery

1. Complete Setup + Foundational → Directory structure ready
2. Add User Story 1 → All components in feature domains → Test independently
3. Add User Story 2 → Shared extraction complete → Test independently
4. Add User Story 3 → ESLint enforcement active → Final validation
5. Each phase adds value without breaking previous phases

### Single Developer Strategy

Since this is a single-developer refactor:

1. Complete Phases 1-2 in one session (setup + prep)
2. Complete Phase 3 (US1) in one session (file moves + import updates)
3. Complete Phase 4 (US2) in one session (shared extraction)
4. Complete Phase 5 (US3) in one session (ESLint rules)
5. Complete Phase 6 (Polish) and create single commit

### Git Strategy

- Use `git mv` for all file moves to preserve history
- Consider one commit per phase, or one commit for entire refactor
- Ensure working tree is clean before starting (Phase 2, T006)

---

## Notes

- [P] tasks = different files, no dependencies, can run in parallel
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Run validation (build + test) after each phase
- Commit after each phase or logical group
- Use `git mv` for file moves to preserve history
- Avoid: vague tasks, same file conflicts, cross-story dependencies that break independence

---

## Task Summary

| Phase | Task Count | Description |
|-------|------------|-------------|
| Phase 1: Setup | 3 | Create directory structure |
| Phase 2: Foundational | 3 | Analyze imports, prepare mapping |
| Phase 3: US1 | 9 | Move files to feature domains |
| Phase 4: US2 | 9 | Extract shared components/hooks |
| Phase 5: US3 | 8 | Add ESLint enforcement |
| Phase 6: Polish | 6 | Documentation and final validation |
| **Total** | **38** | Complete restructuring |

**MVP Scope**: Phases 1-3 (User Story 1 only) = 15 tasks
**Full Scope**: All 6 phases = 38 tasks
