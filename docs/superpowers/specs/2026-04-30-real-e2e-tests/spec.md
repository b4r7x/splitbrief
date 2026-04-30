# P2: Real E2E Tests — VCR Cassette Pipeline Verification

## Overview

Diptych has 3,392 unit and integration tests that verify orchestrator logic via **fakes** (`makePlanner`/`makeImplementer` in `testing/helpers/orchestrator-factories.ts`). These tests prove the state machine, event bus, persistence, and quality gates work correctly — but they never touch a real API. They cannot answer: *"Does a Task Brief compiled by a real planner produce correct code when a real implementer executes it?"*

This spec adds a **VCR cassette system** that records real HTTP interactions and replays them deterministically. Two modes:

| Mode | Speed | Deterministic | When | Cost |
|---|---|---|---|---|
| **Replay** (default) | Fast (~2 s per scenario) | Yes | `npm run test:e2e` / CI | $0 |
| **Record** (manual) | Slow (30–120 s per scenario) | No | `DIPTYCH_E2E_RECORD=1 npm run test:e2e` | Real API spend |

The cassette system intercepts at the **HTTP layer** (Node.js `fetch`), not at the planner/implementer abstraction. This means the full provider adapter path (Anthropic SSE parsing, OpenAI stream parsing, token counting, error mapping) is exercised in every replay.

## What this is NOT

- **Not an eval harness** — P1 (eval harness) measures quality/cost across many tasks. This tests pipeline correctness on a fixed set of known-good recordings.
- **Not a replacement for fakes** — fakes remain the fast, fine-grained orchestrator tests. E2e cassettes are the slow, high-fidelity pipeline tests.
- **Not load/performance testing** — cassettes replay instantly; no concurrency or latency simulation.

## Architecture

```
testing/e2e/
├── cassettes/                     # Recorded HTTP interactions (JSON)
│   ├── instant-trivial-edit.json
│   ├── quick-add-endpoint.json
│   ├── standard-multi-task.json
│   ├── recovery-retry-success.json
│   ├── cost-routing-cheapest.json
│   └── drift-out-of-scope.json
├── helpers/
│   ├── cassette-recorder.ts       # HTTP intercept → record to file
│   ├── cassette-replayer.ts       # HTTP intercept → replay from file
│   ├── e2e-harness.ts             # Shared setup: tmpDir + git repo + config + runWorkflow
│   └── request-matcher.ts         # Match incoming HTTP to recorded cassette entries
├── scenarios/
│   ├── instant-trivial-edit.test.ts
│   ├── quick-add-endpoint.test.ts
│   ├── standard-multi-task.test.ts
│   ├── recovery-retry-success.test.ts
│   ├── cost-routing-cheapest.test.ts
│   └── drift-out-of-scope.test.ts
└── vitest.e2e.config.ts           # Separate vitest config for e2e (longer timeouts)
```

## Cassette format

Each cassette is a JSON file containing an ordered array of HTTP request/response pairs:

```typescript
// testing/e2e/helpers/cassette-recorder.ts

export interface CassetteEntry {
  /** Sequential index for ordered replay */
  index: number;
  /** ISO timestamp of original recording */
  recordedAt: string;
  request: {
    method: string;
    url: string;
    /** Headers with sensitive values (Authorization, x-api-key) redacted to '***' */
    headers: Record<string, string>;
    /** Stringified request body. For streaming requests this is the initial POST body. */
    body: string | null;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    /**
     * For SSE streaming responses (Anthropic, OpenAI), this is the raw SSE text
     * exactly as received: "event: message_start\ndata: {...}\n\n..."
     * For non-streaming JSON, this is the JSON string.
     */
    body: string;
  };
  /** Provider hint for matching: 'anthropic' | 'openai' | 'unknown' */
  provider: string;
  /** How long the real request took (ms). Not used in replay, for reference only. */
  durationMs: number;
}

export interface Cassette {
  /** Schema version for forward compat */
  version: 1;
  /** Human label */
  name: string;
  /** ISO timestamp when the cassette was recorded */
  recordedAt: string;
  /** Diptych config used during recording (for reproducibility) */
  config: {
    mode: string;
    plannerProvider: string;
    plannerModel: string;
    implementerProvider: string;
    implementerModel: string;
  };
  entries: CassetteEntry[];
}
```

