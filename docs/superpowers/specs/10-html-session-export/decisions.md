# Decisions

## ADR-001 — Single Self-Contained HTML File

**Status:** accepted

### Context

Export must be shareable — copy to Slack, email, open in any browser. External dependencies (CSS CDN, JS libraries, images) break offline viewing and add fragility.

### Decision

Generate one `.html` file with all CSS inlined in a `<style>` block. Zero JavaScript, zero external resources, zero images. Pure HTML + CSS.

### Consequences

- Works offline, works in any browser, works in email preview.
- File size stays small (summary data is ~5-20KB, CSS ~3KB).
- No interactive features (sorting, filtering) — acceptable for a report.
- Copy-pasteable path output: user can `open report.html` or drag to Slack.

## ADR-002 — Render Existing Artifacts Only, Never Recompute

**Status:** accepted

### Context

After workflow completion, multiple JSON artifacts exist in `.diptych/sessions/<id>/`. The export could either recompute stats or read existing files.

### Decision

Read and render only what already exists on disk. Files consumed:

| File | Required | Purpose |
|---|---|---|
| `summary.json` | yes | Core data: costs, tasks, timing, tools |
| `evidence.json` | no | Validation evidence per task |
| `drift-report.json` | no | Drift analysis |
| `brief-quality.json` | no | Quality gate results |
| `tasks.md` | no | Original task briefs |

If an optional file is missing, that section is omitted from the HTML. No errors.

### Consequences

- Export is instant — no LLM calls, no validation runs, no git operations.
- Missing optional artifacts gracefully degrade (section omitted, not error).
- Export reflects the exact state at workflow completion.

## ADR-003 — CLI Command + Slash Command

**Status:** accepted

### Context

Users need export both from outside the TUI (completed sessions) and inside (active session). Two entry points.

### Decision

- CLI: `diptych export [session-id] [--out path]`. Defaults to active/most-recent session. Default output: `.diptych/sessions/<id>/report.html`.
- TUI: `/export` slash command. Same logic, prints path to generated file.

### Consequences

- CI pipelines can generate reports via CLI (`diptych export --json <id>`).
- TUI users get inline access without leaving the session.
- Both paths call the same `renderSessionHtml()` function.

## ADR-004 — Template as Pure TypeScript Function

**Status:** accepted

### Context

HTML generation can use template literals, template files, or a templating library.

### Decision

Template is a pure TS function: `renderSessionHtml(data: ExportData): string`. Uses tagged template literals. No template files, no Handlebars/EJS, no dependencies.

### Consequences

- Type-safe: `ExportData` type ensures all required fields are passed.
- Testable: unit test passes data, asserts HTML output contains expected sections.
- No build step for templates, no runtime template parsing.
