import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { SESSION_LOG_FILE, sessionDir } from '../../../core/paths.js';
import { addUsage } from '../tokens.js';
import { createInitialState } from '../../../core/state/machine.js';
import { TokenUsageSchema } from '../../../core/schemas/tokens.js';
import { toTokenDelta } from '../../calls/usage.js';
import { buildSummary } from './build.js';
import { reconcileTokenUsageWithSessionLog } from './usage-reconcile.js';

// Verbatim runner_call records from the 2026-08-06 failed quick run whose summary.json
// reported all-zero tokenUsage: the first planner attempt completed with real usage, the
// zero-task retry failed on a consumed session id, and the throw skipped the ledger booking.
const REAL_FAILED_RUN_LOG = [
  '{"ts":"2026-08-06T19:04:51.568Z","kind":"event","type":"runner_call_usage","phase":"researching","data":{"callId":"single-phase-1-attempt-1","role":"planner","backendKind":"cli","runnerName":"claude","attempt":1,"sequence":58,"usage":{"inputTokens":2,"outputTokens":451,"cacheReadTokens":15497,"cacheCreateTokens":23170},"semantics":"delta"}}',
  '{"ts":"2026-08-06T19:05:15.042Z","kind":"event","type":"runner_call_usage","phase":"researching","data":{"callId":"single-phase-1-attempt-1","role":"planner","backendKind":"cli","runnerName":"claude","attempt":1,"sequence":150,"usage":{"inputTokens":2,"outputTokens":2258,"cacheReadTokens":38667,"cacheCreateTokens":686},"semantics":"delta"}}',
  '{"ts":"2026-08-06T19:05:20.697Z","kind":"event","type":"runner_call_usage","phase":"researching","data":{"callId":"single-phase-1-attempt-1","role":"planner","backendKind":"cli","runnerName":"claude","attempt":1,"sequence":172,"usage":{"inputTokens":2,"outputTokens":297,"cacheReadTokens":39353,"cacheCreateTokens":2753},"semantics":"delta"}}',
  '{"ts":"2026-08-06T19:05:20.704Z","kind":"event","type":"runner_call_usage","phase":"researching","data":{"callId":"single-phase-1-attempt-1","role":"planner","backendKind":"cli","runnerName":"claude","attempt":1,"sequence":176,"usage":{"inputTokens":6,"outputTokens":3006,"cacheReadTokens":93517,"cacheCreateTokens":26609},"semantics":"final"}}',
  '{"ts":"2026-08-06T19:05:21.129Z","kind":"event","type":"runner_call_completed","phase":"researching","data":{"callId":"single-phase-1-attempt-1","role":"planner","backendKind":"cli","runnerName":"claude","attempt":1,"sequence":177,"status":"completed","error":null,"partial":false,"startedAt":1786043080813,"endedAt":1786043121129,"durationMs":40316,"usage":{"inputTokens":6,"outputTokens":3006,"cacheReadTokens":93517,"cacheCreateTokens":26609},"nativeSessionId":"0a3443ac-432e-40c8-bdf9-29859130257f"}}',
  '{"ts":"2026-08-06T19:05:21.537Z","kind":"event","type":"runner_call_error","phase":"researching","data":{"callId":"single-phase-2-attempt-1","role":"planner","backendKind":"cli","runnerName":"claude","attempt":1,"sequence":179,"status":"failed","error":{"code":"process-output","message":"claude exited with code 1: Error: Session ID 0a3443ac-432e-40c8-bdf9-29859130257f is already in use."},"partial":false,"startedAt":1786043121137,"endedAt":1786043121537,"durationMs":400,"usage":null,"nativeSessionId":"0a3443ac-432e-40c8-bdf9-29859130257f"}}',
] as const;

// These historical records carry counters, but predate counter coverage.
const REAL_PLANNER_TOTALS = {
  plannerInput: 6,
  plannerOutput: 3006,
  plannerCacheRead: 93517,
  plannerCacheCreate: 26609,
};