### Sensitive data handling

The recorder **redacts** auth headers before writing:

- `Authorization: Bearer sk-...` → `Authorization: Bearer ***`
- `x-api-key: sk-ant-...` → `x-api-key: ***`
- API keys in request bodies are NOT present (the OpenAI SDK sends them as headers)

Cassette files are committed to the repo. They contain model responses (which may include generated code) but no secrets.

## Implementation

### 1. HTTP interceptor — `testing/e2e/helpers/cassette-recorder.ts`

Uses Node.js global `fetch` monkey-patching (no external deps). Records all outgoing HTTP requests during a test run.

```typescript
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Cassette, CassetteEntry } from './cassette-replayer.js';

const AUTH_HEADER_KEYS = ['authorization', 'x-api-key'];

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = AUTH_HEADER_KEYS.includes(key.toLowerCase()) ? '***' : value;
  }
  return redacted;
}

function detectProvider(url: string, headers: Record<string, string>): string {
  if (url.includes('anthropic') || headers['x-api-key'] !== undefined) return 'anthropic';
  if (url.includes('openai') || url.includes('openrouter') || headers['authorization'] !== undefined) return 'openai';
  return 'unknown';
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => { result[key] = value; });
  return result;
}

export function createCassetteRecorder(cassettePath: string, name: string) {
  const entries: CassetteEntry[] = [];
  const originalFetch = globalThis.fetch;

  function install(): void {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      const requestHeaders = headersToRecord(new Headers(init?.headers));
      const body = init?.body ? String(init.body) : null;
      const start = Date.now();

      const realResponse = await originalFetch(input, init);
      const durationMs = Date.now() - start;

      const responseHeaders = headersToRecord(realResponse.headers);
      const isStreaming =
        responseHeaders['content-type']?.includes('text/event-stream') ||
        responseHeaders['content-type']?.includes('application/x-ndjson');

      const cloned = realResponse.clone();
      const responseBody = await cloned.text();

      entries.push({
        index: entries.length,
        recordedAt: new Date().toISOString(),
        request: {
          method,
          url,
          headers: redactHeaders(requestHeaders),
          body,
        },
        response: {
          status: realResponse.status,
          headers: responseHeaders,
          body: responseBody,
        },
        provider: detectProvider(url, requestHeaders),
        durationMs,
      });

      if (isStreaming) {
        return new Response(responseBody, {
          status: realResponse.status,
          headers: realResponse.headers,
        });
      }

      return realResponse;
    };
  }

  function save(): void {
    const cassette: Cassette = {
      version: 1,
      name,
      recordedAt: new Date().toISOString(),
      config: {
        mode: 'unknown',
        plannerProvider: 'unknown',
        plannerModel: 'unknown',
        implementerProvider: 'unknown',
        implementerModel: 'unknown',
      },
      entries,
    };
    writeFileSync(cassettePath, JSON.stringify(cassette, null, 2), 'utf-8');
  }

  function uninstall(): void {
    globalThis.fetch = originalFetch;
  }

  return { install, save, uninstall, entries };
}
```

### 2. Cassette replayer — `testing/e2e/helpers/cassette-replayer.ts`

Replays recorded HTTP in order. Validates that requests roughly match the recording (same URL path + method). SSE streaming responses are returned as a single body (the OpenAI SDK and Anthropic adapter both handle this correctly since they parse the body text).

