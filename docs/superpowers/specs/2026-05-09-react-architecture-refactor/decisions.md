# Decisions

## ADR-001: Use Superpowers Spec Pack With Speckit-Style Requirements

**Decision:** Use `docs/superpowers/specs/2026-05-09-react-architecture-refactor/` as the implementation handoff, with `spec.md`, `tasks.md`, and agent briefs.

**Rationale:** This repo already uses superpowers spec packs for implementation context. Speckit handoff is useful for external session artifacts, but this work is an in-repo architecture refactor where explicit path maps and validation commands matter more than generating a new planning session.

**Trade-off:** The spec is more concrete than a pure product spec. That is intentional: the delegated agent needs exact move maps and guardrails.

## ADR-002: Rename `input-bar` To `composer`

**Decision:** Move the shared bottom input from `src/components/input-bar` to `src/components/composer` and rename the public component from `InputBar` to `Composer`.

**Rationale:** The component composes user messages, runtime commands, file references, attachments, and history. "Input bar" describes placement, not responsibility.

**Trade-off:** This touches imports in `home`, `workflow`, `summary`, and tests. It is still the lowest-risk first move because the production boundary is small.

## ADR-003: Use `completion/command` And `completion/reference`

**Decision:** Replace `slash` and `at-file` source names with nested completion domains:

- `completion/command/*` for `/` runtime command completion.
- `completion/reference/*` for `@path` file reference completion.

**Rationale:** `/` and `@` are syntax. The domain responsibilities are command completion and file reference completion.

**Trade-off:** Tests and fixtures that mention old file paths must be updated. User-facing text can still say `@file` or `/command` where that is the syntax.

## ADR-004: Rename `slash-commands` To `runtime/commands`

**Decision:** Move command infrastructure from `src/core/slash-commands` to `src/core/runtime/commands`.

**Rationale:** The commands are invoked by composer `/` syntax, command palette, and RPC. The runtime command model should not be named after one trigger.

**Trade-off:** This is the highest-fanout move. Keep it mechanical first: move files, rename exported types/functions, update imports, then validate.

## ADR-005: Move Global Palette Out Of Workflow

**Decision:** Move command palette UI and result aggregation into `src/features/palette`.

**Rationale:** The palette is global app UI. It is mounted from `app.tsx` and lists cross-screen commands/actions. It is not owned by workflow.

**Trade-off:** `engine/palette-aggregate.ts` leaves `engine` because it is UI result ranking, not orchestration. Any future non-UI consumer should get a small core extraction later.

## ADR-006: Rename `tool-picker` To `runners`

**Decision:** Move `src/features/tool-picker` to `src/features/runners`.

**Rationale:** The feature chooses planner/implementer tools and models. "Runners" is shorter, one word, and better matches the domain than "tool picker".

**Trade-off:** This is mostly import and docs churn. Keep component names like `ToolModelPicker` if renaming all public symbols creates unnecessary churn; the folder rename is the important architecture win.

## ADR-007: Keep Historical Specs Archival

**Decision:** Update active docs and source references, but do not rewrite historical `docs/superpowers/specs/**` except this new spec pack.

**Rationale:** Historical specs document prior implementation context and contain old paths by design.

**Trade-off:** `rg "input-bar|slash-commands"` will still find archival docs. Verification should exclude `docs/superpowers/specs/**` when checking active docs.

