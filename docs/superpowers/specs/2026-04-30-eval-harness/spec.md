# P1: Eval Harness — Prove "Same Quality, Lower Cost"

**Date:** 2026-04-30
**Priority:** P1 — highest. Without this, diptych has architecture but no proof.
**Status:** Spec complete, ready for implementation.

## 1. Overview

Diptych's core thesis: an expensive planner (Opus) compiles Task Briefs; a cheap implementer (Haiku, Ollama, local) executes them — delivering comparable quality at a fraction of the cost. **This spec builds the eval harness that proves or disproves that claim with numbers.**

The harness runs N eval scenarios in two modes:

- **Baseline** — the expensive model does everything (planner + implementer = same model).
- **Routed** — diptych's normal flow: expensive planner compiles Task Briefs, cheap implementer executes.

For each scenario it measures cost, quality (test pass rate, diff correctness, file ownership accuracy), and time. The output is a JSON report + markdown summary table showing savings percentages and quality retention.

### Why this is the highest priority

Every other feature (cost telemetry, plan editor, snapshots, MCP, recovery, doctor) is UX around the core loop. But if the core loop doesn't actually deliver savings without quality loss, none of it matters. Users need one artifact: a table showing "60% cost reduction, 95% quality retention." This spec produces that table.

## 2. Architecture

### File layout

```
evals/
├── cli.ts                    # Entry point: `npx tsx evals/cli.ts`
├── runner.ts                 # Orchestrates baseline vs routed runs
├── metrics.ts                # Metrics types + collection
├── report.ts                 # JSON + markdown report generation
├── cassette/
│   ├── recorder.ts           # Records API responses during live runs
│   ├── replayer.ts           # Replays recorded responses for reproducibility
│   └── types.ts              # Cassette format types
├── scenarios/
│   ├── types.ts              # EvalScenario type definition
│   ├── add-endpoint.ts       # Scenario: add a REST endpoint
│   ├── fix-bug.ts            # Scenario: fix an off-by-one bug
│   ├── add-test.ts           # Scenario: add missing test coverage
│   ├── refactor-extract.ts   # Scenario: extract function from large module
│   └── add-validation.ts     # Scenario: add input validation
├── fixtures/
│   ├── add-endpoint/         # Fixture project for add-endpoint scenario
│   │   ├── src/
│   │   ├── package.json
│   │   └── .diptych/config.yaml
│   ├── fix-bug/
│   ├── add-test/
│   ├── refactor-extract/
│   └── add-validation/
├── cassettes/                # Recorded API response cassettes (gitignored initially)
│   └── .gitkeep
├── results/                  # Generated reports (gitignored)
│   └── .gitkeep
└── eval.test.ts              # Vitest: asserts harness itself works with fakes
```

### Integration with existing infrastructure

- **Does NOT live in `src/`** — evals are a development tool, not shipped code. Top-level `evals/` directory.
- **Reuses `runWorkflow()`** — the same `src/engine/orchestrator/run/run.ts` entry point used by tests and production.
- **Reuses `RunWorkflowOptions._planner` and `_eventSink`** — test-only injection points already exist for fake planners and event recording.
- **Reuses `Summary` and `CostBreakdown`** — captures the same cost data the TUI shows.
- **Reuses `createEventBus()` + subscriber** — records all events for quality analysis.
- **Reuses `calculateCost()` from `src/engine/providers/pricing.ts`** — same pricing math.
- **Does NOT import from `ink`, React, or any TUI code** — headless only.

### How it integrates with diptych's runner system

The eval harness creates real `Config` objects pointing at real runner configurations. For **baseline** mode, both planner and implementer point at the same expensive model (e.g., `api` kind → Anthropic Opus). For **routed** mode, planner is the expensive model, implementer is a cheap one (Haiku or local Ollama).

The harness calls `runWorkflow()` with `headless: true` plus auto-approve callbacks, exactly like `src/cli/headless.ts` does.

## 3. Eval scenarios

Each scenario is a self-contained TypeScript project in `evals/fixtures/<name>/` with a known-good state. The harness copies it to a temp dir, runs the workflow, and evaluates the result.

### Scenario list (v1: 5 scenarios)

| ID | Name | Feature prompt | What it tests | Quality signals |
|---|---|---|---|---|
| `add-endpoint` | Add REST endpoint | "Add a GET /api/health endpoint that returns { status: 'ok', uptime: process.uptime() }" | New file creation, basic routing | File created, exports handler, test passes |
| `fix-bug` | Fix off-by-one | "Fix the off-by-one error in calculatePagination — it skips the last page" | Bug fix in existing file | Bug actually fixed, existing tests pass, no unrelated changes |
| `add-test` | Add test coverage | "Add tests for the validateEmail function — cover valid emails, invalid formats, and edge cases" | Test generation | Test file created, tests pass, covers stated scenarios |
| `refactor-extract` | Extract function | "Extract the retry logic from processQueue into a standalone retryWithBackoff function" | Refactoring, file modification | Function extracted, callers updated, tests pass, no behavior change |
| `add-validation` | Add input validation | "Add Zod validation to the createUser handler — validate email, name (1-100 chars), and optional phone" | Schema creation, handler modification | Zod schema exists, handler uses it, invalid input returns 400 |

### Scenario type definition

