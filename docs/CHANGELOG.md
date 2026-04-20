# diptych — Changelog

## 2026-04-20 — SOTA Architecture Uplift

### Summary

Unified `EventBus` replaces every per-call-site callback. Workflow hook system, repo-map planner context, OpenTelemetry integration, and a headless `--json` mode ride on top of the same bus. Detailed design rationale is folded into the subsystem docs (`ARCHITECTURE.md`, `HOOKS-CONFIG.md`, `REPOMAP.md`, `OTEL.md`) rather than kept in separate ADRs.

### Amendments beyond original plan

#### A1 — OpenTelemetry sink

Added `otelSink` as the third EventBus sink (opt-in via `config.otel.enabled`). Span hierarchy: `diptych.workflow` → `diptych.phase.<name>` → `diptych.task`. Bring-your-own `TracerProvider`; a console-exporter shortcut is available via `DIPTYCH_OTEL_EXPORTER=console` or the `--otel-exporter console` flag for local debugging.

Files:
- `src/cli/otel-bootstrap.ts`
- `src/core/schemas/otel.ts`
- `src/engine/events/sinks/otel.ts`

See [`docs/OTEL.md`](./OTEL.md) for the span model, attribute namespace, and setup walkthrough.

#### A2 — Headless mode (--json flag)

New `--json` flag on the `start` and `resume` commands. No-TUI execution, NDJSON `EngineEvent` stream on stdout, auto-approval of every gating callback. CI-integration friendly; pairs with `--allow-hooks` for a non-interactive hooks config.

Files:
- `src/cli/headless.ts`
- `src/engine/events/sinks/stdout-json.ts`

See [`docs/MIGRATION.md` §Headless mode](./MIGRATION.md).

#### A3 — tuiSink redesign

Task T1.4 in the original plan called for a full `EngineEvent → TuiEvent` mapper inside the TUI sink. Because T1.10 landed first (deleting `TuiEvent` and `src/features/workflow/types.ts` outright), the mapper became vestigial. `createTuiSink()` is now a thin pass-through that returns `actions.addEvent` — the workflow store consumes `EngineEvent` directly.

File: `src/engine/events/sinks/tui.ts`.

#### A4 — Test suite cleanup

A post-uplift audit against `docs/TESTING.md` turned up roughly 40 tests that verified implementation details rather than behavior (sibling `vi.mock('./...')` calls, `toHaveBeenCalled` spies on private helpers, sharded store tests, trivial wrapper hook tests). All were rewritten in behavior style or deleted. Final state: 1904/1904 tests passing.

### Acceptance gates (verified)

| # | Invariant | Expected | Actual |
|---|---|---:|---:|
| 1 | No `callbacks.onEvent` in `src/` | 0 | 0 |
| 2 | No `OrchestratorEvent` in `src/` | 0 | 0 |
| 3 | No `TuiEvent` in `src/` | 0 | 0 |
| 4 | No raw `throw new Error` in `engine/`, `cli/`, `lib/` | 0 | 0 |
| 5 | No sibling `vi.mock('./...')` or `vi.mock('../...')` | 0 | 0 |
| 6 | Full test suite | green | 1904/1904 |
| 7 | Typecheck | clean | clean |
| 8 | Lint | clean | clean |

### Architectural rules applied

Copied verbatim from the plan's §Architectural rules. These are the non-negotiables every task in the uplift was held against; they are already canonical in `CLAUDE.md` but restated here so the changelog audit is self-contained.

| Rule | Source |
|---|---|
| Zero classes — pure functions + module-scoped state only | `CLAUDE.md` |
| ESM with `.js` extension in every import path | `CLAUDE.md` |
| kebab-case file/folder names | `CLAUDE.md` |
| No barrels — no re-export-only `index.ts` anywhere in `src/` | `docs/NO-BARRELS.md` |
| No `useMemo` / `useCallback` / `React.memo` / `forwardRef` | `docs/STORES.md` |
| No decorative comments / no section banners | `docs/STRUCTURE.md` |
| No backwards-compat shims — update all import sites in the same change | `docs/PRINCIPLES.md` |
| No unsafe `as` / `!` outside the sanctioned files in `CLAUDE.md` | `CLAUDE.md` |
| Tests test behavior, not implementation — no `vi.mock` on siblings | `docs/STRUCTURE.md`, `docs/TESTING.md` |
| Test placement: colocated `*.test.ts` if blast-radius <= 1 layer; else `testing/integration/<layer>/` | `docs/STRUCTURE.md` |
| File length: > 300 LOC + > 1 concern -> folder colocation | `docs/STRUCTURE.md` |
| Engine MUST NOT import from `react`, `ink`, `src/features/`, `src/components/`, `src/hooks/` | `docs/ARCHITECTURE.md` |

### References

- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — EventBus data flow, design decisions.
- [`docs/HOOKS-CONFIG.md`](./HOOKS-CONFIG.md) — hook config, subprocess protocol, failure modes, design decisions.
- [`docs/REPOMAP.md`](./REPOMAP.md) — repo-map pipeline, cache, ranking, design decisions.
- [`docs/OTEL.md`](./OTEL.md) — OpenTelemetry integration, span model, design decisions.
- [`docs/CONCEPTS.md`](./CONCEPTS.md) — glossary.
- [`docs/FUTURE.md`](./FUTURE.md) — open questions and v2 follow-ups.
- [`docs/MIGRATION.md`](./MIGRATION.md) — pre-uplift → uplift breaking-change reference.

## Earlier migrations

### models.dev as primary catalog

diptych treats [models.dev](https://models.dev) as the primary model catalog and pricing source. README §Models documents the user-facing contract; the notes below capture the behavior details that used to live in a standalone migration doc.

**Precedence** (first hit wins):

1. `models.dev`
2. Runtime provider detection / CLI discovery
3. Bundled offline fallback manifest

**Behavior:**

- CLI tools and subscriptions stay unpriced. We no longer proxy-price `claude-code`, `codex`, `copilot`, `opencode`, `kilo-code`, or `aider` through upstream APIs.
- Claude Code uses tool-native aliases: `default`, `sonnet`, `opus`, `opusplan`.
- Legacy stored `claude-code: auto` still works and normalizes to `default`.
- `opencode` and `kilo-code` should usually stay on `auto`; configure the real model in the tool itself.
- `models.dev` prices are already expressed in USD per 1M tokens. Do not multiply them again.
