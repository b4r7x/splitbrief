# Decisions

## ADR-001 — Lazygit-Rebase Keystroke Vocabulary

**Status:** accepted

### Context

The plan editor needs a keyboard interface. Existing diptych keys include `$` for cost drilldown, `s`/`b` for sidebar, and arrow/j/k scroll. Lazygit's interactive-rebase UI is the closest prior art for a task-list editor in a TUI; its keystrokes are familiar to the target audience of developer-facing tools.

### Decision

Adopt the lazygit-rebase keystroke set verbatim:

| Key | Operation |
|---|---|
| `j` / `↓` | Move cursor down |
| `k` / `↑` | Move cursor up |
| `<c-j>` / `<c-n>` | Move task down (reorder) |
| `<c-k>` / `<c-p>` | Move task up (reorder) |
| `d` | Delete task at cursor |
| `m` | Merge task at cursor with the previous task |
| `s` | Split task at cursor (open `$EDITOR`) |
| `e` | Edit task at cursor in `$EDITOR` |
| `<enter>` | Toggle expand/collapse full task body |
| `?` | Open/close help overlay |
| `Y` | Accept all and save (proceed to implementation) |
| `q` | Discard changes and return to simple view |

`Y` is capital to prevent accidental confirmation; lowercase `y` does nothing.

### Consequences

- Users familiar with lazygit have zero learning curve.
- `s`/`e` conflict with existing global shortcut handling. The plan editor input handler is only active when the editor is mounted; it is gated by `isActive` in `useInput` so it cannot interfere with the normal workflow screen shortcuts.

---

## ADR-002 — Reuse `reviewing-briefs` Phase; No New Sub-Phase

**Status:** accepted

### Context

The engine state machine in `src/core/state/machine.ts` has a `reviewing-briefs` phase entered when `BRIEFS_READY` fires. Adding a sub-phase would require new state machine actions and transitions, more test coverage, and a schema migration.

### Decision

The rich plan editor is a render-time branch within `reviewing-briefs`, gated on `config.workflow.briefReview === 'rich'` (plus a runtime escape hatch from the simple view). No new phase is introduced. The engine state machine is unchanged apart from the re-parse-on-approval fix in brief 05.

### Consequences

- Engine state machine stays untouched.
- The `reviewing-briefs` phase remains the single gating point.
- Audit logs look identical whether the user used the simple or rich view.

---

## ADR-003 — Opt-In Via Config Flag; `e` Escape From Simple View

**Status:** accepted

### Context

The simple `BriefReviewView` is battle-tested and sufficient for `quick` mode users. Defaulting to the rich editor for all users would break the existing UX contract.

### Decision

Add `workflow.briefReview: 'simple' | 'rich'` (default `'simple'`) to the config schema. The `WorkflowScreen` branches at render time:

```
phase === 'reviewing-briefs' && briefReview === 'rich'
  → <PlanEditorComponent />

phase === 'reviewing-briefs' && briefReview !== 'rich'
  → <BriefReviewView /> (existing)
```

Additionally: when the simple `BriefReviewView` is active, pressing `e` sets an in-memory flag on `planEditorStore` (`runtimeRichMode: true`) and causes `WorkflowScreen` to switch to the rich editor for the current session only. This flag is not written to the config file.

### Consequences

- Zero behavior change for existing users.
- Rich editor is available to any user by pressing `e` once, without config edits.
- `quick` and `instant` modes stay on the simple path unless the config flag is explicitly set.

---

## ADR-004 — Renumber Always Sequential; Original IDs Not Preserved

**Status:** accepted

### Context

After delete or reorder, task IDs can have gaps (`T001`, `T003`) or be out of order. Dependent tasks reference IDs by string. The parser expects `TNNN` format but does not validate strict sequence.

### Decision

After every edit operation that changes the task list length or order, renumber all tasks sequentially: `T001`, `T002`, ... `Tnnn`. Dependency references are updated in the same pass. Original IDs are not preserved as comments.

### Consequences

- The in-memory task list always has a clean sequence.
- Session resume after a save sees the renumbered IDs, not the planner's originals.
- Users cannot correlate edited IDs back to planner output after renumber. This is acceptable because the plan editor is a destructive, intentional edit action.

