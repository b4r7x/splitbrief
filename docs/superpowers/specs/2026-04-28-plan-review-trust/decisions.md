# Decisions

## ADR 001: Scorecard Buckets Are Execution Readiness, Not Project Status

**Status:** accepted.

Plan Review should summarize readiness for the current execution session. Buckets are based on whether the next implementer call is likely to be safe and bounded, not on project-management lifecycle.

Consequences:

- `ready` means safe to dispatch now, not "done".
- `routing pending` means routing metadata, worker selection, token estimate, or context fit is missing, stale, pending, or unknown for the current task content.
- `split/overflow` means the Task Brief is too large, too broad, or too poorly bounded for the selected worker path.
- `risky/tight` means the task may work but deserves attention before approval.
- `stale/conflict` means the task may overwrite or reason from old code.
- `missing checks` means validation/evidence is not strong enough to trust execution.

## ADR 002: Warning Buckets May Overlap

**Status:** accepted.

A task can be both routing pending and missing evidence, tight and missing evidence, or overflow and conflicted. The scorecard should expose all trust gaps. Only `ready` is exclusive.

This avoids hiding important concerns behind a single severity ranking.

Unknown routing/context fit is never treated as ready. A task becomes ready only after fresh routing metadata says the current task fits a selected worker profile.

## ADR 003: Worker Packet Preview Uses The Real Formatter

**Status:** accepted.

The preview must be generated from `formatTaskPrompt`, `SYSTEM_PREAMBLE`, token estimation, and routing metadata. It must not maintain a second handcrafted prompt template.

This keeps the preview trustworthy: when dispatch changes, preview changes with it.

## ADR 004: Redact And Truncate Display, Not Dispatch Semantics

**Status:** accepted.

The preview is a terminal display of the worker packet. It may redact secret-looking values and truncate long visible output, but it should label those transformations and preserve section shape.

Rules:

- Redact common secret-looking assignments, tokens, API keys, private keys, bearer tokens, and credential URLs.
- Keep headings and nearby context visible where possible.
- Show display token/character truncation markers.
- Do not write the preview to disk in v1.

## ADR 005: Dense Text UI Over Cards

**Status:** accepted.

Plan Review is a work surface in a TUI. It should remain compact and scannable. Use short labels, stable ordering, theme colors, and row-budget-aware panels.

Do not introduce dashboard cards, kanban columns, or large decorative layouts.

## ADR 006: No New Store Unless Needed

**Status:** accepted.

Existing `planEditorStore` already owns Plan Editor UI state and review metadata. Add a small field there only if preview visibility cannot be held locally. Do not add a separate Plan Review store for derived scorecard or preview data.

Derived values should be computed from tasks, quality, metadata, selected task, and config.

## ADR 007: Preview Is Rich Editor Only In V1

**Status:** accepted.

Simple Brief Review keeps its command-oriented approve/edit/comment/reject flow. Worker Packet Preview starts in rich Plan Editor because it already has selected-task navigation and expansion state.

This limits UI complexity while still serving the trust goal.

## ADR 008: No Runtime Execution Policy Expansion

**Status:** accepted.

This feature does not add parallel writes, a full multi-agent manager, MCP mutation tools, or plan archive behavior. Durable sessions remain execution/session history. It surfaces readiness for the existing sequential fresh-context execution model.
