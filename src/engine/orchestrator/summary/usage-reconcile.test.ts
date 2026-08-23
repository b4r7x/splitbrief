import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { SESSION_LOG_FILE, sessionDir } from '../../../core/paths.js';
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
          plannerCacheCreate: 7,
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
        makeUsage({ ...booked, reviewerInput: 5000, reviewerOutput: 6000 }),
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

      expect(reconciled).toEqual(booked);
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
        state: { tasks: [], tokenUsage: makeUsage() },
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
