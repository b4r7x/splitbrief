# Tasks: OpenCode Visual Restructure

**Input**: Design documents from `/specs/013-opencode-visual-restructure/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Organization**: Tasks grouped by user story. US6 (framework) and US4 (structure) are foundational prerequisites. US5 (theme) + US2 (syntax) enable US1 (visual). US3 (incremental) is independent after foundation.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story (US1-US6)
- Exact file paths included

---

## Phase 1: Setup — Framework Upgrade (US6)

**Purpose**: Upgrade Ink 5→6.8, React 18→19, add Shiki + ansis dependencies

- [x] T001 [US6] Update package.json: ink ^5.2.0→^6.8.0, react ^18.3.0→^19.0.0, @types/react ^18→^19, add shiki ^4.0.0 and ansis ^3.0.0 in package.json
- [x] T002 [US6] Run npm install and resolve any peer dependency conflicts
- [x] T003 [US6] Update render() call in src/cli.ts to pass `{ incrementalRendering: true, maxFps: 30 }` options
- [x] T004 [US6] Verify app compiles and starts: `npx tsc --noEmit` and `npm run dev -- --help`

**Checkpoint**: Ink 6 + React 19 running. All existing functionality works unchanged.

---

## Phase 2: Foundational — Project Restructure (US4)

**Purpose**: Move files to new structure. Zero logic changes — purely mechanical file moves + import updates.

**CRITICAL**: No visual or logic changes in this phase. Only directory renames and import path updates.

### Directory Creation & File Moves

- [x] T006 [P] [US4] Create src/engine/ directory and move src/orchestrator/orchestrator.ts → src/engine/orchestrator.ts
- [x] T007 [P] [US4] Move src/orchestrator/implementer.ts → src/engine/implementer.ts, src/orchestrator/validator.ts → src/engine/validator.ts, src/orchestrator/escalator.ts → src/engine/escalator.ts
- [x] T008 [P] [US4] Move src/orchestrator/planner-detection.ts → src/engine/detection.ts, src/orchestrator/providers.ts → src/engine/providers.ts, src/orchestrator/pricing.ts → src/engine/pricing.ts
- [x] T009 [P] [US4] Move src/orchestrator/context-extractor.ts → src/engine/context-extractor.ts, src/orchestrator/extractor.ts → src/engine/extractor.ts, src/orchestrator/claude-stream.ts → src/engine/claude-stream.ts, src/orchestrator/question-parser.ts → src/engine/question-parser.ts
- [x] T010 [P] [US4] Move src/orchestrator/planners/ → src/engine/planners/ (all 8 files: factory.ts, types.ts, claude-code.ts, codex.ts, opencode.ts, aider.ts, agent-sdk.ts, shell.ts)
- [x] T011 [P] [US4] Move src/orchestrator/implementers/ → src/engine/implementers/ (shell.ts, agent.ts)
- [x] T012 [P] [US4] Move src/spec/ → src/engine/spec/ (parser.ts, formatter.ts, templates.ts)
- [x] T013 [P] [US4] Move src/orchestrator/diff.ts → src/utils/diff.ts
- [x] T014 [P] [US4] Move src/tui/ → src/ui/ (all 12 component files: layout.tsx, header.tsx, pipeline-bar.tsx, conversation-flow.tsx, cost-footer.tsx, event-card.tsx, diff-view.tsx, prompt.tsx, user-input.tsx, question-prompt.tsx, summary.tsx, task-summary.tsx, picker.tsx)

### Import Updates

- [x] T015 [US4] Update all internal imports in src/engine/ files — fix all relative paths from orchestrator/ naming to engine/ naming, ensure .js extensions
- [x] T016 [US4] Update all internal imports in src/ui/ files — fix all relative paths from tui/ naming to ui/ naming, ensure .js extensions
- [x] T017 [US4] Update imports in src/app.tsx — change all tui/ references to ui/, orchestrator/ to engine/
- [x] T018 [US4] Update imports in src/cli.ts — change orchestrator/ references to engine/, spec/ to engine/spec/
- [x] T019 [US4] Update imports in src/state.ts and src/config.ts if they reference orchestrator/ paths
- [x] T020 [US4] Update all test file imports in tests/ — change orchestrator/ → engine/, tui/ → ui/, spec/ → engine/spec/ (all 24 unit test files + 6 integration tests + helpers)
- [x] T021 [US4] Create src/hooks/ directory, extract workflow hook from src/app.tsx into src/hooks/use-workflow.ts and navigation hook into src/hooks/use-app-navigation.ts
- [x] T022 [US4] Remove empty src/orchestrator/, src/tui/, src/spec/ directories after all moves complete
- [x] T023 [US4] Verify tsc --noEmit passes with zero errors
- [x] T024 [US4] Verify npm test passes with all existing tests (updated import paths)

**Checkpoint**: New structure in place. `tree src/ -L 2` shows engine/, ui/, hooks/, utils/. All tests pass. Zero TSC errors.

---

## Phase 3: Theme System + Syntax Highlighting (US5 + US2)

**Purpose**: Create centralized theme object and Shiki-powered syntax highlighting. Prerequisites for visual redesign.

### Theme (US5)

- [x] T025 [P] [US5] Create src/theme.ts (project-level, zero React deps) — export `theme` object with opencode dark palette: backgrounds (3 levels: #0a0a0a, #141414, #1e1e1e), borders (#3c3c3c, #484848, #606060), primary (#fab283), secondary (#5c9cf5), accent (#9d7cd8), text (#eeeeee, #808080), semantic (success=#7fd88f, error=#e06c75, warning=#f5a742, info=#56b6c2, yellow=#e5c07b), syntax section, diff section (added=#4fd6be/#20303b, removed=#c53b53/#37222c, context=#828bb8/#141414)

### Syntax Highlighting (US2)

- [x] T026 [P] [US2] Create src/engine/highlight.ts — Shiki singleton using fine-grained bundle (createHighlighterCore + JS regex engine + @shikijs/langs/typescript + @shikijs/langs/javascript), custom TextMate theme from src/theme.ts syntax colors (no React dep), cache Map<string, string>, export async highlight(code, lang) returning ANSI string via ansis, wrap init in try/catch — on failure log warning and return plain unhighlighted text
- [x] T027 [US2] Integrate syntax highlighting into src/ui/diff-view.tsx — use highlight() for added/removed lines, render inside plain `<Text>` (no color prop to avoid ANSI conflicts), show line-level tinted backgrounds using diff theme colors
- [x] T028 [US2] Add syntax highlighting for code blocks in planner text in src/ui/event-card.tsx — detect fenced code blocks in planner-text events, highlight the content, render with element background

**Checkpoint**: Theme object available to all components. Syntax highlighting works for TypeScript/JavaScript code. Diff view shows colored code.

---

## Phase 4: Visual Redesign (US1) — MVP

**Purpose**: Rewrite all UI components to use opencode visual language. This is the main deliverable.

### Layout & Structure

- [x] T029 [US1] Rewrite src/ui/layout.tsx — remove borderStyle="single" from header separator, use backgroundColor on outer Box (#0a0a0a), flex column with header + content + footer, pass theme colors to children
- [x] T030 [US1] Rewrite src/ui/header.tsx — remove border-bottom, use backgroundPanel (#141414) as backgroundColor, keep pipeline bar + elapsed time + feature name, text colors from theme (text, textMuted)
- [x] T031 [US1] Rewrite src/ui/cost-footer.tsx — backgroundPanel background, keyboard hints in textMuted, cost/task/model info separated by │, add hint text: `esc quit  d diff  ↑↓ scroll`

### Event Cards

- [x] T032 [US1] Rewrite src/ui/event-card.tsx planner-status case — use left accent line ┃ in accent color (#9d7cd8), text in theme.text, summary in textMuted
- [x] T033 [US1] Rewrite src/ui/event-card.tsx planner-text case — render as markdown: detect headings (# prefix → accent + bold), detect code fences (→ highlighted via highlight()), bold in warning color, plain text in theme.text
- [x] T034 [US1] Rewrite src/ui/event-card.tsx task-start case — use ─── separator line in borderSubtle, title in bold theme.text
- [x] T035 [US1] Rewrite src/ui/event-card.tsx implementer-generate case — compact 1-line: ` . implementer.generate(model)  Xs` in textMuted, file line: `  → file (+N -M)  [d] diff` in textMuted, running state: braille spinner (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ at 80ms) in primary color
- [x] T036 [US1] Rewrite src/ui/event-card.tsx validate case — compact: ` . validate(tsc, lint, test)  ✓ Xs` with ✓ in success or ✗ in error, stage indicators inline in textMuted
- [x] T037 [US1] Rewrite src/ui/event-card.tsx retry case — ` . retry(attempt N/M)` in warning color
- [x] T038 [US1] Rewrite src/ui/event-card.tsx escalate case — left accent line ┃ in warning, ` ⚠ escalate(tier N)` in warning bold, hint in textMuted
- [x] T039 [US1] Rewrite src/ui/event-card.tsx git-commit case — ` . git.commit("message")` in textMuted
- [x] T040 [US1] Rewrite src/ui/event-card.tsx error case — left accent line ┃ in error, message in error color bold

### Supporting Components

- [x] T041 [US1] Rewrite src/ui/pipeline-bar.tsx — use theme colors: done=success (●), active=primary (◉), pending=textMuted (○), labels in corresponding color
- [x] T042 [US1] Rewrite src/ui/task-summary.tsx — collapsed line: `✓ TN title — method, Xs` with ✓ in success, title in text, method/time in textMuted
- [x] T043 [US1] Rewrite src/ui/diff-view.tsx — collapsed: `  → file (+N -M)  [d] diff` in textMuted; expanded: syntax-highlighted lines with addedBg/removedBg backgrounds, line numbers in borderSubtle
- [x] T044 [US1] Rewrite src/ui/prompt.tsx — left accent line ┃ in primary, backgroundPanel for prompt area, option text in theme.text, hint text in textMuted
- [x] T045 [US1] Rewrite src/ui/question-prompt.tsx — left accent line ┃ in accent (purple), question text in theme.text, options numbered in textMuted, selected in primary
- [x] T046 [US1] Rewrite src/ui/summary.tsx — section backgrounds using backgroundPanel, stats in theme.text, savings highlighted in success, labels in textMuted
- [x] T047 [US1] Rewrite src/ui/picker.tsx — use backgroundElement for input area, options with highlight in primary, descriptions in textMuted
- [x] T048 [US1] Rewrite src/ui/user-input.tsx — backgroundElement background, left accent ╹ in primary, cursor in theme.text

### Conversation Flow

- [x] T049 [US1] Update src/ui/conversation-flow.tsx — use `<Static>` from Ink for completed task sections (items already in completed-task section type), keep active events in dynamic render tree
- [x] T050 [US1] Update src/app.tsx — pass theme references to layout, ensure render() uses incrementalRendering: true

**Checkpoint**: Full visual redesign complete. TUI shows opencode-style layout with background stepping, left accents, compact tool calls, syntax-highlighted diffs, braille spinners.

---

## Phase 5: Incremental Rendering Verification (US3)

**Purpose**: Verify and tune incremental rendering behavior with the new visual design.

- [x] T051 [US3] Verify incremental rendering works with backgroundColor on Box elements — test that layout.tsx, header.tsx, cost-footer.tsx backgrounds don't cause full redraws
- [x] T052 [US3] Verify Static component correctly excludes completed events from re-render — add console.count or onRender callback to measure render counts
- [x] T053 [US3] Test conversation flow with 50+ events — verify no visible flicker, smooth scroll, collapsed tasks stay stable

**Checkpoint**: Incremental rendering confirmed working. No visible flicker during normal workflow.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Update tests, docs, and verify everything works end-to-end.

- [x] T054 [P] Update tests/helpers/render.tsx for Ink 6 API (if any changes needed)
- [x] T055 [P] Update component tests (event-card.test.tsx, conversation-flow.test.tsx, pipeline-bar.test.tsx, cost-footer.test.tsx, diff-view.test.tsx, task-summary.test.tsx, summary.test.tsx) for new visual output (theme colors, new text patterns)
- [x] T056 [P] Verify all engine tests pass unchanged (parser, extractor, state, providers, planners, pricing, formatter, config, orchestrator, format, question-parser, planner-detection, shell-implementer, claude-stream, implementer, validator, events, diff)
- [x] T057 Update CLAUDE.md project structure section to reflect new engine/ui/hooks/utils layout
- [x] T058 Verify SC-001: grep for hardcoded hex color values in src/ui/ — should find zero (all in src/theme.ts)
- [x] T059 Verify SC-005: grep for react/ink imports in src/engine/ — should find zero
- [x] T060 Verify FR-020: no new type definition files created outside src/types.ts
- [x] T061 [P] Add truecolor degradation handling in src/theme.ts — detect terminal color support, provide 256-color fallback values for key colors (or graceful passthrough)
- [x] T062 [P] Add Shiki init failure fallback test — verify that highlight() returns plain text when Shiki fails to load (edge case from spec)
- [x] T063 Update .specify/memory/constitution.md Technical Constraints: Ink 5.x → Ink 6.x, add React 19, Shiki 4.x
- [x] T064 Final tsc --noEmit + npm test verification

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup/US6)**: No dependencies — start immediately
- **Phase 2 (Foundational/US4)**: Depends on Phase 1 completion — BLOCKS all other work
- **Phase 3 (Theme+Highlight/US5+US2)**: Depends on Phase 2 completion
- **Phase 4 (Visual/US1)**: Depends on Phase 3 completion (needs theme + highlighter)
- **Phase 5 (Incremental/US3)**: Depends on Phase 4 completion (verify with new visuals)
- **Phase 6 (Polish)**: Depends on Phase 4 + Phase 5

### User Story Dependencies

```
US6 (Framework) ──→ US4 (Restructure) ──→ US5 (Theme) ──┐
                                          US2 (Syntax) ──┤
                                                          ├──→ US1 (Visual) ──→ US3 (Incremental)
                                                          │
                                                          └──→ (US1 needs both US5 and US2)
