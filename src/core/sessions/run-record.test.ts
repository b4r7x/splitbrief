import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeSummary } from '#testing/helpers/factories/summary.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { RESEARCH_FILE, sessionDir } from '../paths.js';
import type { WorkflowState } from '../schemas/workflow.js';
import { saveState } from '../state/persistence.js';
import { saveSummary } from './io.js';
import { loadRunRecord } from './run-record.js';
import { defaultRunRecordDeps } from './run-record-io.js';

let tmp: string;

afterEach(() => {
  if (tmp) cleanupTempDir(tmp);
  tmp = '';
});

const SESSION_ID = '2026-09-01-record';

function project(): string {
  tmp = createTempDir('run-record-test');
  mkdirSync(sessionDir(tmp, SESSION_ID), { recursive: true });
  return tmp;
}

function ref() {
  return { projectDir: tmp, sessionId: SESSION_ID };
}

function record() {
  return loadRunRecord(ref(), defaultRunRecordDeps());
}

function withState(overrides: Partial<WorkflowState>): void {
  saveState(ref(), makeImplState([makeTask({ id: 'T001' })], overrides));
}

describe('loadRunRecord', () => {
  it('reports a missing state as an open run that failed to read', () => {
    project();

    const loaded = record();

    expect(loaded.hydration.kind).toBe('missing');
    expect(loaded.status).toEqual({
      kind: 'open',
      stop: {
        kind: 'stopped',
        on: { kind: 'failed', message: 'Session has no saved state to read.' },
      },
      resumeAt: { kind: 'planner', call: 'plan' },
    });
    expect(loaded.feature).toBe('');
    expect(loaded.startedAt).toBeNull();
  });

  it('carries the parse message of a malformed state', () => {
    project();
    writeFileSync(join(sessionDir(tmp, SESSION_ID), 'state.json'), '{not json');

    const loaded = record();

    expect(loaded.hydration.kind).toBe('invalid');
    expect(loaded.status).toMatchObject({
      kind: 'open',
      stop: { kind: 'stopped', on: { kind: 'failed' } },
    });
  });

  it('reads an open paused run with its feature and resume step', () => {
    project();
    withState({ phase: 'implementing', mode: 'standard', awaitingContinue: true });

    const loaded = record();

    expect(loaded.feature).toBe('feat');
    expect(loaded.startedAt).not.toBeNull();
    expect(loaded.status).toMatchObject({
      kind: 'open',
      stop: { kind: 'stopped', on: { kind: 'paused', at: 'mid-step' } },
      resumeAt: { kind: 'brief', taskId: 'T001', attempt: 0 },
    });
  });

  it('reads an explicitly ended run as closed', () => {
    project();
    withState({ closed: { at: '2026-09-01T00:00:00.000Z', as: 'ended' } });

    expect(record().status).toEqual({ kind: 'closed', as: 'ended' });
  });

  it('reads a run that passed its review as closed complete, with the summary it wrote', () => {
    project();
    withState({ phase: 'complete', reviewStatus: 'passed', currentTaskIndex: 1 });
    saveSummary(ref(), {
      id: SESSION_ID,
      feature: 'feat',
      startedAt: 1,
      completedAt: 2,
      stateVersion: 4,
      status: 'complete',
      summary: makeSummary({ feature: 'feat' }),
    });

    const loaded = record();

    expect(loaded.status).toEqual({ kind: 'closed', as: 'complete' });
    expect(loaded.summary?.feature).toBe('feat');
  });

  it('resumes an old run that wrote research at its planning session', () => {
    project();
    withState({ phase: 'idle', mode: 'standard', currentTaskIndex: 0 });
    writeFileSync(join(sessionDir(tmp, SESSION_ID), RESEARCH_FILE), '# research\n');

    expect(record().status).toMatchObject({ resumeAt: { kind: 'planner', call: 'plan' } });
  });

  it('reports no ledger and no checkpoint when the run wrote neither', () => {
    project();
    withState({ phase: 'implementing' });

    const loaded = record();

    expect(loaded.ledger).toBeNull();
    expect(loaded.checkpoint).toBeNull();
  });
});