---

## ADR-005 — Delete With Dependents: Transitive Relink, Not Block

**Status:** accepted

### Context

Deleting task T002 when T003 depends on T002 leaves T003 with a dangling dependency. Options: (a) block the delete with a warning, or (b) relink T003's `dependsOn` to T002's own `dependsOn` (transitive close).

### Decision

On delete, the deleted task's dependents inherit the deleted task's `dependsOn` (minus the deleted task itself). This is a transitive relink. No blocking.

Example: T003 depends on T002; T002 depends on T001. After deleting T002, T003 now depends on T001.

If the deleted task had no `dependsOn`, its dependents become dependency-free.

### Consequences

- No blocking interactions that frustrate the user.
- Dependency graph remains acyclic.
- Edge case: two tasks both depended on the deleted task — both get the relinked set.

---

## ADR-006 — Merge Semantics

**Status:** accepted

### Context

`m` merges the cursor task into the previous task. The resulting merged task must produce a coherent brief.

### Decision

Merged task shape:

- `id` — the previous task's ID (kept; the cursor task's ID disappears).
- `title` — `"${prev.title} + ${current.title}"`.
- `file` — the previous task's `file` (implementer handles both files via steps).
- `action` — `'modify'` if either task is `modify`, else `'create'`.
- `description` — `${prev.description}\n\n---\n\n${current.description}`.
- `tests` — `[...prev.tests, ...current.tests]`.
- `implementationSteps` — `[...prev.implementationSteps, ...current.implementationSteps]`.
- `constraints` — `[...prev.constraints, ...current.constraints]`.
- `dependsOn` — set-union of both, minus any reference to the cursor task's ID.
- `scope`, `escalation`, `evidence`, `typeDefs`, `signature`, `currentCode`, `pattern` — merged by concatenation or the non-null/non-empty value wins.

After merge: renumber (ADR-004), then re-run transitive dependency relink as for delete (ADR-005).

### Consequences

- The merged task may exceed the single-file constraint the brief-quality gate enforces. This is intentional: the user chose to merge knowing that. The gate re-runs on save and will emit a warning.
- `m` on the first task (no previous task) is a no-op: display `cannot merge first task` in the feedback row.

---

## ADR-007 — Split Semantics: Standard `tasks.md` Format in `$EDITOR`

**Status:** accepted

### Context

`s` splits one task into two or more. The split boundary must be human-defined.

### Decision

`s` writes the current task's full `tasks.md` block for that task to a temp file at `<sessionDir>/split-<taskId>.md`, then opens `$EDITOR` (falling back to `vi` if unset). To define a split, the user inserts a standard `---` task separator followed by a complete YAML frontmatter block (`id:`, `title:`, `action:`, `file:`) for each new task — identical to the format `parseTasks` already parses. No special `---SPLIT---` marker is needed. On editor exit, `parseSplitResult` calls `parseTasks()` on the file content. If the parse yields a valid non-empty task list, those tasks replace the original task in the in-memory list at the cursor position. If parsing fails or yields zero tasks, the split is aborted with an error in the feedback row and the original task is unchanged.

### Consequences

- The split format is the same `tasks.md` format the planner uses, so users familiar with the format can produce valid output.
- No preprocessing step needed — `parseTasks` handles multi-task markdown natively.
- Invalid output (e.g., missing `id:` frontmatter) aborts cleanly with no data loss.

---

## ADR-008 — Save Semantics: Atomic Write + Round-Trip Validation

**Status:** accepted

### Context

`Y` commits the editor state to disk. A partial write or a write that cannot be re-parsed would corrupt the session.

### Decision

Save sequence:

1. Serialize in-memory `Task[]` to `tasks.md` markdown using the existing `formatTasks()` serializer.
2. Write to a temp file `tasks.md.tmp` in the session directory.
3. Call `parseTasks(written)` on the temp file content. If it yields a different `length` or a different set of task IDs, abort save, delete the temp file, surface the error in the feedback row, and keep the editor open.
4. `fs.rename(tmp, tasksPath)` (atomic on POSIX).
5. Re-run `evaluateBriefQuality(tasks)` and write `brief-quality.json`.
6. The `onApprovalNeeded` callback resolves with `{ approved: true }`.
7. `runBriefsApprovalLoop` (brief 05 engine change) re-reads `tasksFilePath` and re-parses before dispatching `APPROVE_BRIEFS`.

