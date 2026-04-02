# Tasks: Core/CLI Architecture Restructure

**Input**: Design documents from `/specs/012-core-cli-restructure/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/core-api.md, quickstart.md

**Tests**: Tests are NOT requested in the spec - existing tests will be moved and updated during implementation.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3, US4)
- Include exact file paths in descriptions

## Path Conventions

- Single project structure: `src/`, `tests/` at repository root
- Target paths shown as `src/core/features/...` and `src/cli/features/...`

---

## Phase 1: Setup (Create Directory Structure)

**Purpose**: Create empty directory structure before moving files

- [X] T001 Create core feature directories: `mkdir -p src/core/features/{orchestration,planning,implementation,validation,escalation}`
- [X] T002 [P] Create core support directories: `mkdir -p src/core/{config,spec,utils}`
- [X] T003 [P] Create cli feature directories: `mkdir -p src/cli/features/{workflow,conversation,input,layout,onboarding}/{components,hooks}`
- [X] T004 [P] Create cli support directories: `mkdir -p src/cli/{components,hooks}`
- [X] T005 [P] Create test directories: `mkdir -p tests/{core,cli}`

---

## Phase 2: Foundational (Core Restructure - MOVES ALL CORE FILES)

**Purpose**: Move all core domain files, create barrel exports, update imports

**⚠️ CRITICAL**: This phase establishes the entire core architecture. All user stories depend on this.

### Move Orchestration Files

- [ ] T006 Move orchestrator.ts: `git mv src/orchestrator/orchestrator.ts src/core/features/orchestration/orchestrator.ts`
- [ ] T007 Move state.ts: `git mv src/state.ts src/core/features/orchestration/state-machine.ts`
- [ ] T008 Move cost.ts: `git mv src/orchestrator/cost.ts src/core/features/orchestration/cost.ts`
- [ ] T009 [P] Create orchestration barrel: Write `src/core/features/orchestration/index.ts` exporting orchestrator, state-machine, cost, types

### Move Planning Files

- [ ] T010 Create planning backends directory: `mkdir -p src/core/features/planning/backends`
- [ ] T011 Move planner backends: `git mv src/orchestrator/planners/*.ts src/core/features/planning/backends/`
- [ ] T012 Move planner-detection.ts: `git mv src/orchestrator/planners/planner-detection.ts src/core/features/planning/detection.ts`
- [ ] T013 Move pricing.ts: `git mv src/orchestrator/pricing.ts src/core/features/planning/pricing.ts`
- [ ] T014 Move question-parser.ts: `git mv src/orchestrator/question-parser.ts src/core/features/planning/question-parser.ts`
- [ ] T015 Move providers.ts: `git mv src/orchestrator/providers.ts src/core/features/planning/providers.ts`
- [ ] T016 Create planning types.ts (extract types from backends): Write `src/core/features/planning/types.ts` with PlannerBackend, PlannerConfig interfaces
- [ ] T017 Create planning factory.ts: Write `src/core/features/planning/factory.ts` exporting createPlanner function
- [ ] T018 [P] Create planning barrel: Write `src/core/features/planning/index.ts` exporting all planning public API

### Move Implementation Files

- [ ] T019 Move implementer.ts: `git mv src/orchestrator/implementer.ts src/core/features/implementation/implementer.ts`
- [ ] T020 Move extractor.ts: `git mv src/orchestrator/extractor.ts src/core/features/implementation/extractor.ts`
- [ ] T021 Move context-extractor.ts: `git mv src/orchestrator/context-extractor.ts src/core/features/implementation/context-extractor.ts`
- [ ] T022 Create implementation types.ts: Extract ImplementationConfig, CodeContext interfaces to `src/core/features/implementation/types.ts`
- [ ] T023 [P] Create implementation barrel: Write `src/core/features/implementation/index.ts`

### Move Validation Files

- [ ] T024 Move validator.ts: `git mv src/orchestrator/validator.ts src/core/features/validation/validator.ts`
- [ ] T025 Create validation types.ts: Extract ValidationStage, ValidationResult interfaces to `src/core/features/validation/types.ts`
- [ ] T026 [P] Create validation barrel: Write `src/core/features/validation/index.ts`

### Move Escalation Files

- [ ] T027 Move escalator.ts: `git mv src/orchestrator/escalator.ts src/core/features/escalation/escalator.ts`
- [ ] T028 Create escalation types.ts: Extract EscalationHint, EscalationTier interfaces to `src/core/features/escalation/types.ts`
- [ ] T029 [P] Create escalation barrel: Write `src/core/features/escalation/index.ts`

### Move Config Files

- [ ] T030 Move config.ts: `git mv src/config.ts src/core/config/loader.ts`
- [ ] T031 Extract defaults from loader.ts: Create `src/core/config/defaults.ts` with createDefaultConfig function
- [ ] T032 [P] Create config barrel: Write `src/core/config/index.ts`

### Move Spec Files

- [ ] T033 Move spec parser: `git mv src/spec/parser.ts src/core/spec/parser.ts`
- [ ] T034 Move spec formatter: `git mv src/spec/formatter.ts src/core/spec/formatter.ts`
- [ ] T035 Move spec templates: `git mv src/spec/templates.ts src/core/spec/templates.ts`
- [ ] T036 [P] Create spec barrel: Write `src/core/spec/index.ts`

### Move Utils Files

- [ ] T037 Move git.ts: `git mv src/utils/git.ts src/core/utils/git.ts`
- [ ] T038 Move process.ts: `git mv src/utils/process.ts src/core/utils/process.ts`
- [ ] T039 Move fs.ts: `git mv src/utils/fs.ts src/core/utils/fs.ts`
- [ ] T040 Move format.ts: `git mv src/utils/format.ts src/core/utils/format.ts`
- [ ] T041 [P] Create utils barrel: Write `src/core/utils/index.ts`

### Move Types and Create Core Entry

- [ ] T042 Move types.ts: `git mv src/types.ts src/core/types.ts`
- [ ] T043 Create core entry point: Write `src/core/index.ts` re-exporting all domains

### Update All Imports in Core Files

- [ ] T044 Update orchestration imports: Fix all `import` paths in `src/core/features/orchestration/*.ts`
- [ ] T045 [P] Update planning imports: Fix all `import` paths in `src/core/features/planning/**/*.ts`
- [ ] T046 [P] Update implementation imports: Fix all `import` paths in `src/core/features/implementation/*.ts`
- [ ] T047 [P] Update validation imports: Fix all `import` paths in `src/core/features/validation/*.ts`
- [ ] T048 [P] Update escalation imports: Fix all `import` paths in `src/core/features/escalation/*.ts`
- [ ] T049 [P] Update config imports: Fix all `import` paths in `src/core/config/*.ts`
- [ ] T050 [P] Update spec imports: Fix all `import` paths in `src/core/spec/*.ts`
- [ ] T051 [P] Update utils imports: Fix all `import` paths in `src/core/utils/*.ts`

### Create Root Entry Point

- [ ] T052 Create package entry: Write `src/index.ts` re-exporting from `./core/index.js`

**Checkpoint**: Core structure complete - all core files moved, barrel exports created, imports updated. `npm run build` should compile core files.

---

## Phase 3: User Story 1 - Core API Consumer (Priority: P1) 🎯 MVP

**Goal**: Enable programmatic access to core orchestration logic without any CLI/TUI dependencies

**Independent Test**: Import `{ runWorkflow } from './dist/index.js'` from external test file and verify zero React/Ink imports in dependency tree

### Verify Core Isolation

- [ ] T053 [US1] Verify core has no React imports: Run `grep -r "from 'react'" src/core/` should return empty
- [ ] T054 [US1] Verify core has no Ink imports: Run `grep -r "from 'ink'" src/core/` should return empty
- [ ] T055 [US1] Verify core has no CLI imports: Run `grep -r "from.*cli/" src/core/` should return empty

### Create Core Public API Tests

- [ ] T056 [US1] Create core API smoke test: Write `tests/core/api-smoke.test.ts` importing from `../../src/core/index.js` and verifying exports exist
- [ ] T057 [US1] Test core isolation: Write `tests/core/isolation.test.ts` verifying no React/Ink dependencies when importing core

### Build Verification

- [ ] T058 [US1] Run TypeScript compilation: Execute `npm run build` and verify `dist/core/` output exists
- [ ] T059 [US1] Verify core entry exports: Check `dist/index.js` re-exports all expected functions (runWorkflow, createPlanner, etc.)

**Checkpoint**: User Story 1 complete - Core module can be imported without CLI/TUI dependencies

---

## Phase 4: User Story 2 - CLI Developer (Priority: P2)

**Goal**: Clear feature-based organization where developers can navigate to relevant domains without affecting unrelated systems

**Independent Test**: Navigate to `src/core/features/orchestration/` and `src/cli/features/workflow/` - verify no CLI internals imported in core

### Move CLI Files (Rename tui → cli)

- [ ] T060 Move entire tui/features directory: `git mv src/tui/features src/cli/features`
- [ ] T061 Move tui/components: `git mv src/tui/components src/cli/components`
- [ ] T062 Move tui/hooks: `git mv src/tui/hooks src/cli/hooks`
- [ ] T063 Move app.tsx: `git mv src/app.tsx src/cli/app.tsx`
- [ ] T064 Move cli.ts to index.ts: `git mv src/cli.ts src/cli/index.ts`
- [ ] T065 Remove empty tui directory: `rmdir src/tui` (should be empty after moves)

### Update CLI Feature Imports

- [ ] T066 [P] [US2] Update workflow feature imports: Fix paths in `src/cli/features/workflow/**/*.tsx`
- [ ] T067 [P] [US2] Update conversation feature imports: Fix paths in `src/cli/features/conversation/**/*.tsx`
- [ ] T068 [P] [US2] Update input feature imports: Fix paths in `src/cli/features/input/**/*.tsx`
- [ ] T069 [P] [US2] Update layout feature imports: Fix paths in `src/cli/features/layout/**/*.tsx`
- [ ] T070 [P] [US2] Update onboarding feature imports: Create `src/cli/features/onboarding/` and move picker components if needed

### Update CLI Shared Imports

- [ ] T071 [US2] Update components imports: Fix paths in `src/cli/components/*.tsx` to use `../../core/index.js`
- [ ] T072 [US2] Update hooks imports: Fix paths in `src/cli/hooks/*.ts` to use `../../core/index.js`

### Update CLI Entry Point

- [ ] T073 [US2] Update cli/index.ts: Fix all imports to use `../core/index.js` instead of old flat paths
- [ ] T074 [US2] Update cli/app.tsx: Fix imports to use `./features/` and `./hooks/` paths

### Create CLI Barrel Exports

- [ ] T075 [P] [US2] Create workflow barrel: Write `src/cli/features/workflow/index.ts`
- [ ] T076 [P] [US2] Create conversation barrel: Write `src/cli/features/conversation/index.ts` (already exists from spec 011)
- [ ] T077 [P] [US2] Create input barrel: Write `src/cli/features/input/index.ts` (already exists from spec 011)
- [ ] T078 [P] [US2] Create layout barrel: Write `src/cli/features/layout/index.ts` (already exists from spec 011)
- [ ] T079 [P] [US2] Create onboarding barrel: Write `src/cli/features/onboarding/index.ts`
- [ ] T080 [US2] Create components barrel: Write `src/cli/components/index.ts`
- [ ] T081 [US2] Create hooks barrel: Write `src/cli/hooks/index.ts`

### Verify CLI Boundary Rules

- [ ] T082 [US2] Verify CLI imports core through public API: Run `grep -r "features/orchestration/orchestrator" src/cli/` should return empty or warnings

**Checkpoint**: User Story 2 complete - CLI files moved to `src/cli/`, all imports updated to use core public API

---

## Phase 5: User Story 3 - Test Writer (Priority: P2)

**Goal**: Core tests run without React/Ink dependencies, CLI tests run in isolation with mocked core

**Independent Test**: Run `npm test -- tests/core/` and `npm test -- tests/cli/` separately, verify no cross-dependencies

### Move Core Tests

- [ ] T083 [P] [US3] Move orchestrator test: `git mv tests/orchestrator.test.ts tests/core/orchestration.test.ts`
- [ ] T084 [P] [US3] Move planners test: `git mv tests/planners.test.ts tests/core/planning.test.ts`
- [ ] T085 [P] [US3] Move implementer test: `git mv tests/implementer.test.ts tests/core/implementation.test.ts`
- [ ] T086 [P] [US3] Move validator test: `git mv tests/validator.test.ts tests/core/validation.test.ts`
- [ ] T087 [P] [US3] Move state test: `git mv tests/state.test.ts tests/core/state-machine.test.ts`
- [ ] T088 [P] [US3] Move config test: `git mv tests/config.test.ts tests/core/config.test.ts`
- [ ] T089 [P] [US3] Move parser test: `git mv tests/parser.test.ts tests/core/spec-parser.test.ts`
- [ ] T090 [P] [US3] Move formatter test: `git mv tests/formatter.test.ts tests/core/spec-formatter.test.ts`
- [ ] T091 [P] [US3] Move extractor test: `git mv tests/extractor.test.ts tests/core/extractor.test.ts`
- [ ] T092 [P] [US3] Move context-extractor test: `git mv tests/context-extractor.test.ts tests/core/context-extractor.test.ts`
- [ ] T093 [P] [US3] Move question-parser test: `git mv tests/question-parser.test.ts tests/core/question-parser.test.ts`
- [ ] T094 [P] [US3] Move pricing test: `git mv tests/pricing.test.ts tests/core/pricing.test.ts`
- [ ] T095 [P] [US3] Move providers test: `git mv tests/providers.test.ts tests/core/providers.test.ts`
- [ ] T096 [P] [US3] Move planner-detection test: `git mv tests/planner-detection.test.ts tests/core/planner-detection.test.ts`
- [ ] T097 [P] [US3] Move claude-stream test: `git mv tests/claude-stream.test.ts tests/core/claude-stream.test.ts`
- [ ] T098 [P] [US3] Move events test: `git mv tests/events.test.ts tests/core/events.test.ts`
- [ ] T099 [P] [US3] Move diff test: `git mv tests/diff.test.ts tests/core/diff.test.ts`
- [ ] T100 [P] [US3] Move format test: `git mv tests/format.test.ts tests/core/format.test.ts`

### Move CLI Tests

- [ ] T101 [P] [US3] Move cost-footer test: `git mv tests/cost-footer.test.ts tests/cli/cost-footer.test.ts`
- [ ] T102 [P] [US3] Move pipeline-bar test: `git mv tests/pipeline-bar.test.ts tests/cli/pipeline-bar.test.ts`
- [ ] T103 [P] [US3] Move event-card test: `git mv tests/event-card.test.ts tests/cli/event-card.test.ts`
- [ ] T104 [P] [US3] Move conversation-flow test: `git mv tests/conversation-flow.test.ts tests/cli/conversation-flow.test.ts`
- [ ] T105 [P] [US3] Move summary test: `git mv tests/summary.test.ts tests/cli/summary.test.ts`

### Update Core Test Imports

- [ ] T106 [US3] Fix core test import paths: Update all `tests/core/*.test.ts` to use `../../src/core/index.js`
- [ ] T107 [P] [US3] Fix core test file-specific imports: Update direct imports like `../../src/orchestrator/*.js` to `../../src/core/features/*/index.js`

### Update CLI Test Imports

- [ ] T108 [US3] Fix CLI test import paths: Update all `tests/cli/*.test.ts` to use `../../src/cli/features/*/index.js`
- [ ] T109 [US3] Fix broken test imports from spec 011: Update `../src/tui/*.js` paths to `../src/cli/features/*/*.js`

### Verify Test Isolation

- [ ] T110 [US3] Run core tests only: Execute `npm test -- tests/core/` and verify all pass
- [ ] T111 [US3] Run CLI tests only: Execute `npm test -- tests/cli/` and verify all pass
- [ ] T112 [US3] Verify core tests don't load React: Check `grep -r "from 'react'" tests/core/` returns empty

**Checkpoint**: User Story 3 complete - Tests reorganized into `tests/core/` and `tests/cli/`, all tests pass

---

## Phase 6: User Story 4 - Build System Operator (Priority: P3)

**Goal**: TypeScript compilation succeeds, CLI binary works, core module importable

**Independent Test**: Run `npm run build` and `node dist/cli/index.js --help`, verify compilation and CLI functionality

### Update package.json Entry Points

- [ ] T113 [US4] Update main entry: Change `package.json` main field to `"./dist/index.js"`
- [ ] T114 [US4] Update bin entry: Verify `package.json` bin field points to `"./dist/cli/index.js"`
- [ ] T115 [US4] Add exports field: Add `exports` field to `package.json` with core entry point

### Update tsconfig.json

- [ ] T116 [US4] Update rootDir: Verify `tsconfig.json` `"rootDir": "src"` still works with new structure
- [ ] T117 [US4] Add path aliases (optional): Add `"@core/*": ["./src/core/*"]` and `"@cli/*": ["./src/cli/*"]` for convenience

### Add ESLint Boundary Enforcement

- [ ] T118 [US4] Create ESLint config: Add `no-restricted-imports` rule to forbid React/Ink in core and CLI imports from core internals
- [ ] T119 [US4] Document boundary rules: Add import boundary documentation to `specs/012-core-cli-restructure/quickstart.md`

### Final Build Verification

- [ ] T120 [US4] Run full build: Execute `npm run build` and verify no TypeScript errors
- [ ] T121 [US4] Verify dist structure: Check `dist/core/` and `dist/cli/` directories exist
- [ ] T122 [US4] Test CLI binary: Execute `node dist/cli/index.js --help` and verify help text
- [ ] T123 [US4] Test core import: Create temporary test file importing `./dist/index.js` and verify core exports work

### Performance Verification

- [ ] T124 [US4] Measure build time: Run `time npm run build` and verify < 30 seconds
- [ ] T125 [US4] Verify no build size regression: Check `du -sh dist/` is reasonable (< 5MB expected for source maps)

**Checkpoint**: User Story 4 complete - Build passes, CLI works, core is importable, ESLint enforces boundaries

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Cleanup, documentation, final verification

- [ ] T126 [P] Remove old empty directories: `rmdir src/orchestrator src/tui` if not already removed
- [ ] T127 [P] Update AGENTS.md: Ensure technology stack reflects TypeScript 5.9+, ESM only
- [ ] T128 [P] Update .gitignore: Add any new build artifacts if needed
- [ ] T129 Run full test suite: Execute `npm test` and verify 100% pass rate
- [ ] T130 Verify git history preservation: Run `git log --follow src/core/features/orchestration/orchestrator.ts` to confirm history intact
- [ ] T131 Create final verification test: Write integration test that imports core and CLI together
- [ ] T132 [P] Run quickstart validation: Follow `specs/012-core-cli-restructure/quickstart.md` steps manually

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - creates directory structure
- **Foundational (Phase 2)**: Depends on Setup - MOVES ALL CORE FILES
- **User Story 1 (Phase 3)**: Depends on Foundational - VERIFIES CORE ISOLATION
- **User Story 2 (Phase 4)**: Depends on US1 - MOVES CLI FILES
- **User Story 3 (Phase 5)**: Depends on US2 - MOVES TESTS
- **User Story 4 (Phase 6)**: Depends on US3 - VERIFIES BUILD
- **Polish (Phase 7)**: Depends on US4 - CLEANUP AND VERIFICATION

### User Story Dependencies

- **US1 (Core API Consumer)**: Depends on Phase 2 (Foundational) - Core files MUST be moved first
- **US2 (CLI Developer)**: Depends on US1 - CLI updates depend on core public API being ready
- **US3 (Test Writer)**: Depends on US2 - Test paths depend on final CLI structure
- **US4 (Build System Operator)**: Depends on US3 - Build verification needs all files in final locations

### Within Each Phase

- File moves can run in parallel (all marked [P])
- Import updates must wait for moves to complete
- Barrel exports must wait for all files in domain to be moved
- Tests run after all code is in place

### Parallel Opportunities

- Phase 1: T002-T005 can run in parallel (directory creation)
- Phase 2: T045-T051 can run in parallel (import updates by domain)
- Phase 5: T083-T105 can run in parallel (all test moves)
- Phase 7: T126-T128, T131 can run in parallel (cleanup tasks)

---

## Parallel Example: Phase 2 (Core File Moves)

```bash
# Launch all orchestration moves together:
Task: Move orchestrator.ts
Task: Move state.ts  
Task: Move cost.ts

