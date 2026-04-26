# 02 — Pricing Catalog

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Identity

You are extending the provider pricing infrastructure to support cache-read and cache-write token pricing, and documenting per-runner cache data availability. This brief is purely engine-side and has no TUI component.

## Intent

Make cache token costs computable so that `calculateCostBreakdown` can report actual cache savings. Gate all catalog prices behind a "VERIFY BEFORE IMPLEMENTING" check — this document does not contain authoritative prices.

## Scope

### In scope

- Extend `ResolvedPricing` interface with optional `cacheReadPer1M` and `cacheWritePer1M` fields.
- Update `calculateCostBreakdown` to include cache savings in `CostBreakdown` when the new fields are present.
- Extend the bundled Anthropic model entries in `pricing-resolver.ts` (or wherever the catalog lives) to include cache pricing. **You must fetch current prices from the Anthropic pricing page before committing any numbers.**
- Document per-runner cache data population responsibility.
- Add or extend tests for the updated pricing computation.

### Out of scope

- Modifying any TUI component.
- Changing how runners emit usage events (runners populate `TokenUsage.plannerCacheRead` etc.; this brief only consumes those fields in price computation).
- Changing `TokenUsage` schema (brief 01 does that).

## Code Context

### Files to read first

- `src/engine/providers/pricing-resolver.ts` — `ResolvedPricing`, `resolvePricing`, bundled fallback catalog.
- `src/engine/providers/pricing.ts` — `calculateCostBreakdown`, `CostBreakdown`.
- `src/core/schemas/summary.ts` — `CostBreakdown` schema (check if `cacheSavings` field exists or needs adding).
- `src/core/schemas/tokens.ts` — `TokenUsage` with new cache fields from brief 01.
- `src/engine/providers/pricing.test.ts` and `pricing-resolver.test.ts` — understand test patterns.

### Files to touch

- `src/engine/providers/pricing-resolver.ts`
- `src/engine/providers/pricing.ts`
- `src/engine/providers/pricing.test.ts`
- `src/core/schemas/summary.ts` (only if `cacheSavings` or `cacheReadCost` field is needed in `CostBreakdown`)

Do not touch runner files or TUI files.

## Implementation Plan

### Step 1 — Extend ResolvedPricing

Add to `ResolvedPricing` in `pricing-resolver.ts`:

```ts
cacheReadPer1M?: number;
cacheWritePer1M?: number;
```

Both optional. Existing consumers that do not read these fields are unaffected.

### Step 2 — VERIFY BEFORE IMPLEMENTING — Populate Anthropic cache pricing

> **STOP: Do not hardcode any price values from this document. Before writing any number to the source code, fetch the current pricing from the Anthropic pricing page (https://www.anthropic.com/pricing or the API pricing docs). The prices for cache read and cache write tokens vary by model and change over time. This spec intentionally omits specific values to prevent stale data from being committed.**

After verifying prices, add `cacheReadPer1M` and `cacheWritePer1M` to Anthropic model entries in the bundled catalog. Use the same structure as existing `input`/`output` entries. If the catalog is keyed by model prefix (e.g. `claude-3-5-sonnet`), add cache fields at the same level.

### Step 3 — Extend calculateCostBreakdown

In `pricing.ts`, `calculateCostBreakdown` currently ignores cache token fields (they did not exist in `TokenUsage` before brief 01). Extend it to:

1. When `tokenUsage.plannerCacheRead` is defined and `pricing.cacheReadPer1M` is defined:
   - Compute `cacheReadCost = (plannerCacheRead / 1_000_000) * cacheReadPer1M`.
   - Compute `cacheInputCost = what would have been paid if those tokens were regular input`.
   - `cacheSavings = cacheInputCost - cacheReadCost`.
2. Accumulate across planner and implementer cache reads.
3. Add `cacheReadSavings: number` to `CostBreakdown` (add to `CostBreakdownSchema` in `src/core/schemas/summary.ts` as `.optional()`).
4. Add `cacheReadTokens: number` and `cacheWriteTokens: number` to `CostBreakdown` for the drill-down display (so brief 04 can show raw numbers). These are optional.

If either `cacheRead` tokens or `cacheReadPer1M` is absent, `cacheReadSavings` defaults to 0 and the field is not set.

### Step 4 — Per-runner population documentation

Add a comment block near the top of `pricing.ts` (or in a docstring on `calculateCostBreakdown`) documenting which runners populate cache tokens:

```ts
// Cache token population by runner kind:
// - api / agent-sdk: populated from API response when the SDK exposes cache_read_input_tokens
// - cli (claude-code): best-effort; populated when the tool stream includes cache fields
// - cli (other), shell, agent: not available; cache fields will be absent in TokenUsage
// When absent, cacheReadSavings is 0 and cache columns render 'n/a' in TUI.
```

This is documentation only — no code behavior change.

### Step 5 — Update CostBreakdown schema (if needed)

If Step 3 adds fields to `CostBreakdown`, update `CostBreakdownSchema` in `src/core/schemas/summary.ts` with optional Zod fields. Do not break the existing shape.

## Validation

Tests to add or extend:

- `calculateCostBreakdown` with `cacheRead` tokens and a priced provider returns correct `cacheReadSavings`.
- `calculateCostBreakdown` with `cacheRead` tokens and an unpriced provider returns `cacheReadSavings = 0`.
- `calculateCostBreakdown` without `cacheRead` tokens returns `cacheReadSavings = 0` (backward compat).
- `resolvePricing` for Anthropic models returns `cacheReadPer1M` and `cacheWritePer1M` when the catalog contains them.
- `resolvePricing` for non-Anthropic models returns `undefined` for cache pricing fields.
- `CostBreakdown` Zod schema accepts both old shape (no cache fields) and new shape.

## Constraints

- No classes.
- No barrels.
- ESM `.js` import suffixes.
- Do not import Ink, React, or any `src/features/` path.
- All hardcoded price values must be verified against the current Anthropic pricing page before implementation. The "VERIFY" callout is a hard gate, not a suggestion.

## Escalation

If the bundled catalog structure does not support per-model cache pricing cleanly, prefer adding a separate `anthropicCachePricing` map keyed by model prefix, and merge it in `resolvePricing`. Document the chosen approach with an inline comment.

## Evidence Requirements

- `npm test -- src/engine/providers/pricing.test.ts src/engine/providers/pricing-resolver.test.ts` passes.
- `npm run typecheck` passes.
- `npm run lint` passes.
- The "VERIFY BEFORE IMPLEMENTING" instruction is removed from source code comments before shipping (it is a spec-authoring note, not production code documentation).
