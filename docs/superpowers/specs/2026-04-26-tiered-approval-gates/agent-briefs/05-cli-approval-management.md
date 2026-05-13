# 05 — CLI Approval Management

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Identity

Agent: CLI Approval Management implementer
Brief: 05 of 06 (Tiered Approval Gates spec)

## Intent

Add `diptych approval list` and `diptych approval clear` CLI subcommands for headless inspection and management of sticky approvals. Add a `/approval` slash command to the TUI for the same operations at runtime. Both surfaces read from and write to `.diptych/approvals.json`.

## Scope

**In bounds:**
- The CLI entry point (find where `approval`-adjacent commands are registered; search `src/cli/` or `src/` for commander setup)
- New subcommand file for `approval` CLI group (location TBD — follow the existing CLI command file pattern)
- `src/core/slash-commands/catalog.ts` — add `/approval` slash command entry
- `src/core/slash-commands/context.ts` — add `listApprovals` and `clearApprovals` to `CommandContext` interface if absent

**Out of bounds:**
- Do not modify `src/engine/orchestrator/tiered-approval.ts` or the approvals store schema.
- Do not modify TUI screen files beyond registering the slash command.
- Do not add interactive TUI overlays for approval management; the slash command outputs to the feedback message bar only.

## Code Context

Read before implementing:

- `src/core/slash-commands/catalog.ts` — existing slash command registration pattern; how `/queue show/clear` and `/handoff` are structured (the `arg` kind with subcommands pattern)
- `src/core/slash-commands/types.ts` — `SlashCommandDef`, `CommandContext` interface
- `src/core/slash-commands/context.ts` — how `CommandContext` is assembled and what methods it exposes
- `src/core/schemas/approval-store.ts` (from brief 03) — `ApprovalsStoreSchema`, `ApprovalGrant`
- `src/core/paths.ts` — `APPROVALS_FILE`, `approvalsFile`, `diptychDir`
- `src/lib/fs.ts` — `ensureSecureDir`, `SECURE_FILE_MODE`

Find the CLI entry point: look for `commander` usage in `src/cli/` or `src/commands/` (run `find src -name '*.ts' | xargs grep -l "program.command\|addCommand" 2>/dev/null | head -5` to locate it).

## Implementation Plan

### 1. Create approval store read/write helpers

Create `src/engine/orchestrator/approvals-store.ts` with pure I/O helpers (no events, no orchestrator deps):

```ts
export function readApprovalsStore(projectDir: string): ApprovalsStore
// Returns { version: 1, grants: [] } if file is absent or unparseable.

export function writeApprovalsStore(projectDir: string, store: ApprovalsStore): void
// Uses ensureSecureDir + SECURE_FILE_MODE.

export function clearGrantsByScope(
  store: ApprovalsStore,
  scope: 'session' | 'always' | 'all',
): ApprovalsStore
// Returns a new store with the matching grants removed.
```

### 2. Add `approval` CLI subcommand group

Following the existing pattern, register a `approval` command group with two subcommands:

**`diptych approval list [--project <dir>]`**
- Reads `.diptych/approvals.json`.
- If no grants: prints `No sticky approvals on record.`
- Otherwise prints a table: one row per grant with columns `pattern`, `class`, `scope`, `sessionId?`, `grantedAt`.
- Exit 0.

**`diptych approval clear [--scope session|always|all] [--project <dir>]`**
- Defaults to `--scope all` if not specified.
- Calls `clearGrantsByScope`, writes back.
- Prints `Cleared N approval grant(s).`
- Exit 0 even if no grants matched.

### 3. Add `/approval` slash command to `src/core/slash-commands/catalog.ts`

Following the `/queue` pattern (kind `arg`, subcommands via args):

```ts
{
  kind: 'arg',
  name: '/approval',
  label: 'Approval',
  description: 'List or clear sticky approval grants',
  validScreens: ['workflow', 'summary'],
  handler: (args) => {
    const sub = args?.trim().toLowerCase();
    if (!sub || sub === 'list') {
      const grants = ctx.listApprovals();
      if (grants.length === 0) {
        ctx.setFeedbackMessage('No sticky approvals on record.');
      } else {
        const summary = grants.map(g => `${g.pattern} (${g.class}, ${g.scope})`).join(', ');
        ctx.setFeedbackMessage(`Approvals: ${summary}`);
      }
      return;
    }
    if (sub === 'clear') {
      const count = ctx.clearApprovals();
      ctx.setFeedbackMessage(`Cleared ${count} approval grant(s).`);
      return;
    }
    ctx.setFeedbackError(`Unknown approval command: ${sub}. Use: /approval list or /approval clear`);
  },
}
```

### 4. Extend `CommandContext` in `src/core/slash-commands/context.ts`

Add:

```ts
listApprovals: () => ApprovalGrant[];
clearApprovals: (scope?: 'session' | 'always' | 'all') => number; // returns count cleared
```

Implement these by calling `readApprovalsStore` / `writeApprovalsStore` / `clearGrantsByScope` with the current `projectDir`.

## Validation

### Tests

Test the store helpers (`src/engine/orchestrator/approvals-store.test.ts`):

- `readApprovalsStore` with absent file → `{ version: 1, grants: [] }`
- `readApprovalsStore` with corrupted JSON → `{ version: 1, grants: [] }` (graceful)
- `clearGrantsByScope('session')` removes only session-scoped grants
- `clearGrantsByScope('always')` removes only always-scoped grants
- `clearGrantsByScope('all')` removes all grants
- `writeApprovalsStore` creates the file with secure permissions

Test the CLI subcommands (if the project has a CLI test pattern — check `src/cli/` for existing test files):

- `approval list` with no grants → prints the empty message
- `approval list` with grants → prints a line per grant
- `approval clear` removes all grants and prints count

Test the slash command handler with a fake `ctx`:

- `/approval` (no args) → equivalent to `list`
- `/approval list` → calls `ctx.listApprovals()`
- `/approval clear` → calls `ctx.clearApprovals()` and reports count
- `/approval unknown` → calls `ctx.setFeedbackError`

## Constraints

- No imports from `ink`, `react`, or any `src/features/` / `src/components/` path in the CLI or store helper files.
- No classes.
- The slash command handler must be synchronous (like all existing catalog handlers).
- `CommandContext.listApprovals()` and `clearApprovals()` must be synchronous; they call `readFileSync` / `writeFileSync` directly.
- Do not add an `index.ts` barrel.

## Escalation

If the CLI command registration pattern is significantly different from what is described above (e.g., uses a different commander version or a plugin system), follow the existing pattern exactly. Read two existing CLI command files before writing any code.

If `CommandContext` is assembled in a location other than `src/core/slash-commands/context.ts`, add the new methods there wherever it is actually assembled.

## Evidence Requirements

- New file: `src/engine/orchestrator/approvals-store.ts`
- New file: `src/engine/orchestrator/approvals-store.test.ts`
- New CLI subcommand file (path determined after reading CLI structure)
- Modified: `src/core/slash-commands/catalog.ts`
- Modified: `src/core/slash-commands/context.ts` (or wherever `CommandContext` is defined)
- All tests pass: `npm test -- src/engine/orchestrator/approvals-store.test.ts`
- Typecheck clean: `npm run typecheck`
