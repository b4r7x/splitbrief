# HTML Session Export — 10

> **Status:** specified, not yet implemented.
> **Scope:** CLI command + slash command to export a completed session as a self-contained HTML report.
> **Write scope:** `src/engine/export/`, `src/cli/commands/export.ts`, `src/core/slash-commands/catalog.ts`, colocated tests.
> **Out of scope:** PDF export, Markdown export, interactive JavaScript, CDN dependencies, real-time streaming, dashboards.

## Problem

The hero savings stat and summary screen die when the terminal closes. `summary.json` exists on disk but it's raw JSON — not shareable. There is no way to show a colleague or manager "here's what diptych did and how much it saved." This blocks the viral loop ("look how much I saved") that drives adoption.

## Scope

1. **HTML renderer:** Pure function that takes session artifacts (`summary.json`, `evidence.json`, `drift-report.json`, `brief-quality.json`) and produces a single self-contained HTML string. Inline CSS, zero JavaScript, zero CDN — works offline.
2. **CLI command:** `diptych export [session-id] [--out path]` writes the HTML file.
3. **Slash command:** `/export` in TUI generates the file and prints the path.

## Non-Goals

- Do not add JavaScript to the HTML output.
- Do not add external CSS/font CDN links.
- Do not build PDF or Markdown renderers (separate feature if needed).
- Do not build a dashboard or web server.
- Do not stream real-time data — export is a point-in-time snapshot.
- Do not regenerate or recompute any data — only render existing artifacts.

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `README.md` | Problem, scope, non-goals. |
| 2 | `decisions.md` | Design decisions. |
| 3 | `execute-prompt.md` | Copy/paste prompt for implementation context. |
| 4 | `agent-briefs/01-html-renderer.md` | Pure renderer function. |
| 5 | `agent-briefs/02-cli-and-slash-command.md` | CLI + TUI integration. |
