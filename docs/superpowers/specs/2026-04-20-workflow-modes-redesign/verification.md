# Verification — Workflow Modes Redesign

## 1. Gate: every brief must pass `npm run test-ci` before merge

`test-ci` = `typecheck → lint → test`. Defined in `package.json`. Non-negotiable per project `CLAUDE.md`:

> Zero failing tests. `npm run test-ci` must pass before any PR.

Briefs are independently revertable. If brief N breaks the build, revert just that brief; previous briefs stay.

## 2. Per-brief acceptance criteria

### Brief 01 — mode taxonomy

**Positive:**
- `diptych start --mode instant "feature"` runs without error.
- `diptych start --mode quick "feature"` runs without error.
- `diptych start --mode standard "feature"` runs without error.
- `diptych start --mode speckit "feature"` runs without error (even though speckit phases land in brief 03 — the mode must at least parse).
- `WorkflowModeSchema` exports a union of `'instant' | 'quick' | 'standard' | 'speckit'`.
- `src/features/settings/mode-selector.tsx` lists four modes with correct descriptions.

**Negative:**
- `diptych start --mode full "feature"` prints a one-time deprecation notice and continues as `speckit`.
- `diptych start --mode invalid "feature"` exits with code 1 and lists valid modes.

**Backward compat:**
- Existing YAML with `workflow.mode: full` loads, migrates to `speckit` in memory, runs.
- Existing YAML with `workflow.mode: quick` or `standard` is unchanged.

**Tests:**
- `src/core/schemas/enums.test.ts` — parser accepts all four modes and rejects `full` (in the canonical form; alias parses at CLI layer).
- `src/core/config/load/migrate.test.ts` — v2 → v3 rename path.
- `src/cli/options.test.ts` — `--mode full` triggers deprecation path.
- Snapshot: `src/features/settings/mode-selector.snap.ts` shows four modes.

### Brief 02 — `instant` mode

**Positive:**
- `diptych start --mode instant "add null check to foo"` completes the full loop.
- Only `tasks.md`, `session.jsonl`, `summary.json` land in `.diptych/sessions/<id>/`. No `spec.md`, `plan.md`, `research.md`, `review.md`.
- `summary.json.mode === 'instant'`.
- No approval gates triggered (the orchestrator never calls `onApprovalNeeded`).

**Telemetry:**
- `session.jsonl` contains `mode_resolved` event with `mode: 'instant'`.
- `session.jsonl` contains `START_INSTANT` action (or equivalent).

**Tests:**
- `src/engine/orchestrator/planning/instant.test.ts` — unit test of `runInstantPlanning` with a fake planner.
- Integration test: full run with mock planner returns correct artifacts-on-disk.

### Brief 03 — speckit phases

**Positive:**
- `diptych start --mode speckit "add auth"` runs through `researching → specifying → reviewing-spec → clarifying → constitution-check → planning → reviewing-plan → analyzing → implementing`.
- Four extra artifacts land on disk for the plan phases: `spec.md`, `plan.md`, `tasks.md`, and if applicable `clarifications.md`, `constitution-check.json`, `analyze.json`.
- `analyze.json` is valid JSON and parses as `AnalyzeResult`.

**Negative:**
- If `.specify/memory/constitution.md` is missing, `constitution-check` phase completes silently as no-op.
- If constitution check fails (planner returns violations), workflow transitions to `idle` with `rejectionReason` set. `summary.json.outcome === 'constitution-failed'`.

**Edge:**
- Resumable from `clarifying`, `constitution-check`, `analyzing` phases.

**Tests:**
- `src/engine/orchestrator/planning/speckit.test.ts`.
- `src/engine/spec/prompts/constitution.test.ts`, `clarify.test.ts`, `analyze.test.ts` — prompt construction only.
- State-machine test in `src/core/state/machine.test.ts` for each new transition.

### Brief 04 — approve flag

