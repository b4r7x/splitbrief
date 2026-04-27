# 04 - Cost Telemetry TUI

> Fresh AI context brief. Implement only this change. Never stage, commit, or stash.

## Goal

Make cost telemetry accurate in production and visible where the cost telemetry spec promises it.

## Read First

- `CLAUDE.md`
- `docs/superpowers/specs/2026-04-26-cost-telemetry-tui/README.md`
- `docs/superpowers/specs/2026-04-26-cost-telemetry-tui/decisions.md`
- `src/core/schemas/tokens.ts`
- `src/engine/orchestrator/tokens.ts`
- `src/engine/providers/anthropic/stream.ts`
- `src/engine/providers/pricing.ts`
- `src/stores/workflow/actions.ts`
- `src/stores/workflow/tokens.ts`
- `src/features/workflow/components/cost-footer.tsx`
- `src/features/workflow/components/cost-status-line.tsx`
- `src/features/workflow/components/cost-drilldown-overlay.tsx`
- `src/features/workflow/screen.tsx`
- `src/app.tsx`

## Scope

**In bounds:**

- Production `cost_update` event handling must update per-phase data.
- Per-phase `cost` must be computed from model pricing/token usage, not left at `0`.
- Cache create/read token fields must be parsed from providers that expose them.
- Drilldown must render real per-phase cost/cache data.
- Status line or cost footer must be mounted according to the original spec's "always visible" requirement, with narrow terminal fallback.
- `CostFooter` vs `InputFooter` docs/code mismatch must be resolved.
- Budget pause behavior should use the same telemetry source.

**Out of bounds:**

- New pricing service or remote price fetch.
- New runner implementations.
- Per-task budget controls.
- Decorative UI redesign.

## Required Fixes

### 1. `cost_update` feeds `perPhase`

The store action path that receives real `cost_update` events must call the same aggregation path used by tests and direct token updates. Do not special-case `cost_update` in a way that bypasses `perPhase`.

### 2. Compute per-phase cost

`perPhase.cost` must be derived using the existing pricing utilities and model/provider metadata available in the event or store. If a model cannot be priced, render unknown/zero explicitly and cover that fallback in tests.

### 3. Cache telemetry is ingested

Extend token schemas and provider usage parsing so cache create/read token counts can flow from Anthropic usage into normalized token deltas and the store. Runners that do not expose cache data should keep fields undefined and render `n/a`.

### 4. Status line is actually visible

Wire the cost status line/footer into the screens promised by the cost telemetry spec. It must fit one row and degrade gracefully at narrow widths.

### 5. Drilldown shows real data

The `$` overlay must render per-phase/token/cost/cache values from the store, not placeholder zeros.

## Acceptance Criteria

- A real `cost_update` event changes `tokenUsage` and `perPhase`.
- Per-phase costs are non-zero when token usage and pricing are known.
- Cache read/create token data appears in store state for Anthropic usage fixtures.
- Drilldown displays real phase costs and cache hit rates, or `n/a` when unsupported.
- Status line/footer is visible on every workflow screen required by the original spec.
- Budget pause uses consistent spent/projected cost values.

## Tests

Add or update tests for:

- `addEvent({ type: 'cost_update' })` updates `perPhase`,
- Anthropic usage parsing with cache fields,
- pricing fallback for unknown models,
- drilldown rendered output with non-zero phase cost,
- status line mounted in workflow screens,
- narrow width rendering does not overflow obvious fixed-width containers.

## Verification Commands

```bash
npm test -- src/core/schemas/tokens.test.ts src/engine/orchestrator/tokens.test.ts src/stores/workflow src/features/workflow/components
npm run typecheck
npm run lint
npm test
```