```typescript
// evals/scenarios/types.ts

export type QualityCheck = {
  name: string;
  check: (resultDir: string) => Promise<QualityCheckResult>;
};

export type QualityCheckResult = {
  passed: boolean;
  detail: string;
};

export type EvalScenario = {
  id: string;
  name: string;
  feature: string;
  fixtureDir: string;
  mode: 'quick';
  qualityChecks: QualityCheck[];
};
```

### Fixture project structure

Each fixture is a minimal TypeScript project with just enough code for the scenario. Example for `add-endpoint`:

```
evals/fixtures/add-endpoint/
├── src/
│   ├── server.ts        # Express-like server with existing routes
│   └── routes.ts        # Existing route definitions
├── package.json         # { "type": "module", dependencies: ... }
├── tsconfig.json
└── .diptych/
    └── config.yaml      # Planner/implementer config (overridden by harness)
```

Fixtures are **committed to the repo** — they are the "known starting state." The harness copies them to a tmpdir before each run so the original is never modified.

## 4. Runner modes

### Baseline mode

Both planner and implementer are the expensive model. This simulates "what if you just used Opus for everything."

```yaml
# Generated config for baseline
version: 3
planner:
  kind: api
  baseUrl: https://api.anthropic.com/v1
  model: claude-sonnet-4-6
  apiKey: ${ANTHROPIC_API_KEY}
implementer:
  kind: api
  baseUrl: https://api.anthropic.com/v1
  model: claude-sonnet-4-6
  apiKey: ${ANTHROPIC_API_KEY}
validation:
  typecheck: true
  lint: false
  test: true
  testCommand: "npm test"
workflow:
  maxRetries: 1
  mode: quick
```

### Routed mode

Planner is expensive, implementer is cheap. This is diptych's value prop.

```yaml
# Generated config for routed
version: 3
planner:
  kind: api
  baseUrl: https://api.anthropic.com/v1
  model: claude-sonnet-4-6
  apiKey: ${ANTHROPIC_API_KEY}
implementer:
  kind: api
  baseUrl: https://api.anthropic.com/v1
  model: claude-haiku-4-5-20251001
  apiKey: ${ANTHROPIC_API_KEY}
validation:
  typecheck: true
  lint: false
  test: true
  testCommand: "npm test"
workflow:
  maxRetries: 1
  mode: quick
```

### Config generation

The harness generates configs programmatically — it does NOT read fixture `.diptych/config.yaml`. This ensures consistent, reproducible comparisons.

```typescript
// evals/runner.ts (partial)

import type { Config } from '../src/core/schemas/config.js';

type EvalMode = 'baseline' | 'routed';

type ModelPair = {
  plannerModel: string;
  baselineImplementerModel: string;
  routedImplementerModel: string;
  baseUrl: string;
  apiKey: string;
};

function buildEvalConfig(pair: ModelPair, mode: EvalMode): Config {
  const implementerModel = mode === 'baseline'
    ? pair.baselineImplementerModel
    : pair.routedImplementerModel;

  return {
    version: 3,
    planner: {
      kind: 'api',
      baseUrl: pair.baseUrl,
      model: pair.plannerModel,
      apiKey: pair.apiKey,
    },
    implementer: {
      kind: 'api',
      baseUrl: pair.baseUrl,
      model: implementerModel,
      apiKey: pair.apiKey,
    },
    validation: {
      typecheck: true,
      lint: false,
      test: true,
      testCommand: 'npm test',
    },
    workflow: {
      maxRetries: 1,
      mode: 'quick',
      persistTranscript: true,
    },
  } as Config;
}
```

## 5. Metrics

### Metric types

```typescript
// evals/metrics.ts

import type { Summary, CostBreakdown } from '../src/core/schemas/summary.js';
import type { EngineEvent } from '../src/engine/events/types.js';

export type QualityScore = {
  totalChecks: number;
  passedChecks: number;
  failedChecks: string[];
  score: number;
};

export type CostMetrics = {
  plannerInputTokens: number;
  plannerOutputTokens: number;
  implementerInputTokens: number;
  implementerOutputTokens: number;
  escalationInputTokens: number;
  escalationOutputTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUSD: number;
  costBreakdown: CostBreakdown | null;
};

export type RunMetrics = {
  scenarioId: string;
  mode: 'baseline' | 'routed';
  durationMs: number;
  taskCount: number;
  completedTasks: number;
  failedTasks: number;
  escalatedTasks: number;
  skippedTasks: number;
  retryCount: number;
  quality: QualityScore;
  cost: CostMetrics;
  testsPassedAfterRun: boolean;
  events: EngineEvent[];
};

export type ScenarioComparison = {
  scenarioId: string;
  scenarioName: string;
  baseline: RunMetrics;
  routed: RunMetrics;
  costSavingsPercent: number;
  qualityRetentionPercent: number;
  baselineCostUSD: number;
  routedCostUSD: number;
  savingsUSD: number;
};

export type EvalReport = {
  timestamp: string;
  plannerModel: string;
  baselineImplementerModel: string;
  routedImplementerModel: string;
  scenarios: ScenarioComparison[];
  aggregate: {
    avgCostSavingsPercent: number;
    avgQualityRetentionPercent: number;
    totalBaselineCostUSD: number;
    totalRoutedCostUSD: number;
    totalSavingsUSD: number;
    scenariosRun: number;
    scenariosWhereRoutedMatchedBaseline: number;
  };
};
```

### Metric collection from Summary and events

