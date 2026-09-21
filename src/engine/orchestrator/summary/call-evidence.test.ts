import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePricedModelCache } from '#testing/helpers/factories/model-cache.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { SESSION_LOG_FILE, sessionDir } from '../../../core/paths.js';
import { InvocationIdentitySchema } from '../../../core/schemas/invocation-identity.js';
import type { RunnerCallUsage } from '../../calls/types.js';
import { createJsonlSink } from '../../events/sinks/jsonl.js';
import type { EngineEvent } from '../../events/types.js';
import { createCallEvidenceSink } from './call-evidence.js';
import { buildSummary } from './build.js';

const CAPTURED_AT = Date.UTC(2026, 8, 16, 12, 0, 0);

const SEAT_TOOL = 'custom-worker-api';
const SEAT_MODEL = 'deepseek-v4-flash';

// A matrix row proved this invocation ran on an API key, so the run knows what it
// was billed as rather than inheriting the tool's catalogued default.
const ENFORCED_API_KEY = InvocationIdentitySchema.parse({
  version: 1,
  capturedAt: CAPTURED_AT,
  runner: { kind: 'api', id: SEAT_TOOL },
  configuredChannel: 'api-key',
  enforcedChannel: { channel: 'api-key', evidenceId: 'api.custom-worker.api-key' },
  billing: {
    posture: 'api-metered',
    basis: 'enforced-channel',
    evidenceId: 'api.custom-worker.api-key',
  },
});

const USAGE: RunnerCallUsage = {
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  reasoningTokens: 0,
  counterCoverage: {
    input: 'reported',
    output: 'reported',
    cacheRead: 'reported',
    cacheCreate: 'reported',
    reasoning: 'reported',
  },
};

function callEvents(callId: string): EngineEvent[] {
  const context = {
    callId,
    role: 'implementer',
    backendKind: 'api',
    runnerName: SEAT_TOOL,
    model: SEAT_MODEL,
    usageBoundary: 'single-request',
    invocationIdentity: ENFORCED_API_KEY,
  } as const;
  return [
    {
      type: 'runner_call_started',
      ts: CAPTURED_AT,
      phase: 'implementing',
      sequence: 1,
      ...context,
    },
    {
      type: 'runner_call_completed',
      ts: CAPTURED_AT + 1000,
      phase: 'implementing',
      sequence: 2,
      status: 'completed',
      error: null,
      partial: false,
      startedAt: CAPTURED_AT,
      endedAt: CAPTURED_AT + 1000,
      durationMs: 1000,
      usage: USAGE,
      nativeSessionId: null,
      ...context,
    },
  ];
}

const dirs: string[] = [];

function makeSession(): { projectDir: string; sessionId: string } {
  const projectDir = mkdtempSync(join(tmpdir(), 'splitbrief-call-evidence-'));
  dirs.push(projectDir);
  return { projectDir, sessionId: 'sess-1' };
}

function summarize(ref: { projectDir: string; sessionId: string }) {
  return buildSummary({
    feature: 'auth',
    state: {
      tasks: [],
      tokenUsage: makeUsage({ implementerInput: 1_000_000, implementerOutput: 1_000_000 }),
      phase: 'complete',
      currentTaskIndex: 0,
    },
    startTime: CAPTURED_AT,
    plannerTool: 'claude-code',
    implementerTool: SEAT_TOOL,
    implementerModel: SEAT_MODEL,
    pricingCache: makePricedModelCache(),
    ...ref,
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('run call evidence', () => {
  it("prices a logged run's requests from the rates and channel its calls recorded", () => {
    const ref = makeSession();
    mkdirSync(sessionDir(ref.projectDir, ref.sessionId), { recursive: true });
    const log = createJsonlSink(ref);
    for (const event of callEvents('impl-1')) log(event);

    const breakdown = summarize(ref).costBreakdown;

    const items = breakdown?.requestEstimate?.items ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.rates).toEqual({
      source: 'models-dev',
      provider: SEAT_TOOL,
      model: SEAT_MODEL,
      inputPer1M: 0.14,
      outputPer1M: 0.28,
      capturedAt: expect.any(Number),
    });
    expect(items[0]?.billing).toEqual({
      posture: 'api-metered',
      basis: 'enforced-channel',
      evidenceId: 'api.custom-worker.api-key',
    });
    expect(items[0]?.invocationIdentity).toEqual(ENFORCED_API_KEY);
    expect(breakdown?.providerRunMetadata?.[SEAT_TOOL]?.billingAttribution).toEqual({
      posture: 'api-metered',
      basis: 'enforced-channel',
      evidenceId: 'api.custom-worker.api-key',
    });
  });

  it('prices a live run from the calls it holds, before anything reaches the log', () => {
    const ref = makeSession();
    const sink = createCallEvidenceSink(ref);
    for (const event of callEvents('impl-1')) sink(event);

    const breakdown = summarize(ref).costBreakdown;

    expect(existsSync(join(sessionDir(ref.projectDir, ref.sessionId), SESSION_LOG_FILE))).toBe(
      false,
    );
    expect(breakdown?.requestEstimate?.items).toHaveLength(1);
    expect(breakdown?.requestEstimate?.items[0]?.billing.basis).toBe('enforced-channel');
  });

  it('keeps the calls an earlier process logged when a resumed run adds its own', () => {
    const ref = makeSession();
    mkdirSync(sessionDir(ref.projectDir, ref.sessionId), { recursive: true });
    const log = createJsonlSink(ref);
    for (const event of callEvents('impl-1')) log(event);

    const sink = createCallEvidenceSink(ref);
    for (const event of callEvents('impl-2')) sink(event);

    const items = summarize(ref).costBreakdown?.requestEstimate?.items ?? [];
    expect(items.map((item) => item.callId)).toEqual(['impl-1', 'impl-2']);
  });

  it('leaves a session that recorded no call as an unattributed sum', () => {
    const breakdown = summarize(makeSession()).costBreakdown;

    expect(breakdown?.requestEstimate).toBeUndefined();
    expect(breakdown?.providerRunMetadata?.[SEAT_TOOL]?.billingAttribution).toEqual({
      posture: 'unknown',
      basis: 'legacy-unattributed',
    });
  });
});
