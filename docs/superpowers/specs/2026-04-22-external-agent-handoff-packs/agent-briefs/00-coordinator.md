# 00 — Coordinator

> Use this only when coordinating the whole External Agent Handoff Packs spec.
> If assigned one brief, implement only that brief.
> Do **not** run `git add`, `git stage`, or `git commit`.

## Prerequisite

Brief `04-handoff-manifest-schema.md` depends on the `2026-04-26-brief-hash-versioning` spec.
That spec must land and export a stable `computeBriefHash(tasks: Task[]): string` helper before
brief 04 (and any code that writes `manifest.json`) may be implemented.

Briefs 01, 02, 03, and 05 may proceed in parallel with each other, but all five depend on the
`HandoffInput` / `HandoffPack` types defined in brief 01.

## Execution Order

```text
01 Handoff Renderers          ← defines shared types (HandoffInput, HandoffPack)
  └─ 02 Handoff CLI           ← creates writeHandoffPack writer service
       ├─ 03 Handoff Slash Command ← depends on writer service from brief 02
       ├─ 04 Handoff Manifest Schema  ← extends write.ts; BLOCKED on brief-hash-versioning spec
       └─ 05 Handoff Custom Renderers ← extends render.ts and handoff.ts CLI
```

Recommended sequential order for a single implementer:

1. `01-handoff-renderers.md`
2. `02-handoff-cli.md`
3. `04-handoff-manifest-schema.md` (only after `brief-hash-versioning` is available; extends `write.ts` from brief 02)
4. `03-handoff-slash-command.md`
5. `05-handoff-custom-renderers.md`

Briefs 03 and 05 can overlap if no agent edits the same files.

## Shared Files To Read

- `CLAUDE.md`
- `docs/TASK-CONTRACT.md`
- `docs/CONCEPTS.md`
- `docs/WORKFLOW.md`
- `docs/SLASH-COMMANDS.md`
- `docs/HOOKS-CONFIG.md`
- `src/core/schemas/task.ts`
- `src/core/schemas/evidence.ts`
- `src/core/paths.ts`
- `src/core/paths-io.ts`
- `src/core/sessions/io.ts`
- `src/core/sessions/lifecycle.ts`
- `src/core/slash-commands/catalog.ts`
- `src/core/slash-commands/types.ts`
- `src/core/slash-commands/context.ts`
- `src/engine/hooks/load-module.ts`
- `src/cli.ts`

## Shared Invariants

- Do not stage or commit.
- No new runtime dependencies.
- No classes.
- No barrels.
- Use ESM `.js` import suffixes.
- Engine code must not import React/Ink/UI modules (`src/engine/` is UI-free).
- Tests assert behavior, persisted artifacts, returned state, or rendered output — not private helper calls.
- Handoff packs are inert artifacts: no agent spawning, no auto-pickup, no watch mode. See ADR-011.

## Verification

After each brief:

```bash
npm run typecheck
npm run lint
npm test
```

For final handoff:

```bash
npm run test-ci
```
