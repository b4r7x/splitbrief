# Decisions

## ADR-001 — Worktree Path: `.trees/<slug>` (dot-prefixed directory)

**Status:** accepted

### Context

Worktrees need a predictable, out-of-the-way location relative to the project root. Two options were evaluated:

- `trees/<slug>` — visible in `ls`, easier to tab-complete.
- `.trees/<slug>` — hidden by default in most shells and file managers; consistent with `.git/`, `.diptych/`.

### Decision

Use `.trees/<slug>`. The dot prefix signals that this is tooling-managed state, not user-authored source. Add `TREES_DIR = '.trees'` to `src/core/paths.ts` and a `worktreePath(projectDir, slug)` helper.

### Consequences

- `.trees/` should be added to `.gitignore` (the `06-runtime-isolation-docs.md` brief documents this; the engine does not write `.gitignore` automatically).
- Users who prefer the directory to be visible must symlink or configure their shell's hidden-file display; this is acceptable.
- `git status` in the main worktree does not surface `.trees/` entries once `.gitignore` is updated.

---

## ADR-002 — Branch Naming: `diptych/<feature-slug>`

**Status:** accepted

### Context

Worktree branches need to be clearly namespaced to avoid colliding with user branches. The implementer already creates per-task commits on the active branch; worktree branches should be distinguishable at a glance.

### Decision

Default branch name is `diptych/<feature-slug>`, where `<feature-slug>` is the same slug used as the worktree directory name. When `--worktree` is given a custom name, that name becomes both the slug (directory: `.trees/<name>`) and the branch suffix (branch: `diptych/<name>`).

When `--worktree` is given with no name, the feature argument to `diptych start` is slugified (same `slugify()` utility used for session IDs) and used as the name.

### Consequences

- Branches are immediately recognizable as diptych-managed.
- Collision detection is straightforward: check if `diptych/<slug>` already exists before `git worktree add`.
- If the branch already exists, the engine must refuse with a clear error: `Branch diptych/<slug> already exists. Use --worktree <other-name> or delete the branch first.`

---

## ADR-003 — Lockfile Interaction: Each Worktree Has Its Own `.diptych/active`

**Status:** accepted

### Context

The existing `.diptych/active` lockfile prevents two diptych sessions from running against the same working tree. The question is whether worktrees share this lockfile.

### Decision

