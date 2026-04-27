# 05 - Artifacts, MCP, Handoff

> Fresh AI context brief. Implement only this change. Never stage, commit, or stash.

## Goal

Make MCP resources and external handoff artifacts reflect canonical session state and complete artifact manifests.

## Read First

- `CLAUDE.md`
- `docs/superpowers/specs/2026-04-26-mcp-resources-server/README.md`
- `docs/superpowers/specs/2026-04-26-mcp-resources-server/decisions.md`
- `docs/superpowers/specs/2026-04-22-external-agent-handoff-packs/README.md`
- `docs/superpowers/specs/2026-04-22-external-agent-handoff-packs/decisions.md`
- `src/engine/mcp/resolver.ts`
- `src/engine/mcp/handlers.ts`
- `src/engine/handoff/write.ts`
- `src/engine/handoff/manifest.ts`
- `src/engine/handoff/renderers.ts`
- `src/core/config/load/load.ts`

## Scope

**In bounds:**

- MCP `manifest.json` synthesis from canonical `summary.json` and `state.json`.
- Resource-not-found behavior when required canonical artifacts are missing.
- MCP resource listing that does not advertise unavailable manifests.
- Concrete `summary.json` and `state.json` resource behavior when present/missing.
- Handoff append mode manifest completeness.
- Handoff validation extraction for `typecheck`, `lint`, and `test`.
- Tests for resource resolver and handoff writer behavior.

**Out of bounds:**

- MCP tools/prompts/subscriptions.
- Remote MCP authentication changes beyond existing local bearer token.
- External agent execution. Handoff artifacts must remain inert.
- New custom renderer feature work.

## Required Fixes

### 1. MCP manifest uses canonical artifacts

When reading `.../manifest.json`, load the canonical session `summary.json` and `state.json` required by the original spec. If a required artifact is missing, return resource-not-found instead of synthesizing a partial manifest from `tasks.md` or directory listings.

### 2. Concrete MCP resources are honest

MCP resources for `manifest.json`, `summary.json`, and `state.json` should be listed/read when present. Missing concrete resources return JSON-RPC `-32002 Resource not found`; do not return silent empty success except for intentionally virtual resources such as a sessions index.

### 3. MCP resource list is honest

Only list `manifest.json` for sessions where required canonical artifacts exist. Keep current core resources that are correctly supported.

### 4. Handoff append mode writes complete manifests

When append mode skips existing files, the final `manifest.json` must include both newly written files and pre-existing handoff artifacts that remain part of the pack. Do not derive `artifacts.tasks` only from `writtenFiles`.

### 5. Handoff validation includes all configured commands

The handoff manifest must include configured/default validation commands for:

- `typecheck`,
- `lint`,
- `test`.

Do not collapse validation to only `test`.

## Acceptance Criteria

- MCP `manifest.json` returns resource-not-found when `summary.json` is absent.
- MCP `manifest.json` contents are derived from `summary.json` and `state.json`.
- Concrete missing MCP resources return `-32002 Resource not found`.
- MCP list does not advertise unavailable manifests.
- Handoff append mode preserves pre-existing task files in `manifest.json`.
- Handoff validation metadata includes typecheck, lint, and test commands when configured.
- Handoff rendering remains inert and does not spawn external agents.

## Tests

Add or update tests for:

- MCP manifest success from summary/state fixtures,
- MCP manifest missing summary resource-not-found,
- concrete summary/state resource success and missing-resource failures,
- MCP list excludes unavailable manifest,
- handoff append mode manifest completeness,
- validation command extraction for typecheck/lint/test,
- no external command spawn in handoff writer path.

## Verification Commands

```bash
npm test -- src/engine/mcp src/engine/handoff
npm run typecheck
npm run lint
npm test
```