```typescript
// evals/metrics.ts (continued)

import type { Summary } from '../src/core/schemas/summary.js';
import type { EngineEvent } from '../src/engine/events/types.js';
import type { QualityCheckResult } from './scenarios/types.js';

export function collectCostMetrics(summary: Summary): CostMetrics {
  const usage = summary.tokenUsage;
  return {
    plannerInputTokens: usage.plannerInput,
    plannerOutputTokens: usage.plannerOutput,
    implementerInputTokens: usage.implementerInput,
    implementerOutputTokens: usage.implementerOutput,
    escalationInputTokens: usage.escalationInput,
    escalationOutputTokens: usage.escalationOutput,
    totalInputTokens: usage.plannerInput + usage.implementerInput + usage.escalationInput,
    totalOutputTokens: usage.plannerOutput + usage.implementerOutput + usage.escalationOutput,
    estimatedCostUSD: summary.costBreakdown?.totalActualCost ?? 0,
    costBreakdown: summary.costBreakdown ?? null,
  };
}

export function collectQualityScore(results: QualityCheckResult[]): QualityScore {
  const passed = results.filter(r => r.passed);
  const failed = results.filter(r => !r.passed);
  return {
    totalChecks: results.length,
    passedChecks: passed.length,
    failedChecks: failed.map(r => r.detail),
    score: results.length > 0 ? passed.length / results.length : 0,
  };
}

export function collectRunMetrics(
  scenarioId: string,
  mode: 'baseline' | 'routed',
  summary: Summary,
  events: EngineEvent[],
  qualityResults: QualityCheckResult[],
  durationMs: number,
): RunMetrics {
  const retryEvents = events.filter(e => e.type === 'task_retry');
  return {
    scenarioId,
    mode,
    durationMs,
    taskCount: summary.totalTasks,
    completedTasks: summary.completedByLocal + summary.escalatedToPlanner,
    failedTasks: summary.failed,
    escalatedTasks: summary.escalatedToPlanner,
    skippedTasks: summary.skipped,
    retryCount: retryEvents.length,
    quality: collectQualityScore(qualityResults),
    cost: collectCostMetrics(summary),
    testsPassedAfterRun: qualityResults.every(r => r.passed),
    events,
  };
}

export function compareScenario(
  scenarioId: string,
  scenarioName: string,
  baseline: RunMetrics,
  routed: RunMetrics,
): ScenarioComparison {
  const baselineCost = baseline.cost.estimatedCostUSD;
  const routedCost = routed.cost.estimatedCostUSD;
  const savings = baselineCost - routedCost;
  const savingsPercent = baselineCost > 0 ? (savings / baselineCost) * 100 : 0;

  const baselineQuality = baseline.quality.score;
  const routedQuality = routed.quality.score;
  const qualityRetention = baselineQuality > 0 ? (routedQuality / baselineQuality) * 100 : 100;

  return {
    scenarioId,
    scenarioName,
    baseline,
    routed,
    costSavingsPercent: Math.round(savingsPercent * 10) / 10,
    qualityRetentionPercent: Math.round(qualityRetention * 10) / 10,
    baselineCostUSD: baselineCost,
    routedCostUSD: routedCost,
    savingsUSD: savings,
  };
}
```

### How metrics map to Summary fields

| Metric | Source | Field path |
|---|---|---|
| Planner tokens | `Summary.tokenUsage` | `plannerInput`, `plannerOutput` |
| Implementer tokens | `Summary.tokenUsage` | `implementerInput`, `implementerOutput` |
| Escalation tokens | `Summary.tokenUsage` | `escalationInput`, `escalationOutput` |
| Estimated cost | `Summary.costBreakdown` | `totalActualCost` |
| Hypothetical cost | `Summary.costBreakdown` | `hypotheticalCost` |
| Savings | `Summary.costBreakdown` | `savingsAmount`, `savingsPercentage` |
| Tasks completed | `Summary` | `completedByLocal`, `escalatedToPlanner` |
| Escalation rate | `Summary` | `escalationRate` |
| Task breakdown | `Summary.taskBreakdown` | Per-task token usage |
| Quality checks | `QualityCheck[]` (per scenario) | Custom post-run checks |

## 6. Recording/replay (cassette system)

The cassette system records HTTP request/response pairs during live API runs and replays them for deterministic reproduction. This is critical for CI, for comparing results over time, and for running evals without spending money.

### Cassette format

```typescript
// evals/cassette/types.ts

export type CassetteEntry = {
  index: number;
  timestamp: string;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body: string;
  };
  durationMs: number;
};

export type Cassette = {
  version: 1;
  scenarioId: string;
  mode: 'baseline' | 'routed';
  plannerModel: string;
  implementerModel: string;
  recordedAt: string;
  entries: CassetteEntry[];
};
```

### Recording adapter

The recorder intercepts HTTP requests at the `fetch` level. It wraps `globalThis.fetch` before the workflow runs and unwraps after.