# Launch all planning moves together:
Task: Move planner backends
Task: Move planner-detection.ts
Task: Move pricing.ts
Task: Move question-parser.ts
Task: Move providers.ts

# Launch all parallel import updates:
Task: Update planning imports
Task: Update implementation imports
Task: Update validation imports
Task: Update escalation imports
Task: Update config imports
Task: Update spec imports
Task: Update utils imports
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (directory creation) - ~5 minutes
2. Complete Phase 2: Foundational (core file moves) - ~30 minutes
3. Complete Phase 3: User Story 1 (core isolation verification) - ~15 minutes
4. **STOP and VALIDATE**: Verify core has no React/Ink imports, can be imported standalone
5. Ship/deliver MVP - core module is reusable!

### Incremental Delivery

1. Setup + Foundational → Core structure ready
2. Add User Story 1 → Test core isolation → Ship MVP (core is reusable)
3. Add User Story 2 → Test CLI navigation → Continue development
4. Add User Story 3 → Test reorganization → Continue development
5. Add User Story 4 → Verify build → Final delivery
6. Each story adds value without breaking previous stories

### Sequential Execution (Single Developer)

1. Complete all phases in order
2. Each phase builds on previous
3. Checkpoint after each user story
4. Validate independently before moving to next

---

## Notes

- [P] tasks move different files, can run in parallel
- [Story] label maps task to specific user story for traceability
- Git history preserved via `git mv` for all file moves
- Each user story is independently verifiable after completion
- Build must pass after each phase before moving to next
- Tests must pass after US3 before US4 verification
- Avoid: manual file copies (lose history), missing barrel exports, incomplete import updates