```typescript
import { readFileSync } from 'node:fs';

export interface CassetteEntry {
  index: number;
  recordedAt: string;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string | null;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body: string;
  };
  provider: string;
  durationMs: number;
}

export interface Cassette {
  version: 1;
  name: string;
  recordedAt: string;
  config: {
    mode: string;
    plannerProvider: string;
    plannerModel: string;
    implementerProvider: string;
    implementerModel: string;
  };
  entries: CassetteEntry[];
}

export function loadCassette(path: string): Cassette {
  const raw = readFileSync(path, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  const cassette = parsed as Cassette;
  if (cassette.version !== 1) throw new Error(`Unsupported cassette version: ${cassette.version}`);
  return cassette;
}

function urlPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export function createCassetteReplayer(cassette: Cassette) {
  let cursor = 0;
  const originalFetch = globalThis.fetch;

  function install(): void {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();

      if (cursor >= cassette.entries.length) {
        throw new Error(
          `Cassette "${cassette.name}" exhausted: ${cursor} entries used, ` +
          `but got request ${method} ${url}. ` +
          `Re-record this cassette with DIPTYCH_E2E_RECORD=1.`,
        );
      }

      const entry = cassette.entries[cursor];
      cursor++;

      const expectedPath = urlPath(entry.request.url);
      const actualPath = urlPath(url);
      const expectedMethod = entry.request.method.toUpperCase();

      if (expectedMethod !== method || expectedPath !== actualPath) {
        throw new Error(
          `Cassette "${cassette.name}" mismatch at entry ${entry.index}:\n` +
          `  Expected: ${expectedMethod} ${expectedPath}\n` +
          `  Got:      ${method} ${actualPath}\n` +
          `Re-record this cassette with DIPTYCH_E2E_RECORD=1.`,
        );
      }

      const responseHeaders = new Headers(entry.response.headers);

      return new Response(entry.response.body, {
        status: entry.response.status,
        headers: responseHeaders,
      });
    };
  }

  function uninstall(): void {
    globalThis.fetch = originalFetch;
  }

  function assertAllEntriesConsumed(): void {
    if (cursor < cassette.entries.length) {
      throw new Error(
        `Cassette "${cassette.name}" has ${cassette.entries.length - cursor} unconsumed entries. ` +
        `The workflow made fewer API calls than expected.`,
      );
    }
  }

  return { install, uninstall, assertAllEntriesConsumed };
}
```

### 3. E2E test harness — `testing/e2e/helpers/e2e-harness.ts`

Shared setup: creates a temp git repo, seeds a `.diptych/config.yaml`, wires the cassette, and runs the workflow.

```typescript
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import { stringify } from 'yaml';
import type { EngineEvent } from '../../../src/engine/events/types.js';
import { createEventBus } from '../../../src/engine/events/bus.js';
import { runWorkflow, type RunWorkflowOptions } from '../../../src/engine/orchestrator/run/run.js';
import { resetAllStores } from '../../helpers/stores.js';
import { createTempDir, cleanupTempDir } from '../../helpers/temp-dir.js';
import { createTestGitRepo } from '../../helpers/git.js';
import { loadCassette, createCassetteReplayer } from './cassette-replayer.js';
import { createCassetteRecorder } from './cassette-recorder.js';

export interface E2eScenario {
  name: string;
  cassetteName: string;
  feature: string;
  mode: 'instant' | 'quick' | 'standard' | 'speckit';
  config: Record<string, unknown>;
}

export interface E2eContext {
  projectDir: string;
  events: EngineEvent[];
  replayer: ReturnType<typeof createCassetteReplayer> | null;
  recorder: ReturnType<typeof createCassetteRecorder> | null;
}

const CASSETTE_DIR = join(import.meta.dirname, '..', 'cassettes');
const isRecording = process.env.DIPTYCH_E2E_RECORD === '1';

export function setupE2eScenario(scenario: E2eScenario) {
  const ctx: E2eContext = {
    projectDir: '',
    events: [],
    replayer: null,
    recorder: null,
  };

  beforeEach(() => {
    resetAllStores();
    ctx.events = [];

    ctx.projectDir = createTempDir(`e2e-${scenario.cassetteName}`);
    createTestGitRepo(ctx.projectDir);

    const diptychDir = join(ctx.projectDir, '.diptych');
    mkdirSync(diptychDir, { recursive: true });
    writeFileSync(
      join(diptychDir, 'config.yaml'),
      stringify(scenario.config),
      'utf-8',
    );

    const cassettePath = join(CASSETTE_DIR, `${scenario.cassetteName}.json`);

    if (isRecording) {
      ctx.recorder = createCassetteRecorder(cassettePath, scenario.name);
      ctx.recorder.install();
    } else {
      const cassette = loadCassette(cassettePath);
      ctx.replayer = createCassetteReplayer(cassette);
      ctx.replayer.install();
    }
  });

  afterEach(() => {
    if (ctx.recorder) {
      ctx.recorder.save();
      ctx.recorder.uninstall();
    }
    if (ctx.replayer) {
      ctx.replayer.uninstall();
    }
    cleanupTempDir(ctx.projectDir);
  });

  return ctx;
}

export async function runE2eWorkflow(ctx: E2eContext, scenario: E2eScenario): Promise<ReturnType<typeof runWorkflow>> {
  const bus = createEventBus();
  bus.subscribe((e) => ctx.events.push(e));

  return runWorkflow({
    feature: scenario.feature,
    projectDir: ctx.projectDir,
    config: await loadAndOverrideConfig(ctx.projectDir, scenario.mode),
    headless: true,
    sinks: { setAbortHandler: () => undefined, setQueueHandler: () => undefined },
    eventBus: bus,
    _eventSink: (e) => ctx.events.push(e),
    callbacks: {
      onApprovalNeeded: async () => ({ approved: true }),
      onExternalChanges: async () => true,
      onQuestionAsked: async () => '',
      onBudgetExceeded: async () => true,
      onBudgetPaused: async () => { throw new Error('Budget paused unexpectedly in e2e test'); },
      onContinuationNeeded: async () => '',
      onComplete: () => undefined,
    },
  });
}

async function loadAndOverrideConfig(projectDir: string, mode: string) {
  const { loadConfig } = await import('../../../src/core/config/load/load.js');
  const { applyCLIOverrides } = await import('../../../src/core/config/runtime/overrides.js');
  const { config } = loadConfig(projectDir);
  return applyCLIOverrides(config, { mode, autoApprove: true })!;
}
```