Each linked worktree is a separate filesystem subtree. Each has its own `.diptych/` directory (git worktrees do not share the working-tree's `.git` dotfile contents). Therefore each worktree has an independent `.diptych/active` lockfile. No cross-worktree locking is needed.

### Consequences

- N parallel diptych sessions across N worktrees is safe by construction: each session holds its own lockfile.
- The existing `clearStaleSession` and `beginSession` logic in `src/core/sessions/lifecycle.ts` works unchanged inside any worktree.
- The same working tree still allows only one active session (existing guarantee preserved).
- `diptych worktree list` must read each worktree's `.diptych/active` independently to report session status.

---

## ADR-004 — `--parallel N` Fan-Out: Deferred to v3

**Status:** deferred

### Context

The original product description mentions `diptych start --parallel N` — fan out the same brief to N worktrees with N different implementer subprocesses simultaneously.

### Decision

Defer to v3. The reasoning:

1. v2 delivers the worktree lifecycle primitives that v3 depends on. Ship primitives first.
2. `--parallel N` requires deciding how implementer configs are selected (positional? config array? flags?), how output is multiplexed in the TUI, and how the user picks a winner — none of which is resolved.
3. Users get the manual parallel workflow (open two terminal windows, each running `diptych start --worktree`) immediately after v2; `--parallel N` is a convenience shortcut, not a blocker.

### Consequences

- Brief `05-parallel-fan-out.md` does not exist in this spec.
- When v3 lands it will add the brief, extend `WorkflowOpts`, and wire the orchestrator.
- `README.md` notes the gap explicitly.

---

## ADR-005 — Worktree Cleanup on Session End: Keep, Do Not Auto-Remove

**Status:** accepted

### Context

When a diptych session inside a worktree completes, should the worktree be automatically removed?

### Decision

Do not auto-remove. Keep the worktree after session end. The user must run `diptych worktree remove <name>` explicitly.

Rationale: the worktree's branch contains the per-task commits made by the implementer — that diff is the deliverable. Removing it automatically would destroy the user's output. The user may also want to inspect, test, or cherry-pick from the worktree before merging.

### Consequences

- `diptych worktree list` shows worktrees with `idle` or `none` status after session end; users know they can safely remove them.
- No cleanup is triggered by the orchestrator's `session-lifecycle.ts` for worktrees.
- A future `--ttl` flag could auto-remove after N hours; that is explicitly out of scope here.

---

## ADR-006 — Cleanup Safety: Two Refusal Guards

**Status:** accepted

### Context

`diptych worktree remove` is irreversible: it deletes the worktree directory and (optionally) the branch. Two independent guard conditions were identified.

### Decision

`removeWorktree` refuses and exits non-zero in either of the following cases, unless `--force` is passed:

1. **Live session guard:** `.diptych/active` exists in the target worktree AND the session state is not `complete` / `idle` (i.e., a diptych process is actively running).
2. **Uncommitted changes guard:** `git worktree` status shows modified, staged, or untracked files in the target worktree.

`--force` bypasses both guards. Each bypassed guard must be logged explicitly so the user understands what was skipped:

```text
Warning: forcing removal of worktree ".trees/my-feature" with live session dip-abc123.
Warning: forcing removal of worktree ".trees/my-feature" with 3 uncommitted file(s).
```

### Consequences

- Users cannot accidentally destroy active work without explicit opt-in.
- Scripted or CI teardown can use `--force` to clean up aggressively.
- The live-session guard requires reading the state file, not just the presence of `.diptych/active` (a stale lock should not block removal).

---

## ADR-007 — Runtime Isolation Gap: Document Loudly, Do Not Solve

**Status:** accepted

### Context

Git worktrees provide filesystem isolation. They do NOT provide:

- Port isolation (two dev servers will collide on the same port).
- `node_modules` isolation (symlinked to the main tree by default in many setups).
- Environment variable isolation.
- Process namespace isolation.

### Decision

Document this gap loudly and prominently. Do not attempt to solve it in this spec. The `06-runtime-isolation-docs.md` brief produces `docs/WORKTREES.md` which:

- Explains what worktrees DO and DO NOT isolate.
- Lists concrete failure scenarios (port collision, shared `node_modules`, env bleed).
- Recommends user-owned mitigations: devcontainer per worktree, microVM (Firecracker), Docker Compose per worktree, `PORT` env var override.
- Points to existing ecosystem tooling (e.g., `nvm` per-directory `.nvmrc`, `direnv`).

No code changes accompany this brief.

### Consequences

- Users are not surprised by runtime conflicts.
- Diptych does not silently fail due to port collisions.
- The documentation contract is clear: runtime isolation is the user's responsibility for this release.

---

## ADR-008 — TUI Worktree Indicator: Header Label, Amber Color

**Status:** accepted

### Context

When two terminal windows each run diptych in a different worktree, the user needs to distinguish them at a glance. The header is the most stable, always-visible element.

### Decision

When `detectWorktree()` returns a worktree name, the header displays it as a short prefix label before the feature name, colored amber (closest match in the existing theme palette to "attention without alarm"). If the user is in the main working tree, no label appears and the header is unchanged.

Format: `[<worktree-name>] <feature>` — truncated together to fit `featureWidth`.

Detection mechanism: `git rev-parse --git-common-dir` output differs from `git rev-parse --git-dir` when inside a linked worktree (linked worktrees have `.git` as a file, not a directory; `--git-common-dir` points back to the main tree's `.git/`). The engine reads this at startup via `detectWorktree()` in `src/engine/git/worktree.ts` and passes the result into the TUI through an existing store or the router state.

### Consequences

- No label = main worktree; label = linked worktree. Unambiguous.
- The label does not interfere with the pipeline bar or timer.
- If detection fails (e.g., non-git project), no label is shown; the error is silenced.
