import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir, ensureSplitbriefDir } from '../../../core/paths-io.js';
import { sessionDir } from '../../../core/paths.js';
import { configureLogger, resetLoggerForTests } from '../../../lib/logger.js';
import { SessionLogEntrySchema } from '../../../core/schemas/session-log.js';
import { parseEngineEvent } from '../schema.js';
import type { EngineEvent } from '../types.js';
import { createJsonlSink } from './jsonl.js';
import { createLoggerSink } from './logger.js';

const BRIEF_HASH = 'a'.repeat(64);
const REPORT_HASH = 'b'.repeat(64);
const SECRET = 'sk-ant-recovery-secret-81942';

const base = {
  ts: 100,
  phase: 'reviewing-briefs' as const,
  version: 1 as const,
  sessionId: 'session-recovery',
  epochId: 'epoch-recovery',
  recoveryRevision: 1,
  briefRevision: 3,
  briefHash: BRIEF_HASH,
  reportRevision: 2,
  reportHash: REPORT_HASH,
};

function recoveryEvent(value: unknown): EngineEvent {
  const parsed = parseEngineEvent(value);
  if (parsed === null) throw new Error('Expected a valid recovery event fixture');
  return parsed;
}

function recoveryEvents(): EngineEvent[] {
  return [
    recoveryEvent({
      ...base,
      type: 'brief_recovery_quality_reported',
      eventId: 'quality-1',
      status: 'blocked',
      outcome: 'failed',
      taskCount: 0,
      issueCount: 1,
      errorCount: 1,
      warningCount: 0,
      issueCodes: ['empty_task_list'],
    }),
    recoveryEvent({
      ...base,
      type: 'brief_recovery_auto_repair_exhausted',
      eventId: 'exhausted-1',
      operationId: 'automatic-1',
      intentHash: BRIEF_HASH,
      attemptKind: 'automatic',
      status: 'blocked',
      refusalCategory: 'quality',
      automaticRepairConsumed: true,
      taskCount: 0,
      issueCount: 1,
      errorCount: 1,
      warningCount: 0,
      issueCodes: ['empty_task_list'],
    }),
    recoveryEvent({
      ...base,
      type: 'brief_recovery_attempt_accepted',
      eventId: 'accepted-1',
      operationId: 'retry-1',
      intentHash: BRIEF_HASH,
      attemptKind: 'manual-retry',
      status: 'accepted',
      dispatchPossibility: 'none',
      frozenInputCount: 0,
      queuedInputCount: 0,
      automaticAllowanceConsumed: true,
    }),
    recoveryEvent({
      ...base,
      type: 'brief_recovery_attempt_started',
      eventId: 'started-1',
      operationId: 'retry-1',
      intentHash: BRIEF_HASH,
      attemptKind: 'manual-retry',
      status: 'started',
      requestId: 'request-1',
      dispatchPossibility: 'possible',
      frozenInputCount: 0,
    }),
    recoveryEvent({
      ...base,
      type: 'brief_recovery_attempt_settled',
      eventId: 'settled-1',
      operationId: 'retry-1',
      intentHash: BRIEF_HASH,
      attemptKind: 'manual-retry',
      status: 'settled',
      resultId: 'result-1',
      outcome: 'ready',
      dispatchPossibility: 'possible',
      remoteObservation: 'confirmed-final',
      taskCount: 1,
      issueCount: 0,
      errorCount: 0,
      warningCount: 0,
    }),
    recoveryEvent({
      ...base,
      type: 'brief_recovery_attempt_unresolved',
      eventId: 'unresolved-1',
      operationId: 'retry-2',
      intentHash: REPORT_HASH,
      attemptKind: 'manual-retry',
      status: 'unresolved',
      requestId: 'request-2',
      dispatchPossibility: 'possible',
      remoteObservation: 'unknown',
      refusalCategory: 'unresolved',
    }),
    recoveryEvent({
      ...base,
      type: 'brief_recovery_provider_failed',
      eventId: 'provider-1',
      operationId: 'retry-3',
      intentHash: BRIEF_HASH,
      attemptKind: 'manual-retry',
      status: 'blocked',
      outcome: 'provider-failed',
      providerCode: 'auth_failed',
      refusalCategory: 'authentication',
      dispatchPossibility: 'none',
      remoteObservation: 'not-dispatched',
    }),
    recoveryEvent({
      ...base,
      type: 'brief_recovery_input_queued',
      eventId: 'queued-1',
      inputId: 'input-1',
      inputSequence: 1,
      inputKind: 'feedback',
      source: 'interactive',
      textHash: REPORT_HASH,
      operationId: null,
      queuedInputCount: 1,
    }),
    recoveryEvent({
      ...base,
      type: 'brief_recovery_input_applied',
      eventId: 'applied-1',
      inputId: 'input-1',
      inputSequence: 1,
      inputKind: 'edit',
      source: 'typed',
      textHash: REPORT_HASH,
      operationId: 'retry-1',
      disposition: 'applied',
      appliedRevision: 2,
      queuedInputCount: 0,
    }),
    recoveryEvent({
      ts: base.ts,
      phase: base.phase,
      version: base.version,
      sessionId: base.sessionId,
      epochId: base.epochId,
      recoveryRevision: base.recoveryRevision,
      type: 'brief_recovery_stale_ignored',
      eventId: 'stale-1',
      operationId: 'retry-1',
      intentHash: BRIEF_HASH,
      resultId: 'result-1',
      baseBriefRevision: 1,
      baseBriefHash: BRIEF_HASH,
      currentBriefRevision: 2,
      currentBriefHash: REPORT_HASH,
      baseReportRevision: 1,
      baseReportHash: BRIEF_HASH,
      currentReportRevision: 2,
      currentReportHash: REPORT_HASH,
      refusalCategory: 'stale',
    }),
    recoveryEvent({
      ...base,
      type: 'brief_recovery_rejected',
      eventId: 'rejected-1',
      intentId: 'reject-1',
      operationId: null,
      status: 'rejected',
      disposition: 'user-rejected',
    }),
    recoveryEvent({
      ...base,
      type: 'brief_recovery_refused',
      eventId: 'refused-1',
      intentId: 'approve-1',
      operationId: null,
      action: 'approve',
      refusalCategory: 'budget',
      refusalCode: 'brief_budget_exhausted',
      status: 'blocked',
    }),
  ];
}

