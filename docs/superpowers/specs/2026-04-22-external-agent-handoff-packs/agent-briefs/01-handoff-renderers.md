# 01 — Handoff Renderers

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

Add pure renderer functions that convert a diptych session and its Task Briefs into a
target-specific Handoff Pack — a folder of markdown files plus a `manifest.json` descriptor.

Four built-in targets (ADR-006):

| Target | Covers | Extra file written |
|---|---|---|
| `spec-kit` | Universal default: Cursor, Windsurf, Gemini CLI, any Spec Kit-compatible tool. | None — the folder itself is the pack. |
| `agents-md` | Codex CLI, OpenCode, Aider, Kilo. | `AGENTS.md` at pack root referencing tasks. |
| `claude-code` | Claude Code CLI + IDE. | `CLAUDE.md` and `.claude/agents/` at pack root. |
| `copilot-issue` | GitHub Copilot via `@copilot` issue/PR mention. | Single GitHub-issue-shaped `issue.md` (suitable for `gh issue create --body-file`). |

`spec-kit` is the identity renderer: the folder-as-is is the pack. Other renderers wrap it by adding a
thin README.md plus one target-specific entry file. No renderer produces a single concatenated prompt.

Do not add CLI or slash commands in this brief.

## Read First

- `CLAUDE.md`
- `docs/TASK-CONTRACT.md`
- `src/core/schemas/task.ts`
- `src/core/schemas/enums.ts`
- `src/core/schemas/evidence.ts`

## Files To Touch

- `src/engine/handoff/types.ts` **new**
- `src/engine/handoff/renderers/spec-kit.ts` **new**
- `src/engine/handoff/renderers/agents-md.ts` **new**
- `src/engine/handoff/renderers/claude-code.ts` **new**
- `src/engine/handoff/renderers/copilot-issue.ts` **new**
- `src/engine/handoff/render.ts` **new** — dispatches to the four renderers
- `src/engine/handoff/render.test.ts` **new**

Do not create `src/engine/handoff/index.ts` (zero barrels).

## Types

Define these exports in `src/engine/handoff/types.ts`:

```ts
import type { Task, TaskId } from '../../core/schemas/task.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';

export type HandoffTarget = 'spec-kit' | 'agents-md' | 'claude-code' | 'copilot-issue';

export const HANDOFF_TARGETS: readonly HandoffTarget[] = [
  'spec-kit',
  'agents-md',
  'claude-code',
  'copilot-issue',
];

export type HandoffInput = {
  target: HandoffTarget;
  sessionId: string;
  feature: string;
  mode: WorkflowMode;
  tasks: Task[];
  selectedTaskIds?: TaskId[];   // undefined = all tasks
  spec?: string;                // spec.md content, if produced by the session mode
  plan?: string;                // plan.md content, if produced
  constitution?: string;        // constitution.md content from project root, if present
  validation?: {
    typecheck?: string;         // e.g. "npm run typecheck"
    lint?: string;
    test?: string;
  };
};

export type HandoffFile = {
  path: string;    // relative to the pack root
  content: string;
};

export type HandoffPack = {
  files: HandoffFile[];
};
```

## Pack Folder Shape

Every rendered pack produces these files at minimum (ADR-004):

```text
<pack-root>/
├── manifest.json             (written by the CLI/slash writer, NOT by renderers)
├── spec.md                   (if input.spec is provided)
├── plan.md                   (if input.plan is provided)
├── constitution.md           (if input.constitution is provided)
├── tasks/
│   ├── T001.md
│   └── T002.md               (one per task; filtered by selectedTaskIds if set)
└── README.md                 (target entry instructions)
```