```

### Within Each Phase

- Tasks marked [P] within a phase can run in parallel
- Phase 2 file moves (T006-T014) can all run in parallel, then import updates (T015-T020) sequentially
- Phase 4 event card rewrites (T032-T040) can partially parallelize (different switch cases in same file — must serialize if touching same file)

### Parallel Opportunities

**Phase 2 parallel batch 1** (file moves — all different directories):
```
T006, T007, T008, T009, T010, T011, T012, T013, T014
```

**Phase 3 parallel** (different files):
```
T025 (theme.ts), T026 (highlight.ts)
```

**Phase 6 parallel** (different test files):
```
T054, T055, T056
```

---

## Implementation Strategy

### MVP First (Phase 1 → 2 → 3 → 4)

1. Phase 1: Upgrade packages (5 tasks, ~30 min)
2. Phase 2: Restructure files + imports (19 tasks, ~2 hours)
3. Phase 3: Theme + highlighting (4 tasks, ~1 hour)
4. Phase 4: Visual redesign (22 tasks, ~3 hours)
5. **STOP and VALIDATE**: Visual QA against opencode screenshots

### Incremental Delivery

After Phase 2, the app is functional with new structure (old visuals).
After Phase 3, syntax highlighting works (can verify in diff-view).
After Phase 4, full visual redesign is live.
Phase 5+6 are polish — app is usable after Phase 4.

---

## Notes

- Phase 4 tasks (T032-T040) target different cases in event-card.tsx switch statement — they touch the same file so must serialize, but each is a self-contained case
- The Shiki highlighter in T026 should NOT go in ui/ despite being visual — it has zero React deps and is business logic (text → ANSI transformation)
- All component rewrites preserve existing props/interfaces — only internal rendering changes
- The `<Static>` integration (T049) is the key performance optimization — moves completed tasks out of re-render cycle
- diff.ts moves to utils/ because it's a pure function with no engine dependencies