**Positive:**
- `diptych start --approve none --mode standard "x"` does not block on spec gate.
- `diptych start --approve all --mode standard "x"` blocks on both spec and plan gates.
- `diptych start --approve spec --mode speckit "x"` blocks only on spec.
- `diptych start --auto "x"` (legacy) behaves identically to `--approve none`.
- `diptych start --mode instant --approve all "x"` blocks on nothing (instant has no plan phase to gate — `all` on `instant` degrades to `none`, logged once).

**Config:**
- YAML with `workflow.approve: 'none'` preserves behaviour across runs.
- v2 YAML with `autoApproveSpec: true, autoApprovePlan: false` migrates to `approve: 'plan'`.

**Tests:**
- `src/engine/orchestrator/planning/approve.test.ts` — table-driven test over all mode × approve combinations.
- `src/core/config/load/migrate.test.ts` — full matrix of v2 auto-approve combinations.

### Brief 05 — planner effort pass-through

**Positive:**
- `diptych start --planner-effort high "x"` with Claude Code CLI planner prepends `/effort high\n\n` to the first prompt.
- With `api` Anthropic backend, the request body contains `thinking: { type: 'enabled', budget_tokens: 24000 }`.
- With `api` OpenAI-compat backend, the request body contains `reasoning_effort: 'high'`.
- With Codex CLI, argv contains `--reasoning-effort high`.
- With a backend that does not support effort (e.g., opencode CLI), one `planner_effort_unsupported` event is emitted and the effort is dropped.

**Negative:**
- `--planner-effort invalid` exits 1 with enum-list error.

**Tests:**
- `src/engine/claude-runner.test.ts` — argv builder injects effort correctly.
- `src/engine/cli-tools.test.ts` — codex case.
- `src/engine/providers/anthropic/stream.test.ts` — thinking budget translation.
- `src/engine/providers/openai-stream.test.ts` — reasoning_effort pass-through.
- Capability test: each planner declares `supportsEffort` correctly.

### Brief 06 — image pass-through

**Positive:**
- `/attach /path/to/img.png` adds attachment; `📎 1` chip visible in input bar.
- Submit user message; `mockPlanner.invoke` receives attachment in the expected shape.
- With Anthropic API, request includes content-block `{ type: 'image', source: { type: 'base64', media_type, data } }`.
- With Claude Code CLI, subprocess argv includes `--image <tempfile>` for each attachment (or markdown fallback `[image: path]` if capability missing).

**Drag-drop:**
- Simulated input of a single-token path `/Users/.../foo.png` triggers attachment addition (tested with `fs.existsSync` mocked).

**Negative:**
- Non-image path `/Users/.../foo.exe` triggers toast "attach only supports images" and is not added.
- Path outside project+home roots is rejected with security-toast.
- Attachment > 10 MB rejected with size-toast.
- Submit on a backend without `supportsImages: true` drops attachments with `planner_attachments_dropped` event.

**Tests:**
- `src/components/input/multiline-input.test.tsx` — drag-drop detection.
- `src/core/slash-commands/handlers/attach.test.ts` — command behaviour.
- `src/engine/planners/claude-code.test.ts` — argv builder with attachments.
- `src/engine/providers/anthropic/stream.test.ts` — image content block construction.

### Brief 07 — git modes settings

**Positive:**
- `/settings` overlay shows Commit Strategy (picker) and Create Branch (toggle).
- Changing commit strategy writes to YAML and takes effect on next run.
- `workflow.git.createBranch: true` + `diptych start "add X"` runs `git checkout -b diptych/add-x` at workflow start.
- Existing branch `diptych/add-x` triggers `diptych/add-x-2` suffix.

**Negative:**
- Dirty working tree + `createBranch: true` still creates the branch (carries WIP over to new branch — standard `git checkout -b` semantics).

**Backward compat:**
- Existing `workflow.commitStrategy: per-task` YAML is read; orchestrator respects it even before migration runs.