```typescript
// evals/cassette/recorder.ts

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Cassette, CassetteEntry } from './types.js';

export type RecorderState = {
  entries: CassetteEntry[];
  originalFetch: typeof globalThis.fetch;
};

export function startRecording(): RecorderState {
  const entries: CassetteEntry[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'POST';
    const requestBody = typeof init?.body === 'string' ? init.body : '';
    const requestHeaders = Object.fromEntries(
      init?.headers instanceof Headers
        ? init.headers.entries()
        : Object.entries(init?.headers ?? {}),
    );

    const start = Date.now();
    const response = await originalFetch(input, init);
    const durationMs = Date.now() - start;

    const cloned = response.clone();
    const responseBody = await cloned.text();
    const responseHeaders = Object.fromEntries(cloned.headers.entries());

    entries.push({
      index: entries.length,
      timestamp: new Date().toISOString(),
      request: { method, url, headers: redactHeaders(requestHeaders), body: requestBody },
      response: { status: cloned.status, headers: responseHeaders, body: responseBody },
      durationMs,
    });

    return response;
  };

  return { entries, originalFetch };
}

export function stopRecording(state: RecorderState): CassetteEntry[] {
  globalThis.fetch = state.originalFetch;
  return state.entries;
}

export function saveCassette(cassette: Cassette, dir: string): string {
  const filename = `${cassette.scenarioId}-${cassette.mode}.json`;
  const path = join(dir, filename);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cassette, null, 2));
  return path;
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted = { ...headers };
  for (const key of Object.keys(redacted)) {
    if (key.toLowerCase() === 'authorization' || key.toLowerCase() === 'x-api-key') {
      redacted[key] = 'REDACTED';
    }
  }
  return redacted;
}
```

### Replay adapter

```typescript
// evals/cassette/replayer.ts

import { readFileSync } from 'node:fs';
import type { Cassette } from './types.js';

export type ReplayerState = {
  cassette: Cassette;
  cursor: number;
  originalFetch: typeof globalThis.fetch;
};

export function startReplay(cassettePath: string): ReplayerState {
  const raw = readFileSync(cassettePath, 'utf-8');
  const cassette: Cassette = JSON.parse(raw);
  const originalFetch = globalThis.fetch;
  const state: ReplayerState = { cassette, cursor: 0, originalFetch };

  globalThis.fetch = async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    if (state.cursor >= cassette.entries.length) {
      throw new Error(`Cassette exhausted at entry ${state.cursor} — recorded ${cassette.entries.length} entries`);
    }
    const entry = cassette.entries[state.cursor]!;
    state.cursor++;
    return new Response(entry.response.body, {
      status: entry.response.status,
      headers: entry.response.headers,
    });
  };

  return state;
}

export function stopReplay(state: ReplayerState): void {
  globalThis.fetch = state.originalFetch;
}
```

### Cassette file naming

```
evals/cassettes/<scenario-id>-<mode>.json
```

Example: `evals/cassettes/add-endpoint-baseline.json`, `evals/cassettes/add-endpoint-routed.json`.

### Cassette lifecycle

1. **First run** (no cassettes): `--record` flag. Live API calls. Cassettes saved.
2. **Subsequent runs** (cassettes exist): `--replay` flag. No API calls. Deterministic.
3. **Refresh**: `--record --force` overwrites existing cassettes.
4. **Default** (no flag): live API calls, no recording.

## 7. Output format

### JSON report

Written to `evals/results/eval-<timestamp>.json`:

```json
{
  "timestamp": "2026-04-30T14:23:00Z",
  "plannerModel": "claude-sonnet-4-6",
  "baselineImplementerModel": "claude-sonnet-4-6",
  "routedImplementerModel": "claude-haiku-4-5-20251001",
  "scenarios": [
    {
      "scenarioId": "add-endpoint",
      "scenarioName": "Add REST endpoint",
      "baseline": { "...": "RunMetrics" },
      "routed": { "...": "RunMetrics" },
      "costSavingsPercent": 72.3,
      "qualityRetentionPercent": 100.0,
      "baselineCostUSD": 0.0234,
      "routedCostUSD": 0.0065,
      "savingsUSD": 0.0169
    }
  ],
  "aggregate": {
    "avgCostSavingsPercent": 65.2,
    "avgQualityRetentionPercent": 96.0,
    "totalBaselineCostUSD": 0.1170,
    "totalRoutedCostUSD": 0.0407,
    "totalSavingsUSD": 0.0763,
    "scenariosRun": 5,
    "scenariosWhereRoutedMatchedBaseline": 4
  }
}
```

### Markdown report

Written to `evals/results/eval-<timestamp>.md`:

```markdown
# Eval Report — 2026-04-30T14:23:00Z

**Planner:** claude-sonnet-4-6 | **Baseline implementer:** claude-sonnet-4-6 | **Routed implementer:** claude-haiku-4-5-20251001

## Summary

| Metric | Value |
|---|---|
| Scenarios run | 5 |
| Avg cost savings | 65.2% |
| Avg quality retention | 96.0% |
| Total baseline cost | $0.1170 |
| Total routed cost | $0.0407 |
| Total savings | $0.0763 |

## Per-scenario results

| Scenario | Baseline cost | Routed cost | Savings | Quality (B) | Quality (R) | Retention |
|---|---|---|---|---|---|---|
| Add REST endpoint | $0.0234 | $0.0065 | 72.3% | 100% | 100% | 100% |
| Fix off-by-one | $0.0198 | $0.0072 | 63.6% | 100% | 100% | 100% |
| Add test coverage | $0.0287 | $0.0098 | 65.9% | 100% | 80% | 80.0% |
| Extract function | $0.0231 | $0.0087 | 62.3% | 100% | 100% | 100% |
| Add validation | $0.0220 | $0.0085 | 61.4% | 100% | 100% | 100% |
```

