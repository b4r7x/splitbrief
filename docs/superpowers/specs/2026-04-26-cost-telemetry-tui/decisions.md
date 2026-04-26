# Decisions

## ADR-001 — Cache Token Fields Are Optional Extensions to TokenUsage

**Status:** accepted

### Context

The current `TokenUsage` schema (`src/core/schemas/tokens.ts`) tracks only `plannerInput`, `plannerOutput`, `implementerInput`, `implementerOutput`, `escalationInput`, `escalationOutput`. Cache read and cache creation tokens are exposed by Anthropic API responses but are not captured today. Different runner kinds have different access: `api` and `agent-sdk` runners receive raw API responses with cache fields; `cli` runners (claude-code) emit usage summaries that may or may not include cache fields; `shell` and `agent` runners have no structured output at all.

### Decision

Add optional fields to `TokenUsage`: `plannerCacheRead`, `plannerCacheCreate`, `implementerCacheRead`, `implementerCacheCreate`. All fields are `z.number().nonnegative().optional()`. Existing consumers are unaffected (optional fields, no schema version bump required). The `cost_update` event carries `TokenUsage`, so it automatically propagates the new fields when populated.

### Consequences

- Runners that do not expose cache data leave fields absent; the UI renders `cache n/a` rather than `0%`.
- Cache pricing can be computed when both cache fields and a cache-aware pricing entry exist; otherwise falls back to zero cache savings.
- No breaking schema change. Old `session.jsonl` entries remain valid.

---

## ADR-002 — Cost Data Lives in Extended tokensStore, Not a New Store

**Status:** accepted

### Context

A standalone `src/stores/cost/` directory was considered to isolate cost telemetry. However, `tokensStore` already holds `tokenUsage` and responds to `cost_update`. The workflow store is already the central event-dispatch target via `updateTokens`.

### Decision

Extend `tokensStore` with two additional fields:
- `perPhase: Record<string, { inputTokens: number; outputTokens: number; cacheRead: number; cost: number }>` — accumulated per planner phase.
- `prediction: CostPrediction | null` — latest `cost_prediction` event payload.

These fields are computed from existing events (`cost_update` splits are known by checking `phase` on the event; `cost_prediction` is a direct payload copy). No new store file. No new barrel.

### Consequences

- Status line and drill-down components both subscribe to `tokensStore` — single source of truth.
- Existing `updateTokens` pure function is extended, not replaced; its existing tests remain valid.
- Per-phase data is accurate only to the granularity of `cost_update` events (fired per planner API call and per task completion).

---

## ADR-003 — Pricing Source Is Existing pricing-resolver With Cache-Read Extension

**Status:** accepted

### Context

`src/engine/providers/pricing-resolver.ts` resolves per-1M pricing from models-dev catalog, runtime discovery, or bundled fallback. Cache-read tokens cost differently from regular input tokens on the Anthropic API (cache reads are ~10% of input cost; cache writes are ~125% of input cost, amortized). These rates are not in the current resolver.

### Decision

Extend `ResolvedPricing` with two optional fields: `cacheReadPer1M` and `cacheWritePer1M`. The bundled catalog entries for Anthropic models should include these values when known. Override pattern: users may specify `cacheReadPer1M` and `cacheWritePer1M` in the per-provider config block (same location as `input`/`output` overrides, if that mechanism exists) or accept the catalog value.

**VERIFY BEFORE IMPLEMENTING:** The exact cache-read and cache-write per-1M prices for every Anthropic model must be fetched from the current Anthropic pricing page before populating the catalog. Prices in this spec document are intentionally omitted to prevent stale values from being committed.

### Consequences

- Cache cost savings display requires both `cacheReadPer1M` and populated `plannerCacheRead` tokens — absent either, the cache column renders `n/a`.
- Non-Anthropic providers that do not expose cache tokens are unaffected.
- `calculateCostBreakdown` gains a cache-savings line in `CostBreakdown`.

---

## ADR-004 — Projected Cost Uses Rolling Average of Completed Tasks

**Status:** accepted

### Context

`CostPrediction` (in `src/core/schemas/summary.ts`) provides `lowCost / expectedCost / highCost` based on task count estimated by the planner before implementation. This is a static pre-implementation estimate. During implementation, a more useful projection is: (average actual cost per completed task) × (remaining tasks).