function readLoggerData(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown>);
}

function readJsonlData(projectDir: string, sessionId: string): Array<Record<string, unknown>> {
  const path = join(sessionDir(projectDir, sessionId), 'session.jsonl');
  return readFileSync(path, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => {
      const parsed = SessionLogEntrySchema.parse(JSON.parse(line));
      if (parsed.kind !== 'event') throw new Error('Expected an event log entry');
      if (typeof parsed.data !== 'object' || parsed.data === null || Array.isArray(parsed.data)) {
        throw new Error('Expected an object event payload');
      }
      return { type: parsed.type, ...parsed.data };
    });
}

let dirs: string[] = [];

afterEach(() => {
  resetLoggerForTests();
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

describe('recovery logger and JSONL sinks', () => {
  it('preserves protected recovery identities, status, hashes, and refusal categories', () => {
    const projectDir = createTempDir('recovery-logger');
    dirs.push(projectDir);
    configureLogger({ projectDir, relativePath: 'debug.log', enabled: true });
    const logger = createLoggerSink({ persistTranscript: false });
    const events = recoveryEvents();

    for (const event of events) logger(event);

    const lines = readLoggerData(join(projectDir, 'debug.log'));
    expect(lines).toHaveLength(events.length);
    for (const [index, line] of lines.entries()) {
      const event = events[index];
      if (event === undefined || !('eventId' in event)) {
        throw new Error('Expected a recovery event fixture');
      }
      expect(line).toMatchObject({
        type: event.type,
        eventId: event.eventId,
        sessionId: 'session-recovery',
        epochId: 'epoch-recovery',
      });
    }
    expect(lines.find((line) => line.type === 'brief_recovery_refused')).toMatchObject({
      status: 'blocked',
      refusalCategory: 'budget',
      refusalCode: 'brief_budget_exhausted',
      briefHash: BRIEF_HASH,
      reportHash: REPORT_HASH,
    });
    expect(lines.find((line) => line.type === 'brief_recovery_attempt_started')).toMatchObject({
      eventId: 'started-1',
      operationId: 'retry-1',
      status: 'started',
      dispatchPossibility: 'possible',
      briefHash: BRIEF_HASH,
      reportHash: REPORT_HASH,
    });
    expect(lines.find((line) => line.type === 'brief_recovery_stale_ignored')).toMatchObject({
      eventId: 'stale-1',
      operationId: 'retry-1',
      refusalCategory: 'stale',
      baseBriefHash: BRIEF_HASH,
      currentBriefHash: REPORT_HASH,
    });
  });

  it('writes one schema-valid protected JSONL record for every recovery event', () => {
    const projectDir = createTempDir('recovery-jsonl');
    dirs.push(projectDir);
    const sessionId = 'session-recovery';
    ensureSplitbriefDir(projectDir);
    ensureSessionDir(projectDir, sessionId);
    const sink = createJsonlSink({ projectDir, sessionId, persistTranscript: false });
    const events = recoveryEvents();

    for (const event of events) sink(event);

    const lines = readJsonlData(projectDir, sessionId);
    expect(lines).toHaveLength(events.length);
    for (const [index, line] of lines.entries()) {
      const event = events[index];
      if (event === undefined || !('eventId' in event)) {
        throw new Error('Expected a recovery event fixture');
      }
      expect(line).toMatchObject({
        type: event.type,
        eventId: event.eventId,
        sessionId: 'session-recovery',
        epochId: 'epoch-recovery',
      });
    }
    expect(lines.find((line) => line.type === 'brief_recovery_refused')).toMatchObject({
      status: 'blocked',
      refusalCategory: 'budget',
      refusalCode: 'brief_budget_exhausted',
      briefHash: BRIEF_HASH,
      reportHash: REPORT_HASH,
    });
  });

  it('keeps duplicate and conflicting IDs as protected projection records', () => {
    const projectDir = createTempDir('recovery-jsonl-duplicates');
    dirs.push(projectDir);
    const sessionId = 'session-recovery';
    ensureSplitbriefDir(projectDir);
    ensureSessionDir(projectDir, sessionId);
    const sink = createJsonlSink({ projectDir, sessionId, persistTranscript: true });
    const original = recoveryEvents().find((event) => event.type === 'brief_recovery_refused');
    if (original === undefined || original.type !== 'brief_recovery_refused') {
      throw new Error('Expected refused recovery fixture');
    }
    const conflicting = {
      ...original,
      refusalCategory: 'provider',
      refusalCode: 'provider_failed',
      rawPrompt: SECRET,
    } as unknown as EngineEvent;

    expect(() => {
      sink(original);
      sink(original);
      sink(conflicting);
    }).not.toThrow();

    const lines = readJsonlData(projectDir, sessionId);
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.eventId)).toEqual(['refused-1', 'refused-1', 'refused-1']);
    expect(JSON.stringify(lines)).not.toContain(SECRET);
    expect(lines[2]).toMatchObject({ refusalCategory: 'provider', refusalCode: 'provider_failed' });
  });

  it('fails closed for oversized or secret recovery payloads', () => {
    const projectDir = createTempDir('recovery-jsonl-protection');
    dirs.push(projectDir);
    const sessionId = 'session-recovery';
    ensureSplitbriefDir(projectDir);
    ensureSessionDir(projectDir, sessionId);
    const sink = createJsonlSink({ projectDir, sessionId, persistTranscript: true });
    const oversized = {
      ...recoveryEvents()[0],
      issueCount: 257,
      errorCount: 257,
      issueCodes: Array.from({ length: 257 }, (_value, index) => `issue-${index}`),
      prompt: SECRET,
    } as unknown as EngineEvent;

    sink(oversized);

    const lines = readJsonlData(projectDir, sessionId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      type: 'warning',
      category: 'protection',
      code: 'payload_omitted',
    });
    expect(JSON.stringify(lines)).not.toContain(SECRET);
  });

  it('keeps logger and JSONL write failures outside workflow authority', () => {
    const loggerDir = createTempDir('recovery-logger-failure');
    const jsonlDir = createTempDir('recovery-jsonl-failure');
    dirs.push(loggerDir, jsonlDir);
    const loggerPath = join(loggerDir, 'debug.log');
    symlinkSync(join(loggerDir, 'outside.log'), loggerPath);
    configureLogger({ projectDir: loggerDir, relativePath: 'debug.log', enabled: true });
    const logger = createLoggerSink({ persistTranscript: true });

    const sessionId = 'session-recovery';
    ensureSplitbriefDir(jsonlDir);
    ensureSessionDir(jsonlDir, sessionId);
    const logPath = join(sessionDir(jsonlDir, sessionId), 'session.jsonl');
    symlinkSync(join(jsonlDir, 'outside-session.jsonl'), logPath);
    const degraded = vi.fn();
    const jsonl = createJsonlSink({
      projectDir: jsonlDir,
      sessionId,
      persistTranscript: true,
      onDegraded: degraded,
    });
    const event = recoveryEvents()[0];
    if (event === undefined) throw new Error('Expected a recovery event fixture');

    expect(() => {
      logger(event);
      jsonl(event);
      jsonl(event);
    }).not.toThrow();
    expect(existsSync(join(loggerDir, 'outside.log'))).toBe(false);
    expect(existsSync(join(jsonlDir, 'outside-session.jsonl'))).toBe(false);
    expect(degraded).toHaveBeenCalledTimes(1);
  });
});