### Report generation code

```typescript
// evals/report.ts

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalReport, ScenarioComparison } from './metrics.js';

export function generateReport(report: EvalReport, outputDir: string): { jsonPath: string; mdPath: string } {
  mkdirSync(outputDir, { recursive: true });
  const ts = report.timestamp.replace(/[:.]/g, '-');
  const jsonPath = join(outputDir, `eval-${ts}.json`);
  const mdPath = join(outputDir, `eval-${ts}.md`);

  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, formatMarkdown(report));

  return { jsonPath, mdPath };
}

function formatMarkdown(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`# Eval Report — ${report.timestamp}`);
  lines.push('');
  lines.push(`**Planner:** ${report.plannerModel} | **Baseline implementer:** ${report.baselineImplementerModel} | **Routed implementer:** ${report.routedImplementerModel}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| Scenarios run | ${report.aggregate.scenariosRun} |`);
  lines.push(`| Avg cost savings | ${report.aggregate.avgCostSavingsPercent}% |`);
  lines.push(`| Avg quality retention | ${report.aggregate.avgQualityRetentionPercent}% |`);
  lines.push(`| Total baseline cost | $${report.aggregate.totalBaselineCostUSD.toFixed(4)} |`);
  lines.push(`| Total routed cost | $${report.aggregate.totalRoutedCostUSD.toFixed(4)} |`);
  lines.push(`| Total savings | $${report.aggregate.totalSavingsUSD.toFixed(4)} |`);
  lines.push(`| Scenarios matched quality | ${report.aggregate.scenariosWhereRoutedMatchedBaseline}/${report.aggregate.scenariosRun} |`);
  lines.push('');
  lines.push('## Per-scenario results');
  lines.push('');
  lines.push('| Scenario | Baseline $ | Routed $ | Savings | Quality (B) | Quality (R) | Retention |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const s of report.scenarios) {
    lines.push(formatScenarioRow(s));
  }
  lines.push('');
  return lines.join('\n');
}

function formatScenarioRow(s: ScenarioComparison): string {
  const bq = `${Math.round(s.baseline.quality.score * 100)}%`;
  const rq = `${Math.round(s.routed.quality.score * 100)}%`;
  return `| ${s.scenarioName} | $${s.baselineCostUSD.toFixed(4)} | $${s.routedCostUSD.toFixed(4)} | ${s.costSavingsPercent}% | ${bq} | ${rq} | ${s.qualityRetentionPercent}% |`;
}
```

## 8. Implementation plan

### Files to create

| # | File | Purpose | Dependencies |
|---|---|---|---|
| 1 | `evals/scenarios/types.ts` | `EvalScenario`, `QualityCheck` types | None |
| 2 | `evals/metrics.ts` | Metric types + collectors | `src/core/schemas/summary.ts`, `src/engine/events/types.ts` |
| 3 | `evals/cassette/types.ts` | Cassette format types | None |
| 4 | `evals/cassette/recorder.ts` | Fetch-intercept recorder | `evals/cassette/types.ts` |
| 5 | `evals/cassette/replayer.ts` | Fetch-intercept replayer | `evals/cassette/types.ts` |
| 6 | `evals/report.ts` | JSON + markdown report writer | `evals/metrics.ts` |
| 7 | `evals/runner.ts` | Main eval orchestrator | All of the above + `src/engine/orchestrator/run/run.ts` |
| 8 | `evals/cli.ts` | CLI entry point | `evals/runner.ts` |
| 9 | `evals/scenarios/add-endpoint.ts` | First scenario | `evals/scenarios/types.ts` |
| 10 | `evals/scenarios/fix-bug.ts` | Second scenario | `evals/scenarios/types.ts` |
| 11 | `evals/scenarios/add-test.ts` | Third scenario | `evals/scenarios/types.ts` |
| 12 | `evals/scenarios/refactor-extract.ts` | Fourth scenario | `evals/scenarios/types.ts` |
| 13 | `evals/scenarios/add-validation.ts` | Fifth scenario | `evals/scenarios/types.ts` |
| 14 | `evals/fixtures/add-endpoint/` | Fixture project | None |
| 15 | `evals/fixtures/fix-bug/` | Fixture project | None |
| 16 | `evals/fixtures/add-test/` | Fixture project | None |
| 17 | `evals/fixtures/refactor-extract/` | Fixture project | None |
| 18 | `evals/fixtures/add-validation/` | Fixture project | None |
| 19 | `evals/eval.test.ts` | Vitest test for the harness | `evals/metrics.ts`, `evals/report.ts` |

### Build order

1. **Types first** — `scenarios/types.ts`, `cassette/types.ts`, `metrics.ts`
2. **Cassette adapters** — `cassette/recorder.ts`, `cassette/replayer.ts`
3. **Report generator** — `report.ts`
4. **Runner** — `runner.ts` (ties everything together)
5. **CLI** — `cli.ts`
6. **Fixtures** — one at a time, starting with `add-endpoint`
7. **Scenarios** — one at a time, matching fixtures
8. **Test** — `eval.test.ts`

### Eval runner — main loop

```typescript
// evals/runner.ts

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { runWorkflow } from '../src/engine/orchestrator/run/run.js';
import { createEventBus } from '../src/engine/events/bus.js';
import type { EngineEvent } from '../src/engine/events/types.js';
import type { Config } from '../src/core/schemas/config.js';
import type { EvalScenario, QualityCheckResult } from './scenarios/types.js';
import { collectRunMetrics, compareScenario, type RunMetrics, type EvalReport } from './metrics.js';
import { generateReport } from './report.js';
import { startRecording, stopRecording, saveCassette } from './cassette/recorder.js';
import { startReplay, stopReplay } from './cassette/replayer.js';
import type { Cassette } from './cassette/types.js';