### Decision

Compute a live projected cost in `tokensStore` as soon as at least one task has completed:

```
projectedCost = (currentActualCost / completedTaskCount) * totalTaskCount
```

When no tasks have completed yet, fall back to `CostPrediction.expectedCost` from the `cost_prediction` event. If neither is available, the projected column renders `proj n/a`.

The computation is a pure function in `tokensStore`'s reducer — not a React hook, not a component-side derive.

### Consequences

- Projected cost improves in accuracy as more tasks complete.
- The projection can exceed the original planner estimate (useful signal to the user).
- No additional API call required.

---

## ADR-005 — Budget Pause Threshold Is 85%, Distinct from Existing 80% Warning

**Status:** accepted

### Context

`src/engine/orchestrator/budget.ts` already defines a warning at 80% (`BUDGET_WARNING_THRESHOLD = 0.8`) and a hard stop at 100% (exceeded). The task spec adds a new 85% "pause and confirm" gate. Three interpretations were considered:
1. Replace 80% warning with 85% pause.
2. Keep 80% warning + add 85% pause + keep 100% exceeded.
3. Remap 100% exceeded to 85%.

### Decision

Option 2: keep the existing 80% warning unchanged; add a new 85% pause gate (`BUDGET_PAUSE_THRESHOLD = 0.85`); keep the 100% `budget_exceeded` path unchanged. The three thresholds are: 80% silent warning → 85% interactive pause → 100% hard stop. Emit a new `budget_paused` event at 85%.

`BUDGET_PAUSE_THRESHOLD` is configurable via a new optional `workflow.budgetPauseThreshold: number` config field (range 0–1, default 0.85). Users who want the pause earlier or later can adjust without touching the code.

### Consequences

- Existing `budget_warning` and `budget_exceeded` events are untouched.
- New `budget_paused` event makes the interactive pause observable in `session.jsonl`.
- `enforceBudget` in `budget.ts` gains a new code path between warning and exceeded.
- A new `onBudgetPaused` callback is added to `OrchestratorCallbacks` (optional, no breaking change).

---

## ADR-006 — Budget Gate Uses onBudgetPaused Callback (Separate From onBudgetExceeded)

**Status:** accepted

### Context

`OrchestratorCallbacks.onBudgetExceeded` already exists and today returns `boolean` (continue or stop). Reusing it for the 85% pause would conflate two distinct events (interactive pause vs hard stop).

### Decision

Add `onBudgetPaused?: (currentCost: number, maxBudget: number) => Promise<'continue' | 'abort' | 'raise'>` to `OrchestratorCallbacks`. Three user responses:
- `'continue'` — continue (current threshold stays; next pause is at 100%).
- `'abort'` — cancel the workflow immediately.
- `'raise'` — not implemented in this spec; reserved for a future "edit budget" flow. Treated as `'continue'` for now; the spec documents this explicitly so an implementer does not invent behavior.

### Consequences

- The 85% pause and 100% exceeded remain mechanically separate.
- `headless.ts` must set `onBudgetPaused: async () => { process.exit(1); }` rather than returning a value (because fail-fast means no continuation).
- The TUI wires `onBudgetPaused` via the same `inputMode.setReviewMode` pattern used by `onBudgetExceeded` today. The TUI in v1 never returns `'raise'` — the review mode is binary (approved or rejected); `'raise'` is reserved for a future interactive budget-editing flow. The engine treats `'raise'` as `'continue'` until that flow ships.

---

## ADR-007 — Headless --json Mode Fails Fast at Budget Pause Threshold

**Status:** accepted

### Context

`src/cli/headless.ts` today sets `onBudgetExceeded: async () => true` (always continue). The task spec says headless mode must fail-fast at threshold.

### Decision

Headless mode at the 85% pause threshold exits immediately with code 1 and writes a machine-readable JSON line to stdout:

```json
{"type":"budget_paused","currentCost":8.50,"maxBudget":10.00,"threshold":0.85}
```

The existing `onBudgetExceeded` in headless.ts is left unchanged (it is the hard 100% stop, not the pause). A new `onBudgetPaused` implementation in headless.ts calls `process.exit(1)` after writing the JSON line.

This is a **behavior change** from the current implicit "always continue past budget" headless stance. Document this in `CHANGELOG.md` when the brief ships.