**Tests:**
- `src/core/settings/catalog.test.ts` — new entries appear with correct kind.
- `src/engine/orchestrator/setup.test.ts` (or new) — branch creation logic.
- `src/lib/git.test.ts` — new `createBranch()` helper.

### Brief 08 — downgrade warning

**Positive:**
- `diptych start --mode standard "typo"` surfaces toast "This looks trivial…"
- `diptych start --mode standard "build a comprehensive authentication system with OAuth and SSO"` does NOT trigger the warning.
- `diptych start --mode instant "build a comprehensive auth system"` does not trigger (no downgrade from instant).

**Negative:**
- Heuristic runs without any network / LLM call (verified by mocking planner and asserting zero calls).

**Tests:**
- `src/engine/orchestrator/planning/mode-advisor.test.ts` — table-driven: {prompt, mode} → {advised | not advised}.

### Brief 09 — task contract docs

**Positive:**
- `docs/TASK-CONTRACT.md` exists and contains: field table, status lifecycle diagram, external-tooling guidance.
- JSDoc on `src/core/schemas/task.ts` cross-references the doc.
- A worked example (a reader can generate JSON matching a real `state.json` task entry from the spec alone).

**Tests:**
- Doc-level only. One markdown lint check (no broken links).
- `scripts/validate-task-contract.test.ts` (new, optional) — reads a real `state.json` from a test session fixture and validates each task against the JSON shape documented in the contract.

## 3. Cross-brief integration tests

Add to `src/engine/orchestrator/run/run.integration.test.ts` (or new file):

- **`instant` full loop with mock planner + local implementer** — asserts artifact set.
- **`speckit` full loop with mock planner** — asserts all 7 phases emit their expected events in order.
- **`standard` with `--approve none`** — asserts spec gate auto-accepts without user input.
- **Mode migration at resume** — create session with `state.json.mode = 'full'`, resume, assert it runs as `speckit`.

## 4. Manual verification checklist

(Not required for CI. Reviewer runs these during release validation.)

- [ ] `diptych init` produces a v3 config.
- [ ] Settings overlay in TUI renders without layout breakage for all new fields.
- [ ] Drag-drop an image onto the workflow screen in iTerm2; see chip appear.
- [ ] Drag-drop a non-image; see toast rejection.
- [ ] `/attach ./relative-path.png` resolves relative to project dir.
- [ ] `--planner-effort high` with Claude Code Max plan actually uses high reasoning (verified by timing + response quality, not by automated test).
- [ ] `speckit` run with a real constitution file shows the constitution-check failing for an obviously violating prompt.

## 5. Regression checks

Before merging ANY brief:

```bash
npm run typecheck
npm run lint
npm test
```

After merging the full set:

```bash
# Verify no existing test names changed (only added).
git diff main...HEAD --name-only | grep test

# Verify no test file dropped from the test suite.
npm test -- --reporter=verbose 2>&1 | grep -c "^ *✓"
# should be at least N (where N is the count on main).

# Verify no `describe.skip` or `it.skip` crept in.
rg --type ts 'describe\.skip|it\.skip|test\.skip' src/

# Verify the deprecation path doesn't crash.
echo 'workflow: {mode: full}' > /tmp/test-v2.yaml
DIPTYCH_CONFIG=/tmp/test-v2.yaml diptych start --help > /dev/null
```

## 6. Rollback

Each brief lands in its own commit (user will handle commits manually per `CLAUDE.md`). To revert brief N, `git revert <commit-of-brief-N>`. Briefs are ordered such that reverting a later brief never requires reverting an earlier one.

If a brief introduces a regression that is noticed after merge but before release, revert, fix in a new commit, re-land.

If a brief introduces a regression noticed **after release**, users can pin to the previous version (`npm install diptych@<prev>`). There is no v2 escape hatch — the engine only understands v3 shape at runtime.