export type EvalRunOptions = {
  scenarios: EvalScenario[];
  plannerModel: string;
  baselineImplementerModel: string;
  routedImplementerModel: string;
  baseUrl: string;
  apiKey: string;
  cassetteDir: string;
  outputDir: string;
  record: boolean;
  replay: boolean;
};

async function runSingleEval(
  scenario: EvalScenario,
  config: Config,
  mode: 'baseline' | 'routed',
  opts: { record: boolean; replay: boolean; cassetteDir: string },
): Promise<RunMetrics> {
  const tmpDir = mkdtempSync(join(tmpdir(), `diptych-eval-${scenario.id}-${mode}-`));
  const projectDir = join(tmpDir, basename(scenario.fixtureDir));
  cpSync(scenario.fixtureDir, projectDir, { recursive: true });

  const events: EngineEvent[] = [];
  const bus = createEventBus();
  bus.subscribe(e => events.push(e));

  const cassetteFile = join(opts.cassetteDir, `${scenario.id}-${mode}.json`);
  let recorderState: ReturnType<typeof startRecording> | null = null;
  let replayerState: ReturnType<typeof startReplay> | null = null;

  if (opts.record) recorderState = startRecording();
  if (opts.replay) replayerState = startReplay(cassetteFile);

  const startMs = Date.now();

  const summary = await runWorkflow({
    feature: scenario.feature,
    projectDir,
    config,
    headless: true,
    eventBus: bus,
    sinks: { setAbortHandler: () => undefined, setQueueHandler: () => undefined },
    callbacks: {
      onApprovalNeeded: async () => ({ approved: true }),
      onExternalChanges: async () => true,
      onQuestionAsked: async () => '',
      onBudgetExceeded: async () => true,
      onBudgetPaused: async () => { /* no-op — eval doesn't pause */ },
      onContinuationNeeded: async () => '',
      onComplete: () => undefined,
    },
  });

  const durationMs = Date.now() - startMs;

  if (recorderState) {
    const entries = stopRecording(recorderState);
    const cassette: Cassette = {
      version: 1,
      scenarioId: scenario.id,
      mode,
      plannerModel: config.planner.kind === 'api' ? (config.planner.model ?? 'unknown') : 'unknown',
      implementerModel: config.implementer.kind === 'api' ? (config.implementer.model ?? 'unknown') : 'unknown',
      recordedAt: new Date().toISOString(),
      entries,
    };
    saveCassette(cassette, opts.cassetteDir);
  }
  if (replayerState) stopReplay(replayerState);

  const qualityResults: QualityCheckResult[] = [];
  for (const check of scenario.qualityChecks) {
    qualityResults.push(await check.check(projectDir));
  }

  const metrics = collectRunMetrics(scenario.id, mode, summary, events, qualityResults, durationMs);

  rmSync(tmpDir, { recursive: true, force: true });
  return metrics;
}

export async function runEvalSuite(opts: EvalRunOptions): Promise<EvalReport> {
  const comparisons = [];

  for (const scenario of opts.scenarios) {
    console.log(`\n━━━ ${scenario.name} ━━━`);

    console.log(`  baseline (${opts.baselineImplementerModel})...`);
    const baselineConfig = buildEvalConfig(
      { plannerModel: opts.plannerModel, baselineImplementerModel: opts.baselineImplementerModel, routedImplementerModel: opts.routedImplementerModel, baseUrl: opts.baseUrl, apiKey: opts.apiKey },
      'baseline',
    );
    const baseline = await runSingleEval(scenario, baselineConfig, 'baseline', opts);
    console.log(`    cost: $${baseline.cost.estimatedCostUSD.toFixed(4)} | quality: ${Math.round(baseline.quality.score * 100)}%`);

    console.log(`  routed (${opts.routedImplementerModel})...`);
    const routedConfig = buildEvalConfig(
      { plannerModel: opts.plannerModel, baselineImplementerModel: opts.baselineImplementerModel, routedImplementerModel: opts.routedImplementerModel, baseUrl: opts.baseUrl, apiKey: opts.apiKey },
      'routed',
    );
    const routed = await runSingleEval(scenario, routedConfig, 'routed', opts);
    console.log(`    cost: $${routed.cost.estimatedCostUSD.toFixed(4)} | quality: ${Math.round(routed.quality.score * 100)}%`);

    comparisons.push(compareScenario(scenario.id, scenario.name, baseline, routed));
  }

  const totalBaseline = comparisons.reduce((sum, c) => sum + c.baselineCostUSD, 0);
  const totalRouted = comparisons.reduce((sum, c) => sum + c.routedCostUSD, 0);
  const avgSavings = comparisons.length > 0
    ? comparisons.reduce((sum, c) => sum + c.costSavingsPercent, 0) / comparisons.length
    : 0;
  const avgQuality = comparisons.length > 0
    ? comparisons.reduce((sum, c) => sum + c.qualityRetentionPercent, 0) / comparisons.length
    : 0;
  const matched = comparisons.filter(c => c.qualityRetentionPercent >= 100).length;

  const report: EvalReport = {
    timestamp: new Date().toISOString(),
    plannerModel: opts.plannerModel,
    baselineImplementerModel: opts.baselineImplementerModel,
    routedImplementerModel: opts.routedImplementerModel,
    scenarios: comparisons,
    aggregate: {
      avgCostSavingsPercent: Math.round(avgSavings * 10) / 10,
      avgQualityRetentionPercent: Math.round(avgQuality * 10) / 10,
      totalBaselineCostUSD: totalBaseline,
      totalRoutedCostUSD: totalRouted,
      totalSavingsUSD: totalBaseline - totalRouted,
      scenariosRun: comparisons.length,
      scenariosWhereRoutedMatchedBaseline: matched,
    },
  };

  const { jsonPath, mdPath } = generateReport(report, opts.outputDir);
  console.log(`\n✓ Report written to ${jsonPath}`);
  console.log(`✓ Markdown written to ${mdPath}`);

  return report;
}