### Consequences

- CI pipelines using headless mode with a budget configured will now exit non-zero at 85%.
- Users must set `workflow.budgetPauseThreshold` higher or remove `workflow.maxBudget` to restore the old behavior.
- The exit code and JSON line give CI sufficient information to surface a budget warning.

---

## ADR-008 — Drill-Down Is an Overlay, Not a Screen

**Status:** accepted

### Context

`routerStore` (`src/stores/navigation/router.ts`) defines four named screens (`home`, `workflow`, `summary`, `setup`) with typed transition guards. Adding a fifth screen for cost drill-down would require new transition logic and break the existing screen invariants.

The router already has `OverlayType` for ephemeral UI panels (`help`, `command-palette`, `skills`, `settings`, `mode-selector`, `planner-picker`, `implementer-picker`, `sessions`). Drill-down fits this pattern: it appears over the workflow screen and is dismissed with any key.

### Decision

Add `'cost-drilldown'` to the `OverlayType` union in `src/stores/navigation/router.ts`. The `$` keybinding (only active during the workflow screen) sets the overlay to `'cost-drilldown'`. Any keypress dismisses it (same pattern as `help`). No new screen, no new navigation transitions.

### Consequences

- The drill-down cannot be deeplinked or resumed across sessions (acceptable — it is a live view).
- The overlay renders on top of the workflow screen and has access to all workflow store data.
- Brief 04 implements the new `OverlayType` value and the overlay component.

---

## ADR-009 — Status Line Extends CostFooter, Does Not Replace It

**Status:** accepted

### Context

`src/features/workflow/components/cost-footer.tsx` already renders at the bottom of the workflow screen. The task spec asks for a "top status line." Three options: move CostFooter to top, create a sibling component, or render the status data inside the existing layout header.

The smart-intake spec's `03-cost-risk-ux.md` also modifies `cost-footer.tsx`. To minimize collision risk and avoid layout restructuring across two specs, this spec extends the existing top-of-screen area.

### Decision

Look at where the existing `header.tsx` renders in the workflow layout. If there is sufficient space, add the cost status line as a second row inside the existing header component. If the header is already at capacity, create a new `cost-status-line.tsx` component placed immediately below the header, above the event feed. Either way, the brief's implementer must read `src/features/workflow/layout.ts` and `src/features/workflow/screen.tsx` before choosing placement.

The bottom `CostFooter` is NOT modified by this spec. It remains as the task-progress / mode / queue bar. The new status line is an additive cost-focused row, not a replacement.

### Consequences

- `cost-footer.tsx` collision with smart-intake brief 03 is avoided.
- Two rows may show overlapping cost data (CostFooter shows `spent`; status line also shows `spent`). Brief 03 implementer must suppress the `CostDisplay` from CostFooter if the status line is visible, or the brief can leave it as redundant during this iteration (document the duplication).
- The status line is always visible on every screen; the CostFooter is workflow-screen-only. This is the correct split.

---

## ADR-010 — Cache Hit Reporting Is Per-Runner, Best-Effort

**Status:** accepted

### Context

Cache token visibility varies by runner kind:
- `api` / `agent-sdk`: cache fields are in the API response; available when the Anthropic SDK surfaces them.
- `cli` (claude-code): Claude Code's stream may emit a usage summary including cache fields; availability is tool-version-dependent.
- `shell` / `agent`: output is unstructured; cache data is not available.

### Decision

Per-runner cache data support:

| Runner kind | Cache token support | Status line / drill-down rendering |
|---|---|---|
| `api` | Available via API response | Full cache-hit % |
| `agent-sdk` | Available via SDK response | Full cache-hit % |
| `cli` (claude-code) | Best-effort; parse if present | Cache-hit % if present, else `n/a` |
| `cli` (other tools) | Not available | `cache n/a` |
| `shell` | Not available | `cache n/a` |
| `agent` | Not available | `cache n/a` |

Cache hit % is computed as `cacheRead / (cacheRead + inputTokens)` when both are nonzero. The status line shows `cache n/a` when cache fields are absent. No error is emitted; absence is expected.

### Consequences

- The UI never shows stale zeros; it shows `n/a` instead.
- Brief 01 adds optional cache fields to `TokenUsage`; they are populated only by runners that emit them.
- Brief 02 documents per-runner population responsibility.
