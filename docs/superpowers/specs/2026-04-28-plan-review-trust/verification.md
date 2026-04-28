# Verification

## Static Validation

Run after implementation:

```bash
npm run typecheck
npm run lint
```

After targeted checks are stable for this central workflow UI/routing work, run the full unit suite once:

```bash
npm test
```

If final `npm test` is skipped, the final report must state the explicit reason.

## Targeted Tests

Run the colocated tests created or changed by the implementation. Expected examples:

```bash
npx vitest run src/features/workflow/plan-review-scorecard.test.ts
npx vitest run src/features/workflow/worker-packet-preview.test.ts
npx vitest run src/features/workflow/components/brief-review-view.test.ts
npx vitest run src/features/workflow/components/plan-editor.test.ts
```

Adjust filenames to match the actual implementation. Prefer one command with all relevant files once the final paths exist.

## Manual TUI Checks

Use a disposable fixture workflow with `workflow.briefReview: rich`, stubbed planner/implementer runners, no real credentials, no network, and no writes to the user's working checkout. Manual TUI checks must run in a temporary fixture or isolated test checkout and must not call real models or spend tokens.

Check:

- Simple Brief Review shows scorecard counts before entering rich edit mode.
- Rich Plan Editor shows the same counts after load.
- Counts update after deleting, splitting, merging, or externally editing a task and reloading metadata.
- A task with no tests increments `missing checks`.
- A task with no evidence increments `missing checks`.
- A task with missing, stale, pending, or unknown routing/context fit metadata increments `routing pending` and does not increment `ready`.
- A task with `contextFit: overflow` increments `split/overflow`.
- A task with `contextFit: tight` increments `risky/tight`.
- A task with stale or conflict metadata increments `stale/conflict`.
- Ready count excludes tasks in any warning bucket.
- Preview toggle opens a read-only selected-task panel.
- Moving the cursor changes the preview to the new selected task.
- Preview shows worker, cost tier, context fit, token estimate, context length, and current-code mode.
- Preview shows system preamble and task prompt sections.
- Secret-looking values are redacted in the visible preview.
- Long prompt content is visibly truncated with a marker.
- Narrow terminal does not overlap scorecard, rows, footer, or preview.
- Very short terminal hides or collapses preview instead of corrupting the task list.

## Regression Checks

- Approve still parses `tasks.md`, reruns brief quality, and proceeds only on pass.
- `e` still enters rich editor from simple review.
- `Y` still saves atomically and approves when quality passes.
- `q` still discards editor changes.
- Existing task navigation and edit keys still work.
- No runtime behavior introduces kanban, plan archive, MCP write tools, a full multi-agent manager, same-checkout parallel writes, or project-management use of durable sessions.

## Forbidden During Verification

Do not run:

```bash
git add
git stage
git commit
git stash
```