Renderers produce only the `HandoffFile[]` list. They do not write to disk and do not produce
`manifest.json` (that is brief 04's responsibility, added by the writer in brief 02).

## Per-Target Output Rules

### `spec-kit` renderer (`renderers/spec-kit.ts`)

Identity renderer. Produces the base set of files only:

- `README.md` — one-paragraph usage: "Run `claude`, `codex exec`, or `cursor` in this folder."
- `tasks/T0NN.md` per task — full Task Brief content (see Task Brief file format below).
- `spec.md`, `plan.md`, `constitution.md` if their input fields are present.

### `agents-md` renderer (`renderers/agents-md.ts`)

Extends the spec-kit output with:

- `AGENTS.md` at pack root — project instructions block + task list with relative paths, e.g.:
  ```
  # Tasks
  - [T001](tasks/T001.md) — <title>
  - [T002](tasks/T002.md) — <title>
  ```

### `claude-code` renderer (`renderers/claude-code.ts`)

Extends the spec-kit output with:

- `CLAUDE.md` at pack root — project instruction section ("Read CLAUDE.md in the source repo first") + task list with relative links.
- `.claude/agents/diptych-handoff.md` — agent definition instructing Claude Code to read tasks in order, not commit, run typecheck/lint/test.

### `copilot-issue` renderer (`renderers/copilot-issue.ts`)

Does NOT extend spec-kit. Produces a single file:

- `issue.md` — GitHub-issue-shaped markdown body:
  - `## Summary` — feature description.
  - `## Tasks` — bulleted task list (id, title, file, action).
  - `## Acceptance Criteria` — flattened `task.tests` across all tasks.
  - `## Constraints` — flattened `task.constraints`.
  - `## Validation` — verification commands from `input.validation`.
  - `## Do not` — "Do not stage or commit. Await review."

## Task Brief File Format

Each `tasks/T0NN.md` must contain all nine Task Brief sections (§1–§9 of TASK-CONTRACT.md):

```md
---
briefHash: <placeholder — filled by manifest writer>
taskId: T001
---

# T001 — <title>

**File:** `<file>` (`<action>`)
**Depends on:** T002, T003  (or "none")

## Intent

<description>

## Scope

**In bounds:** ...
**Out of bounds:** ...

## Code Context

**Signature:** ...
**Pattern:** ...
**Type Defs:** ...
**Current Code:** (for modify tasks)

## Implementation Steps

1. ...

## Validation

- <test item>

## Constraints

- <constraint>

## Escalation

- <escalation condition>  (or "none declared")

## Evidence

- <evidence item>  (or "none declared")
```

Leave `briefHash` as the literal string `<placeholder>` — the manifest writer (brief 04) will
backfill it when it writes `manifest.json`.

## Dispatch

Implement `renderHandoff(input: HandoffInput): HandoffPack` in `src/engine/handoff/render.ts`.

The dispatcher must:
1. Filter `input.tasks` by `input.selectedTaskIds` if provided. If a requested ID is not found, throw `Error('unknown task id: T0NN')`.
2. Call the matching renderer for `input.target`. Unsupported target throws `Error('unsupported target: <target>')`.
3. Return the combined `HandoffPack`.

## Constraints

- Renderers are pure and deterministic. No filesystem writes, no async, no network calls.
- No agent spawning, no auto-pickup, no watch mode (ADR-011).
- All four targets preserve the same Task Brief semantics — the contract does not change per target.
- Engine code must not import React/Ink/UI modules.
- No classes. No barrel `index.ts`.

## Tests (`src/engine/handoff/render.test.ts`)

Test against a fixture set of 2–3 Task objects with all optional fields populated.

Required assertions:
- `spec-kit` output includes `tasks/T001.md` with all nine brief sections present.
- `agents-md` output includes `AGENTS.md` with task links.
- `claude-code` output includes `CLAUDE.md` and `.claude/agents/diptych-handoff.md`.
- `copilot-issue` output contains exactly `issue.md` with all required sections.
- `selectedTaskIds` filters to only the requested task; other tasks do not appear in `tasks/`.
- Unknown `selectedTaskId` throws with the task id in the message.
- Unsupported target throws.
- `spec` and `plan` are included in the pack only when provided.

Use explicit string assertions. No broad snapshot assertions.

## Acceptance Criteria

- `renderHandoff` is pure, synchronous, and deterministic.
- No filesystem writes in this module.
- `npm run test-ci` passes.

## Verification Commands

```bash
npm test -- src/engine/handoff/render.test.ts
npm run typecheck
npm run lint
npm test
```