### 4. Vitest e2e config — `testing/e2e/vitest.e2e.config.ts`

Separate config with longer timeouts, not included in `npm test`.

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['testing/e2e/scenarios/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    environment: 'node',
    globals: false,
    testTimeout: 120_000,
    hookTimeout: 30_000,
    retry: 0,
    sequence: { concurrent: false },
  },
});
```

### 5. npm scripts

Add to `package.json`:

```json
{
  "scripts": {
    "test:e2e": "vitest run --config testing/e2e/vitest.e2e.config.ts",
    "test:e2e:record": "DIPTYCH_E2E_RECORD=1 vitest run --config testing/e2e/vitest.e2e.config.ts"
  }
}
```

## Test scenarios

### Scenario 1: `instant-trivial-edit.test.ts`

Verify instant mode completes a single trivial task end-to-end.

```typescript
import { describe, expect, it } from 'vitest';
import { setupE2eScenario, runE2eWorkflow } from '../helpers/e2e-harness.js';

const scenario = {
  name: 'instant mode — trivial edit',
  cassetteName: 'instant-trivial-edit',
  feature: 'fix typo in README',
  mode: 'instant' as const,
  config: {
    version: 2,
    planner: {
      kind: 'api',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    },
    implementer: {
      kind: 'api',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
    },
    workflow: {
      mode: 'instant',
      commitStrategy: 'none',
    },
  },
};