type ModelPair = {
  plannerModel: string;
  baselineImplementerModel: string;
  routedImplementerModel: string;
  baseUrl: string;
  apiKey: string;
};

function buildEvalConfig(pair: ModelPair, mode: 'baseline' | 'routed'): Config {
  const implementerModel = mode === 'baseline'
    ? pair.baselineImplementerModel
    : pair.routedImplementerModel;

  return {
    version: 3,
    planner: {
      kind: 'api' as const,
      baseUrl: pair.baseUrl,
      model: pair.plannerModel,
      apiKey: pair.apiKey,
    },
    implementer: {
      kind: 'api' as const,
      baseUrl: pair.baseUrl,
      model: implementerModel,
      apiKey: pair.apiKey,
    },
    validation: {
      typecheck: true,
      lint: false,
      test: true,
      testCommand: 'npm test',
    },
    workflow: {
      maxRetries: 1,
      mode: 'quick' as const,
      persistTranscript: true,
    },
  } as Config;
}
```

### CLI entry point

```typescript
// evals/cli.ts

import { resolve } from 'node:path';
import { runEvalSuite } from './runner.js';
import { addEndpointScenario } from './scenarios/add-endpoint.js';
import { fixBugScenario } from './scenarios/fix-bug.js';
import { addTestScenario } from './scenarios/add-test.js';
import { refactorExtractScenario } from './scenarios/refactor-extract.js';
import { addValidationScenario } from './scenarios/add-validation.js';

const ALL_SCENARIOS = [
  addEndpointScenario,
  fixBugScenario,
  addTestScenario,
  refactorExtractScenario,
  addValidationScenario,
];

async function main() {
  const args = process.argv.slice(2);

  const plannerModel = getArg(args, '--planner-model') ?? 'claude-sonnet-4-6';
  const baselineModel = getArg(args, '--baseline-model') ?? plannerModel;
  const routedModel = getArg(args, '--routed-model') ?? 'claude-haiku-4-5-20251001';
  const baseUrl = getArg(args, '--base-url') ?? 'https://api.anthropic.com/v1';
  const apiKey = getArg(args, '--api-key') ?? process.env['ANTHROPIC_API_KEY'] ?? '';
  const scenarioFilter = getArg(args, '--scenario');
  const record = args.includes('--record');
  const replay = args.includes('--replay');

  if (!apiKey && !replay) {
    console.error('Error: --api-key or ANTHROPIC_API_KEY required (unless --replay)');
    process.exit(1);
  }

  const scenarios = scenarioFilter
    ? ALL_SCENARIOS.filter(s => s.id === scenarioFilter)
    : ALL_SCENARIOS;

  if (scenarios.length === 0) {
    console.error(`No matching scenario: ${scenarioFilter}`);
    console.error(`Available: ${ALL_SCENARIOS.map(s => s.id).join(', ')}`);
    process.exit(1);
  }

  console.log(`Eval: ${scenarios.length} scenarios | planner=${plannerModel} | baseline=${baselineModel} | routed=${routedModel}`);
  if (record) console.log('Recording cassettes...');
  if (replay) console.log('Replaying from cassettes...');

  const report = await runEvalSuite({
    scenarios,
    plannerModel,
    baselineImplementerModel: baselineModel,
    routedImplementerModel: routedModel,
    baseUrl,
    apiKey,
    cassetteDir: resolve(import.meta.dirname, 'cassettes'),
    outputDir: resolve(import.meta.dirname, 'results'),
    record,
    replay,
  });

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`Avg cost savings: ${report.aggregate.avgCostSavingsPercent}%`);
  console.log(`Avg quality retention: ${report.aggregate.avgQualityRetentionPercent}%`);
  console.log(`Total savings: $${report.aggregate.totalSavingsUSD.toFixed(4)}`);
  console.log(`${'═'.repeat(60)}`);
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx === args.length - 1) return undefined;
  return args[idx + 1];
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

### Running the eval