const PLANNING_REVIEW_LOG = [
  '{"ts":"2026-08-06T19:04:51.568Z","kind":"event","type":"runner_call_completed","phase":"planning","data":{"callId":"plan-1","role":"planner","backendKind":"cli","runnerName":"claude","sequence":1,"status":"completed","error":null,"partial":false,"startedAt":1,"endedAt":2,"durationMs":1,"usage":{"inputTokens":100,"outputTokens":200},"nativeSessionId":null}}',
  '{"ts":"2026-08-06T19:04:55.000Z","kind":"event","type":"runner_call_completed","phase":"planning","data":{"callId":"speckit-plan-review-1","role":"review","backendKind":"cli","runnerName":"claude","sequence":2,"status":"completed","error":null,"partial":false,"startedAt":1,"endedAt":2,"durationMs":1,"usage":{"inputTokens":1000,"outputTokens":2000},"nativeSessionId":null}}',
] as const;

function writeSessionLog(projectDir: string, sessionId: string, lines: readonly string[]): void {
  const dir = sessionDir(projectDir, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SESSION_LOG_FILE), `${lines.join('\n')}\n`);
}

describe('reconcileTokenUsageWithSessionLog', () => {
  it('books the planner usage a failed run consumed (real 2026-08-06 session records)', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'usage-reconcile-'));
    try {
      const sessionId = 'failed-quick-run';
      writeSessionLog(projectDir, sessionId, REAL_FAILED_RUN_LOG);

      const reconciled = reconcileTokenUsageWithSessionLog({
        ref: { projectDir, sessionId },
        booked: makeUsage(),
      });

      // Deltas sum to the final sample (2+2+2 / 451+2258+297), the final replaces the
      // running total, and the terminal record repeats it — any double count would
      // report 12/6012 instead.
      expect(reconciled).toEqual(makeUsage(REAL_PLANNER_TOTALS));
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('does not double count usage the ledger already booked', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'usage-reconcile-'));
    try {
      const sessionId = 'booked-run';
      writeSessionLog(projectDir, sessionId, REAL_FAILED_RUN_LOG);
      const booked = makeUsage(REAL_PLANNER_TOTALS);

      expect(reconcileTokenUsageWithSessionLog({ ref: { projectDir, sessionId }, booked })).toEqual(
        booked,
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('keeps reviewer tokens the ledger booked when the log records none', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'usage-reconcile-'));
    try {
      const sessionId = 'reviewed-run';
      writeSessionLog(projectDir, sessionId, REAL_FAILED_RUN_LOG);
      const booked = makeUsage({
        ...REAL_PLANNER_TOTALS,
        reviewerInput: 120,
        reviewerOutput: 45,
        reviewerCacheRead: 900,
      });

      expect(reconcileTokenUsageWithSessionLog({ ref: { projectDir, sessionId }, booked })).toEqual(
        booked,
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('returns booked usage unchanged when no session log exists', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'usage-reconcile-'));
    try {
      const booked = makeUsage({ plannerInput: 11, plannerOutput: 22 });

      const reconciled = reconcileTokenUsageWithSessionLog({
        ref: { projectDir, sessionId: 'no-log-run' },
        booked,
      });

      expect(reconciled).toEqual(booked);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('routes implementer and escalation usage into their ledger buckets and ignores post-terminal samples', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'usage-reconcile-'));
    try {
      const sessionId = 'mixed-roles-run';
      writeSessionLog(projectDir, sessionId, [
        '{"ts":"2026-08-06T19:04:51.568Z","kind":"event","type":"runner_call_usage","phase":"implementing","data":{"callId":"impl-1","role":"implementer","backendKind":"cli","sequence":1,"usage":{"inputTokens":100,"outputTokens":50,"cacheReadTokens":10},"semantics":"delta"}}',
        '{"ts":"2026-08-06T19:04:52.000Z","kind":"event","type":"runner_call_completed","phase":"implementing","data":{"callId":"impl-1","role":"implementer","backendKind":"cli","sequence":2,"status":"completed","error":null,"partial":false,"startedAt":1786043080813,"endedAt":1786043081000,"durationMs":187,"usage":null,"nativeSessionId":null}}',
        '{"ts":"2026-08-06T19:04:53.000Z","kind":"event","type":"runner_call_usage","phase":"implementing","data":{"callId":"impl-1","role":"implementer","backendKind":"cli","sequence":3,"usage":{"inputTokens":999,"outputTokens":999},"semantics":"delta"}}',
        '{"ts":"2026-08-06T19:04:54.000Z","kind":"event","type":"runner_call_usage","phase":"implementing","data":{"callId":"esc-1","role":"escalation","backendKind":"cli","sequence":4,"usage":{"inputTokens":40,"outputTokens":20,"cacheCreateTokens":7},"semantics":"final"}}',
      ]);

      const reconciled = reconcileTokenUsageWithSessionLog({
        ref: { projectDir, sessionId },
        booked: makeUsage(),
      });

      expect(reconciled).toEqual(
        makeUsage({
          implementerInput: 100,
          implementerOutput: 50,
          implementerCacheRead: 10,

          escalationInput: 40,
          escalationOutput: 20,
          escalationCacheCreate: 7,
        }),
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('leaves the reviewer bucket empty when every logged review call was made by the planner', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'usage-reconcile-'));
    try {
      const sessionId = 'planning-review-run';
      writeSessionLog(projectDir, sessionId, PLANNING_REVIEW_LOG);
      // runPlannerReview books its planning-time review onto the planner.
      const booked = makeUsage({ plannerInput: 1100, plannerOutput: 2200 });

      const reconciled = reconcileTokenUsageWithSessionLog({
        ref: { projectDir, sessionId },
        booked,
      });

      expect(reconciled).toEqual(booked);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('credits a final review the ledger lost to the reviewer seat', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'usage-reconcile-'));
    try {
      const sessionId = 'failed-review-run';
      writeSessionLog(projectDir, sessionId, [
        ...PLANNING_REVIEW_LOG,
        '{"ts":"2026-08-06T19:05:00.000Z","kind":"event","type":"runner_call_error","phase":"final-review","data":{"callId":"final-review-1","role":"review","backendKind":"api","sequence":9,"status":"failed","error":{"code":"process-output","message":"reviewer exited with code 1"},"partial":false,"startedAt":1,"endedAt":2,"durationMs":1,"usage":{"inputTokens":5000,"outputTokens":6000},"nativeSessionId":null}}',
      ]);
      const booked = makeUsage({ plannerInput: 1100, plannerOutput: 2200 });

      const reconciled = reconcileTokenUsageWithSessionLog({
        ref: { projectDir, sessionId },
        booked,
      });

      expect(reconciled).toEqual(
        makeUsage({
          ...booked,

          reviewerInput: 5000,
          reviewerOutput: 6000,
        }),
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('credits a planning review the ledger lost to the planner, not to the reviewer seat', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'usage-reconcile-'));
    try {
      const sessionId = 'planning-failure-run';
      writeSessionLog(projectDir, sessionId, PLANNING_REVIEW_LOG);
      // The planning phase threw after its review call completed, so the ledger booked
      // neither call; a configured reviewer never ran.
      const reconciled = reconcileTokenUsageWithSessionLog({
        ref: { projectDir, sessionId },
        booked: makeUsage(),
      });

      expect(reconciled).toEqual(makeUsage({ plannerInput: 1100, plannerOutput: 2200 }));
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('keeps a planning review on the planner when a reviewer seat also ran', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'usage-reconcile-'));
    try {
      const sessionId = 'reviewer-seat-run';
      writeSessionLog(projectDir, sessionId, [
        ...PLANNING_REVIEW_LOG,
        '{"ts":"2026-08-06T19:05:00.000Z","kind":"event","type":"runner_call_completed","phase":"final-review","data":{"callId":"final-review-1","role":"review","backendKind":"api","sequence":9,"status":"completed","error":null,"partial":false,"startedAt":1,"endedAt":2,"durationMs":1,"usage":{"inputTokens":5000,"outputTokens":6000},"nativeSessionId":null}}',
      ]);
      const booked = makeUsage({
        plannerInput: 1100,
        plannerOutput: 2200,
        reviewerInput: 5000,
        reviewerOutput: 6000,
      });

      const reconciled = reconcileTokenUsageWithSessionLog({
        ref: { projectDir, sessionId },
        booked,
      });

      expect(reconciled).toEqual({
        ...booked,
      });
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

describe('buildSummary token usage reconciliation', () => {
  it("a failed run's summary reports the tokens its planner consumed", () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'usage-reconcile-'));
    try {
      const sessionId = 'failed-quick-run';
      writeSessionLog(projectDir, sessionId, REAL_FAILED_RUN_LOG);

      const summary = buildSummary({
        feature: 'add a titleCase function',
        state: { tasks: [], tokenUsage: makeUsage(), phase: 'complete', currentTaskIndex: 0 },
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'codex',
        projectDir,
        sessionId,
      });

      expect(summary.tokenUsage).toEqual(makeUsage(REAL_PLANNER_TOTALS));
      expect(summary.tokenUsage.plannerOutput).toBeGreaterThan(0);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("reports no reviewer tokens for a run whose only review call was the planner's", () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'usage-reconcile-'));
    try {
      const sessionId = 'planning-review-summary';
      writeSessionLog(projectDir, sessionId, PLANNING_REVIEW_LOG);

      const summary = buildSummary({
        feature: 'add a titleCase function',
        state: {
          tasks: [],
          tokenUsage: makeUsage({ plannerInput: 1100, plannerOutput: 2200 }),
          phase: 'complete',
          currentTaskIndex: 0,
        },
        startTime: Date.now(),
        plannerTool: 'claude-code',
        implementerTool: 'codex',
        projectDir,
        sessionId,
      });

      expect(summary.tokenUsage).toEqual(makeUsage({ plannerInput: 1100, plannerOutput: 2200 }));
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});

// One implementer call reported as two deltas, a final that restates the running total, and a
// terminal record that repeats that final a second time.
const REASONING_CALL_FINAL = {
  inputTokens: 30,
  outputTokens: 11,
  reasoningTokens: 6,
  cacheReadTokens: 8,
  cacheCreateTokens: 3,
};

const REASONING_RUN_LOG = [
  '{"ts":"2026-09-16T10:00:00.000Z","kind":"event","type":"runner_call_usage","phase":"implementing","data":{"callId":"impl-1","role":"implementer","backendKind":"api","sequence":1,"usage":{"inputTokens":10,"outputTokens":5,"reasoningTokens":2,"cacheReadTokens":3,"cacheCreateTokens":1},"semantics":"delta"}}',
  '{"ts":"2026-09-16T10:00:01.000Z","kind":"event","type":"runner_call_usage","phase":"implementing","data":{"callId":"impl-1","role":"implementer","backendKind":"api","sequence":2,"usage":{"inputTokens":20,"outputTokens":6,"reasoningTokens":4,"cacheReadTokens":5,"cacheCreateTokens":2},"semantics":"delta"}}',
  '{"ts":"2026-09-16T10:00:02.000Z","kind":"event","type":"runner_call_usage","phase":"implementing","data":{"callId":"impl-1","role":"implementer","backendKind":"api","sequence":3,"usage":{"inputTokens":30,"outputTokens":11,"reasoningTokens":6,"cacheReadTokens":8,"cacheCreateTokens":3},"semantics":"final"}}',
  '{"ts":"2026-09-16T10:00:03.000Z","kind":"event","type":"runner_call_completed","phase":"implementing","data":{"callId":"impl-1","role":"implementer","backendKind":"api","sequence":4,"status":"completed","error":null,"partial":false,"startedAt":1,"endedAt":2,"durationMs":1,"usage":{"inputTokens":30,"outputTokens":11,"reasoningTokens":6,"cacheReadTokens":8,"cacheCreateTokens":3},"nativeSessionId":null}}',
] as const;

describe('reconcileTokenUsageWithSessionLog — reasoning and idempotence', () => {
  it('replays delta, final and a duplicate terminal to exactly the live ledger, cache and reasoning included', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'usage-reconcile-'));
    try {
      const sessionId = 'reasoning-run';
      writeSessionLog(projectDir, sessionId, REASONING_RUN_LOG);

      // The live ledger books the same call through the path the orchestrator uses.
      const live = addUsage(
        createInitialState('feature'),
        'implementer',
        toTokenDelta(REASONING_CALL_FINAL),
      ).tokenUsage;
      expect(live.implementerOutput).toBe(11);
      expect(live.implementerReasoning).toBe(6);

      const reconciled = reconcileTokenUsageWithSessionLog({
        ref: { projectDir, sessionId },
        booked: makeUsage(),
      });

      expect(reconciled).toEqual(live);
      // Reconciling the reconciled record changes nothing.
      expect(
        reconcileTokenUsageWithSessionLog({ ref: { projectDir, sessionId }, booked: reconciled }),
      ).toEqual(reconciled);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('credits a lost reviewer reasoning count to the reviewer seat and stays idempotent', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'usage-reconcile-'));
    try {
      const sessionId = 'reviewer-reasoning-run';
      writeSessionLog(projectDir, sessionId, [
        ...PLANNING_REVIEW_LOG,
        '{"ts":"2026-09-16T10:00:00.000Z","kind":"event","type":"runner_call_error","phase":"final-review","data":{"callId":"final-review-1","role":"review","backendKind":"api","sequence":9,"status":"failed","error":{"code":"process-output","message":"reviewer exited with code 1"},"partial":false,"startedAt":1,"endedAt":2,"durationMs":1,"usage":{"inputTokens":5000,"outputTokens":6000,"reasoningTokens":700},"nativeSessionId":null}}',
      ]);
      const booked = makeUsage({ plannerInput: 1100, plannerOutput: 2200 });

      const first = reconcileTokenUsageWithSessionLog({
        ref: { projectDir, sessionId },
        booked,
      });

      expect(first).toMatchObject({
        reviewerInput: 5000,
        reviewerOutput: 6000,
        reviewerReasoning: 700,
      });
      expect(first).not.toHaveProperty('plannerReasoning');
      expect(
        reconcileTokenUsageWithSessionLog({ ref: { projectDir, sessionId }, booked: first }),
      ).toEqual(first);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('loads a pre-field state with its optional counters absent and never reads unknown as zero', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'usage-reconcile-'));
    try {
      const sessionId = 'legacy-state-run';
      writeSessionLog(projectDir, sessionId, REAL_FAILED_RUN_LOG);
      // A state.json written before reviewer accounting and before the reasoning counters.
      const booked = TokenUsageSchema.parse({
        plannerInput: 0,
        plannerOutput: 0,
        implementerInput: 0,
        implementerOutput: 0,
        escalationInput: 0,
        escalationOutput: 0,
      });
      expect(booked.reviewerInput).toBe(0);
      expect(booked).not.toHaveProperty('plannerReasoning');

      const reconciled = reconcileTokenUsageWithSessionLog({
        ref: { projectDir, sessionId },
        booked,
      });

      // The log's claude records carry no reasoning counter: unknown stays absent on every seat.
      for (const key of [
        'plannerReasoning',
        'implementerReasoning',
        'escalationReasoning',
        'reviewerReasoning',
        'escalationCacheRead',
        'escalationCacheCreate',
      ]) {
        expect(reconciled).not.toHaveProperty(key);
      }
      expect(reconciled).toEqual(makeUsage(REAL_PLANNER_TOTALS));
      expect(reconciled.plannerCoverage).toBeUndefined();
      expect(TokenUsageSchema.parse(reconciled)).toEqual(reconciled);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