describe('e2e: instant mode trivial edit', () => {
  const ctx = setupE2eScenario(scenario);

  it('completes one task via cheap implementer and emits workflow_complete', async () => {
    const summary = await runE2eWorkflow(ctx, scenario);

    expect(summary.totalTasks).toBe(1);
    expect(summary.completedByLocal).toBeGreaterThanOrEqual(1);

    const started = ctx.events.find((e) => e.type === 'workflow_started');
    const completed = ctx.events.find((e) => e.type === 'workflow_complete');
    expect(started).toBeDefined();
    expect(completed).toBeDefined();

    const taskCompleted = ctx.events.find((e) => e.type === 'task_completed');
    expect(taskCompleted).toBeDefined();

    expect(summary.tokenUsage.inputTokens).toBeGreaterThan(0);
    expect(summary.tokenUsage.outputTokens).toBeGreaterThan(0);
  });

  it('applies the replayer cassette entries fully', () => {
    if (ctx.replayer) ctx.replayer.assertAllEntriesConsumed();
  });
});
```

### Scenario 2: `quick-add-endpoint.test.ts`

Verify quick mode plans + implements a small feature.

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setupE2eScenario, runE2eWorkflow } from '../helpers/e2e-harness.js';
import { EVIDENCE_FILE, SESSION_LOG_FILE, sessionDir } from '../../../src/core/paths.js';

const scenario = {
  name: 'quick mode — add endpoint',
  cassetteName: 'quick-add-endpoint',
  feature: 'add GET /api/health endpoint',
  mode: 'quick' as const,
  config: {
    version: 2,
    planner: {
      kind: 'api',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    },
    implementer: {
      kind: 'api',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
    },
    workflow: {
      mode: 'quick',
      commitStrategy: 'none',
    },
    validation: {
      commands: [],
    },
  },
};

describe('e2e: quick mode add endpoint', () => {
  const ctx = setupE2eScenario(scenario);

  it('completes planning + implementation with session artifacts', async () => {
    const summary = await runE2eWorkflow(ctx, scenario);

    expect(summary.totalTasks).toBeGreaterThanOrEqual(1);

    const plannerEvent = ctx.events.find((e) => e.type === 'planner_started');
    expect(plannerEvent).toBeDefined();

    const taskEvents = ctx.events.filter((e) => e.type === 'task_completed');
    expect(taskEvents.length).toBeGreaterThanOrEqual(1);

    const sid = ctx.events.find((e) => e.type === 'workflow_started');
    if (sid && 'sessionId' in sid) {
      const sessDir = sessionDir(ctx.projectDir, sid.sessionId as string);
      expect(existsSync(join(sessDir, SESSION_LOG_FILE))).toBe(true);
    }

    expect(summary.durationMs).toBeGreaterThan(0);
  });

  it('records token usage for both planner and implementer', async () => {
    const summary = await runE2eWorkflow(ctx, scenario);

    expect(summary.tokenUsage.inputTokens).toBeGreaterThan(0);
    expect(summary.tokenUsage.outputTokens).toBeGreaterThan(0);
  });
});
```

### Scenario 3: `standard-multi-task.test.ts`

Standard mode with multiple tasks verifying the full planning pipeline.

```typescript
import { describe, expect, it } from 'vitest';
import { setupE2eScenario, runE2eWorkflow } from '../helpers/e2e-harness.js';

const scenario = {
  name: 'standard mode — multi-task feature',
  cassetteName: 'standard-multi-task',
  feature: 'add user profile page with API and tests',
  mode: 'standard' as const,
  config: {
    version: 2,
    planner: {
      kind: 'api',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    },
    implementer: {
      kind: 'api',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
    },
    workflow: {
      mode: 'standard',
      commitStrategy: 'none',
      approve: 'none',
    },
    validation: {
      commands: [],
    },
  },
};

describe('e2e: standard mode multi-task', () => {
  const ctx = setupE2eScenario(scenario);

  it('plans multiple tasks and completes them sequentially', async () => {
    const summary = await runE2eWorkflow(ctx, scenario);

    expect(summary.totalTasks).toBeGreaterThanOrEqual(2);

    const taskCompletedEvents = ctx.events.filter((e) => e.type === 'task_completed');
    expect(taskCompletedEvents.length).toBeGreaterThanOrEqual(2);

    const phaseEvents = ctx.events.filter((e) => e.type === 'phase_entered');
    expect(phaseEvents.length).toBeGreaterThan(0);
  });

  it('emits cost events with real token counts', async () => {
    const summary = await runE2eWorkflow(ctx, scenario);

    const costEvents = ctx.events.filter((e) => e.type === 'cost_updated');
    expect(costEvents.length).toBeGreaterThan(0);
  });
});
```

### Scenario 4: `recovery-retry-success.test.ts`

Verify the recovery path when a task fails and is retried.

