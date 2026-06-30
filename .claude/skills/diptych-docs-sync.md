---
name: diptych-docs-sync
description: Audit whether docs/ matches the current state of the code. Use when the user asks to sync docs, verify doc accuracy, check for stale references, or after a change that may have diverged docs from code. Does not rewrite specs under notes/superpowers/specs/ or notes/specs/ — those are immutable.
---

# Sync diptych docs with current code

Docs describe **current code, not plans**. After any code change that touches a public surface (state machine, storage layout, capability matrix, interaction model), this skill audits and fixes docs to match.

## When to run

- After implementing a spec under `notes/superpowers/specs/` (the spec's own Doc Sync brief handles the primary updates — this skill is a second-pass verification).
- When the user says "docs look out of date".
- Before a release.
- Before handing off to a fresh AI context (so that primer docs are accurate).

## Scope

In scope:

- `docs/CONCEPTS.md`
- `docs/ARCHITECTURE.md`
- `docs/WORKFLOW.md`
- `docs/FUTURE.md`
- `docs/STORES.md`
- `docs/API-KEYS.md`
- `README.md`
- `CLAUDE.md`
- `AGENTS.md`

Out of scope:

- `notes/superpowers/specs/**` — numbered + dated execution specs; immutable after writing.
- `notes/specs/**` — dated handoff / spec archives; treat as archive.
- `docs/VISION.md` — strategic, rarely needs sync.

## Audit checklist

Run each item, collect findings, then fix in a single pass. Do not commit.

### 1. Command surface

Derive the current CLI command list from code/help output, then grep for `diptych <command>` patterns in docs:

```bash
rg -n "register[A-Za-z]+Command\(program\)" src/cli.ts
rg -n "\.command\(['\"]" src/cli/commands
npm run dev -- --help
rg -n "\bdiptych [a-z][a-z-]*\b" docs/ README.md CLAUDE.md AGENTS.md
```

For each doc hit, cross-reference the command name against `src/cli.ts`, `src/cli/commands/`, and the help output. Commands missing from code but present in docs → remove from docs or mark as planned-only in the same paragraph. In particular, `diptych sessions` is planned-only until a standalone CLI command exists; `/sessions` is a runtime UI command, not a top-level CLI command.

### 2. Phase list

`docs/WORKFLOW.md` §1.1 enumerates phases and actions. Compare with `src/core/state/machine.ts`:

- Every phase in the doc table → exists in `Phase` type.
- Every action in the doc table → exists in `StateAction` union.
- No phase or action exists only in code without doc mention.

Fix divergences in the doc, not the code (code is authoritative).

### 3. Capability matrix

`docs/ARCHITECTURE.md` "Capability matrix" shows per-backend capability values. Compare with `src/engine/planners/*.ts` — each backend's declared `capabilities` struct. Table rows must match.

### 4. Path references

Grep for `.diptych/` paths in docs:

```bash
grep -rn "\.diptych/" docs/ README.md
```

Cross-reference with `src/core/paths.ts` for file-name constants. Paths in docs that reference files not produced by current code (e.g. `events.jsonl` after spec 003 lands) → update.

### 5. Symbol references

Grep for type / function names in docs:

```bash
grep -rn "PlannerCapabilities\|WorkflowState\|EngineEvent\|sessionDir\|appendMessage\|queueMessage" docs/
```

For each, verify it still exists in `src/` with the documented shape. If shape changed, update doc.

### 6. Cross-references

Every "see `src/...`" or "see `docs/...`" link in a doc file must point at a real, current location. Check with a quick ls.

### 7. Deferred items

`docs/FUTURE.md` entries must still be deferred. If an item was implemented, remove it from FUTURE.md. If an item was renamed or restructured, update the description.

### 8. README freshness

- Quick-start commands copy-paste-able and working today.
- Config YAML example matches current `src/core/schemas/config.ts`.
- Every feature mentioned exists (no aspirational copy).

### 9. CLAUDE.md

- "Active technologies" list matches `package.json` dependencies (roughly — major packages only).
- "Project structure" tree matches the actual `src/` layout.
- "Commands" table matches `package.json` scripts.

### 10. Stale names

```bash
grep -rn "tiny-spec\b\|\.tiny-spec\b\|EVENTS_FILE\|/current/" docs/ README.md CLAUDE.md AGENTS.md
```

Any `tiny-spec`, `.tiny-spec`, or `EVENTS_FILE` hit outside intentional historical references (CHANGELOG) is stale and needs replacement. `/current/` is context-sensitive: it is stale in normal session/storage docs, but valid in migration or legacy-compatibility sections that describe importing pre-v3 `.diptych/current/` state. Cross-reference current constants in `src/core/paths.ts` and migration support in `src/core/migration/` before editing.

## Report format

Produce a single summary after the full audit:

```
## Doc sync audit report

Files audited: <count>
Divergences found: <count>
Fixes applied: <count>

By category:
- Command surface: <N issues, N fixed>
- Phase list: <...>
- Capability matrix: <...>
- Paths: <...>
- Symbols: <...>
- Cross-refs: <...>
- FUTURE entries: <...>
- README: <...>
- CLAUDE.md: <...>
- Stale names: <...>

Not fixed (flagged for user decision):
- <bullet list, each with explanation>

Files modified:
- docs/CONCEPTS.md (N sections)
- docs/ARCHITECTURE.md (N sections)
- …
```

## Constraints

- Do not commit or stage.
- Do not modify `notes/superpowers/specs/`, `notes/specs/`, `.specify/`.
- Do not invent information to fill gaps — if code is unclear, ask the user rather than guess.
- Prefer small surgical edits to full rewrites. An out-of-date paragraph gets a targeted fix, not a section rewrite.