### Consequences

- Disk state is always consistent with what the parser can round-trip.
- The engine receives the user-edited tasks, not the planner's in-memory list.
- If `formatTasks` does not yet exist, brief 05 must create it (the inverse of `parseTasks`).

---

## ADR-009 — Discard Changes: In-Memory Revert, No Filesystem Undo

**Status:** accepted

### Context

`q` discards all edits. The original `tasks.md` on disk was written by the planner and is the ground truth for discard.

### Decision

`q` clears `planEditorStore` (resets to initial state: cursor 0, dirty false, runtimeRichMode false) and the `WorkflowScreen` re-renders the simple `BriefReviewView`. No filesystem operation is needed because `Y` is the only path that writes to disk. The user is then in the same state as before they opened the editor.

### Consequences

- Discard is instant and side-effect-free.
- The planner's `tasks.md` is untouched.

---

## ADR-010 — Modal Help Overlay: Extend `OverlayType` With `'plan-editor-help'`

**Status:** accepted

### Context

`?` opens a full-keystroke help modal. The existing `overlayStore` handles overlay lifecycle via an `OverlayType` union in `src/stores/navigation/router.ts`.

### Decision

Add `'plan-editor-help'` to the `OverlayType` union. The help overlay is rendered as an `OverlayPanel` (same component used by `CostDrilldownOverlay`) and lists all keystrokes with their descriptions. Any key press dismisses it (matching the cost-drilldown pattern).

### Consequences

- Consistent overlay lifecycle with existing overlays.
- No new overlay infrastructure needed.
- `'help'` remains separate (it covers global diptych help); `'plan-editor-help'` is plan-editor-specific.

---

## ADR-011 — Component Composition: Split Panes (TaskList + TaskDetail)

**Status:** accepted

### Context

The plan editor needs to show both the task list (for navigation) and the full task body (on expand). Two options: (a) single-pane scrollable list with inline expansion, or (b) split pane with list on left and detail on right.

### Decision

Single-pane scrollable list with inline expansion. When the user presses `<enter>` on a task, the full task body renders inline below the task row (toggle). The list scrolls to keep the cursor visible. This is the simpler approach and matches how lazygit shows rebase entries.

The component structure:

- `PlanEditorComponent` (root, mounted in `screen.tsx`) — reads from `planEditorStore`, renders the list.
- `TaskEditorRow` (internal, not exported) — renders one task row. Accepts `task`, `isCursor`, `isExpanded`.
- `TaskEditorDetail` (internal, not exported) — renders the full task body when expanded.
- `PlanEditorHelpOverlay` — exported from `plan-editor-help-overlay.tsx`, rendered by `WorkflowScreen` when `active === 'plan-editor-help'`.

### Consequences

- Simpler layout logic (no column width calculation for split panes).
- Inline expansion can be long; users scroll with j/k.
- If future work adds a split-pane view, `TaskEditorDetail` is already a separate component.

---

## ADR-012 — External Editor Integration: Suspend/Resume Ink stdin

**Status:** accepted

### Context

`e` and `s` both open `$EDITOR`. Ink owns stdin; opening an external process requires handing stdin back to the terminal temporarily.

### Decision

The async handler for `e`/`s`:

1. Calls `process.stdin.pause()` to suppress Ink's input handling.
2. Spawns `$EDITOR` (or `vi`) with `stdio: 'inherit'` via `child_process.spawnSync`.
3. On exit, calls `process.stdin.resume()`.
4. Reads the (possibly modified) temp file and applies the result.

This uses `spawnSync` to keep the sequence synchronous from the perspective of the async `useInput` handler. `spawnSync` blocks the Node event loop but the editor session is user-driven — no background work runs during editing.

### Consequences

- Clean stdin hand-off with no raw-mode conflicts.
- Blocking the event loop is acceptable during an interactive editor session.
- If `$EDITOR` is unset, fall back to `vi`. If `vi` is not found, surface an error in the feedback row and abort the edit.