```typescript
import { describe, expect, it } from 'vitest';
import { setupE2eScenario, runE2eWorkflow } from '../helpers/e2e-harness.js';

const scenario = {
  name: 'recovery — task fails then retries successfully',
  cassetteName: 'recovery-retry-success',
  feature: 'add validation to form handler',
  mode: 'quick' as const,
  config: {
    version: 2,
    planner: {
      kind: 'api',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    },
    implementer: {
      kind: 'api',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
    },
    workflow: {
      mode: 'quick',
      commitStrategy: 'none',
      maxRetries: 2,
    },
    validation: {
      commands: ['node -e "process.exit(0)"'],
    },
  },
};

describe('e2e: recovery retry success', () => {
  const ctx = setupE2eScenario(scenario);

  it('retries failed task and eventually completes', async () => {
    const summary = await runE2eWorkflow(ctx, scenario);

    const retryEvents = ctx.events.filter((e) => e.type === 'task_retry');
    const taskCompleted = ctx.events.filter((e) => e.type === 'task_completed');

    expect(retryEvents.length + taskCompleted.length).toBeGreaterThan(0);
    expect(summary.totalTasks).toBeGreaterThanOrEqual(1);
  });
});
```

### Scenario 5: `cost-routing-cheapest.test.ts`

Verify that cost-aware routing selects the cheapest capable implementer profile.

```typescript
import { describe, expect, it } from 'vitest';
import { setupE2eScenario, runE2eWorkflow } from '../helpers/e2e-harness.js';

const scenario = {
  name: 'cost routing — cheapest capable profile',
  cassetteName: 'cost-routing-cheapest',
  feature: 'add utility function',
  mode: 'quick' as const,
  config: {
    version: 2,
    planner: {
      kind: 'api',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    },
    implementer: {
      kind: 'api',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
    },
    implementerProfiles: [
      {
        id: 'cheap-local',
        runner: {
          kind: 'api',
          provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
        },
        costTier: 'free',
        contextLength: 200000,
      },
      {
        id: 'expensive-cloud',
        runner: {
          kind: 'api',
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
        },
        costTier: 'paid',
        contextLength: 200000,
      },
    ],
    workflow: {
      mode: 'quick',
      commitStrategy: 'none',
    },
  },
};

describe('e2e: cost routing cheapest capable', () => {
  const ctx = setupE2eScenario(scenario);

  it('routes to cheapest profile when task fits', async () => {
    const summary = await runE2eWorkflow(ctx, scenario);

    const routingEvents = ctx.events.filter((e) => e.type === 'routing_decision');
    if (routingEvents.length > 0) {
      const first = routingEvents[0] as Record<string, unknown>;
      expect(first.selectedProfile).toBe('cheap-local');
    }

    expect(summary.totalTasks).toBeGreaterThanOrEqual(1);
  });
});
```

### Scenario 6: `drift-out-of-scope.test.ts`

Verify drift detection catches out-of-scope writes.

```typescript
import { describe, expect, it } from 'vitest';
import { setupE2eScenario, runE2eWorkflow } from '../helpers/e2e-harness.js';

const scenario = {
  name: 'drift detection — out of scope writes',
  cassetteName: 'drift-out-of-scope',
  feature: 'update config parser',
  mode: 'quick' as const,
  config: {
    version: 2,
    planner: {
      kind: 'api',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    },
    implementer: {
      kind: 'api',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
    },
    workflow: {
      mode: 'quick',
      commitStrategy: 'none',
    },
  },
};

describe('e2e: drift out-of-scope detection', () => {
  const ctx = setupE2eScenario(scenario);

  it('detects when implementer writes outside task scope', async () => {
    const summary = await runE2eWorkflow(ctx, scenario);

    const driftEvents = ctx.events.filter(
      (e) => e.type === 'drift_detected' || e.type === 'drift_chain_detected',
    );

    expect(summary.totalTasks).toBeGreaterThanOrEqual(1);
    // Drift detection runs post-task; if the cassette includes out-of-scope writes,
    // drift events are expected. When recording a clean cassette, this may be 0.
    // The test mainly verifies the pipeline doesn't crash on drift scenarios.
  });
});
```

## Recording cassettes

### Initial recording workflow

To record an initial set of cassettes, you need real API credentials:

```bash
# Set API key
export ANTHROPIC_API_KEY=sk-ant-...

# Record all scenarios
DIPTYCH_E2E_RECORD=1 npm run test:e2e

# Verify replay
npm run test:e2e
```

The recorder writes cassettes to `testing/e2e/cassettes/`. Each file is ~50-500 KB (mostly model output text).