```bash
# Live run (costs real money)
npx tsx evals/cli.ts --api-key sk-ant-... --scenario add-endpoint

# Record cassettes for all scenarios
npx tsx evals/cli.ts --api-key sk-ant-... --record

# Replay from cassettes (free, deterministic)
npx tsx evals/cli.ts --replay

# Custom model pair
npx tsx evals/cli.ts --planner-model claude-sonnet-4-6 --routed-model claude-haiku-4-5-20251001

# Add to package.json
"scripts": {
  "eval": "tsx evals/cli.ts",
  "eval:record": "tsx evals/cli.ts --record",
  "eval:replay": "tsx evals/cli.ts --replay"
}
```

### Example scenario implementation

```typescript
// evals/scenarios/add-endpoint.ts

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import type { EvalScenario, QualityCheck, QualityCheckResult } from './types.js';

function fileExists(dir: string, path: string): QualityCheckResult {
  const full = join(dir, path);
  return existsSync(full)
    ? { passed: true, detail: `${path} exists` }
    : { passed: false, detail: `${path} not found` };
}

function fileContains(dir: string, path: string, substring: string): QualityCheckResult {
  const full = join(dir, path);
  if (!existsSync(full)) return { passed: false, detail: `${path} not found` };
  const content = readFileSync(full, 'utf-8');
  return content.includes(substring)
    ? { passed: true, detail: `${path} contains "${substring}"` }
    : { passed: false, detail: `${path} does not contain "${substring}"` };
}

function testsPass(dir: string): QualityCheckResult {
  try {
    execSync('npm test', { cwd: dir, stdio: 'pipe', timeout: 30_000 });
    return { passed: true, detail: 'npm test passed' };
  } catch {
    return { passed: false, detail: 'npm test failed' };
  }
}

const qualityChecks: QualityCheck[] = [
  {
    name: 'health endpoint file exists',
    check: async (dir) => {
      const candidates = ['src/routes/health.ts', 'src/health.ts', 'src/api/health.ts'];
      for (const path of candidates) {
        if (existsSync(join(dir, path))) return { passed: true, detail: `Found ${path}` };
      }
      return { passed: false, detail: 'No health endpoint file found' };
    },
  },
  {
    name: 'health endpoint returns status ok',
    check: async (dir) => {
      const candidates = ['src/routes/health.ts', 'src/health.ts', 'src/api/health.ts'];
      for (const path of candidates) {
        const result = fileContains(dir, path, 'status');
        if (result.passed) return result;
      }
      return { passed: false, detail: 'No file contains "status"' };
    },
  },
  {
    name: 'health endpoint returns uptime',
    check: async (dir) => {
      const candidates = ['src/routes/health.ts', 'src/health.ts', 'src/api/health.ts'];
      for (const path of candidates) {
        const result = fileContains(dir, path, 'uptime');
        if (result.passed) return result;
      }
      return { passed: false, detail: 'No file contains "uptime"' };
    },
  },
  {
    name: 'tests pass after implementation',
    check: async (dir) => testsPass(dir),
  },
];

export const addEndpointScenario: EvalScenario = {
  id: 'add-endpoint',
  name: 'Add REST endpoint',
  feature: 'Add a GET /api/health endpoint that returns { status: "ok", uptime: process.uptime() }',
  fixtureDir: resolve(import.meta.dirname, '../fixtures/add-endpoint'),
  mode: 'quick',
  qualityChecks,
};
```

## 9. Acceptance criteria

### Must-have (v1 release)

- [ ] `npx tsx evals/cli.ts --replay` runs deterministically from recorded cassettes and produces a report
- [ ] `npx tsx evals/cli.ts --record --scenario add-endpoint` runs a single scenario live and saves cassettes
- [ ] Report shows per-scenario cost savings % and quality retention %
- [ ] Report shows aggregate numbers across all scenarios
- [ ] At least 3 of 5 scenarios implemented with fixture projects and quality checks
- [ ] `eval.test.ts` tests the harness itself using fake data (no API calls, no cassettes)
- [ ] Cassette recorder redacts API keys from saved headers
- [ ] Cassette replayer throws a clear error when cassette is exhausted
- [ ] Harness copies fixture to tmpdir — never modifies original fixtures
- [ ] `npm run eval:replay` script added to package.json

### Should-have (v1.1)

- [ ] All 5 scenarios implemented
- [ ] Cassette format versioned (currently `version: 1`)
- [ ] `--scenario` filter supports comma-separated list
- [ ] Report includes per-task token breakdown
- [ ] Markdown report includes cache hit/miss statistics

### Won't-have (explicit scope boundaries)

- Parallel scenario execution (serial is fine for v1)
- CI integration (manual runs are fine for now)
- Historical trend tracking (single-run reports are fine)
- Custom model pairs per scenario (uniform pair across all scenarios is fine)
- Visual/HTML report (markdown + JSON is sufficient)

## 10. Conventions

- **Zero classes** — all modules export pure functions
- **ESM with `.js` extension** in every import
- **kebab-case** file names
- **No barrels** — no `index.ts` in `evals/`
- **No decorative comments** — code is self-documenting
- **Colocated test** — `evals/eval.test.ts` lives next to the code it tests
- **DO NOT** run `git add`, `git commit`, or `git stage` — leave all changes as unstaged modifications

## 11. Non-goals

- This harness does NOT test diptych's TUI, Ink rendering, or interactive features
- This harness does NOT replace existing unit/integration tests — it complements them
- This harness does NOT test the MCP server, IPC, or detach features
- This harness does NOT measure response latency as a quality signal (only cost and correctness)
- This harness is NOT meant to run in CI on every commit — it's for periodic benchmarking