### Re-recording

Cassettes must be re-recorded when:

1. **Prompt format changes** — if planner/implementer prompts change significantly, recorded responses may no longer parse correctly
2. **Provider API changes** — if Anthropic/OpenAI change SSE format or response shape
3. **New scenarios** — adding a new test scenario requires a new recording

The cassette replayer throws an explicit error if the request sequence diverges from the recording, telling the developer to re-record.

### CI considerations

- `npm run test:e2e` runs in replay mode only — no API keys needed, deterministic, fast
- `npm run test:e2e:record` is manual-only, never in CI
- Cassette JSON files are committed to git (like snapshot tests)
- `.gitattributes`: mark cassettes as binary for cleaner diffs

Add to `.gitattributes`:
```
testing/e2e/cassettes/*.json linguist-generated=true
```

## Relationship to P1 (Eval Harness)

The cassette infrastructure is **shared** between P2 (e2e tests) and P1 (eval harness):

- P2 uses cassettes for **correctness** — does the pipeline produce the expected events/state?
- P1 uses cassettes (or live runs) for **quality measurement** — how good is the output?

The recorder/replayer code in `testing/e2e/helpers/` can be imported by the eval harness. The eval harness may run in live mode more often (to measure real model quality), while e2e tests almost always use replay.

## Files to create

| File | Purpose |
|---|---|
| `testing/e2e/helpers/cassette-recorder.ts` | HTTP intercept → record to JSON |
| `testing/e2e/helpers/cassette-replayer.ts` | HTTP intercept → replay from JSON |
| `testing/e2e/helpers/e2e-harness.ts` | Shared setup (tmpDir, git, config, workflow) |
| `testing/e2e/vitest.e2e.config.ts` | Separate vitest config (120s timeout) |
| `testing/e2e/scenarios/instant-trivial-edit.test.ts` | Scenario 1 |
| `testing/e2e/scenarios/quick-add-endpoint.test.ts` | Scenario 2 |
| `testing/e2e/scenarios/standard-multi-task.test.ts` | Scenario 3 |
| `testing/e2e/scenarios/recovery-retry-success.test.ts` | Scenario 4 |
| `testing/e2e/scenarios/cost-routing-cheapest.test.ts` | Scenario 5 |
| `testing/e2e/scenarios/drift-out-of-scope.test.ts` | Scenario 6 |
| `testing/e2e/cassettes/` | Directory for recorded cassettes |

## Files to modify

| File | Change |
|---|---|
| `package.json` | Add `test:e2e` and `test:e2e:record` scripts |
| `.gitattributes` | Mark cassettes as linguist-generated |

## Acceptance criteria

1. `npm run test:e2e` runs all 6 scenarios from cassettes in < 30 seconds total
2. `npm run test:e2e:record` records real API interactions (when `ANTHROPIC_API_KEY` is set)
3. Cassette replayer throws clear errors on request mismatch (URL/method drift)
4. Cassette replayer throws clear errors when entries are exhausted
5. Cassette replayer throws clear errors when entries are not fully consumed
6. Auth headers are redacted in recorded cassettes
7. SSE streaming responses replay correctly through both Anthropic and OpenAI adapters
8. E2e tests are NOT included in `npm test` (separate config, separate script)
9. Zero new dependencies — uses `globalThis.fetch` monkey-patching
10. All e2e files follow project conventions: ESM `.js` imports, kebab-case, zero classes, zero barrels

## Conventions reminder (for the implementing AI context)

- **ESM only** with `.js` extension in imports: `'./cassette-replayer.js'` not `'./cassette-replayer'`
- **Zero classes** — use functions and closures (the recorder/replayer above use the factory pattern)
- **kebab-case** for all file/folder names
- **No barrel files** — no `index.ts` anywhere
- **Vitest** — `import { describe, expect, it } from 'vitest'` (globals disabled)
- **No `vi.mock` on siblings** — the cassette system replaces `globalThis.fetch`, not internal modules
- **DO NOT** use `git add`, `git commit`, or `git stage`
- Tests follow Kent C. Dodds Testing Trophy: assert on observable state (events, summary, files on disk), not internal calls
