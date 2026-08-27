import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createElement } from 'react';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { configStore } from '../../../../stores/project/config.js';
import { formatTasks } from '../../../../engine/spec/formatter.js';
import { TASKS_FILE } from '../../../../core/paths.js';
import {
  type BriefRecoveryProjectionV1,
  BriefRecoveryProjectionV1Schema,
} from '../../../../core/schemas/brief-recovery/document.js';
import { BriefReviewView } from './view.js';

const recoveryBrief = { revision: 1, hash: 'b'.repeat(64), path: TASKS_FILE };
const recoveryReport = {
  revision: 1,
  hash: 'r'.repeat(64),
  path: 'brief-quality.json',
};

function recoveryProjection(
  status: BriefRecoveryProjectionV1['status'],
  issue: { taskId: string | null; message: string } | null = null,
): BriefRecoveryProjectionV1 {
  const qualityIssue =
    issue === null
      ? null
      : {
          code: 'missing_validation',
          severity: 'error' as const,
          taskId: issue.taskId,
          message: issue.message,
        };
  const storageBlocked = status === 'storage-blocked';
  const matchingReport = storageBlocked
    ? null
    : {
        briefHash: recoveryBrief.hash,
        report: recoveryReport,
        ruleVersion: 'brief-quality-v1',
        issues: qualityIssue === null ? [] : [qualityIssue],
      };
  const blocker = storageBlocked
    ? {
        kind: 'storage' as const,
        code: 'brief_storage_invalid' as const,
        message: 'tasks.md is unavailable',
      }
    : issue === null
      ? null
      : { kind: 'quality' as const, issues: [qualityIssue] };
  const operation =
    status === 'retrying'
      ? {
          operationId: 'operation-1',
          status: 'started' as const,
          dispatchPossibility: 'possible' as const,
          outcome: null,
          reservation: {
            accountingKey: {
              sessionId: 'session-1',
              epochId: 'epoch-1',
              operationId: 'operation-1',
              generation: 1,
            },
            amount: 1,
            state: 'reserved' as const,
          },
        }
      : null;
  return BriefRecoveryProjectionV1Schema.parse({
    version: 1,
    sessionId: 'session-1',
    stateRevision: 1,
    recoveryRevision: 1,
    epochId: 'epoch-1',
    status,
    origin: { mode: 'standard', entry: 'initial' },
    continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
    activeBrief: storageBlocked ? null : recoveryBrief,
    matchingReport,
    blocker,
    allowedActions:
      status === 'retrying'
        ? ['edit', 'reject', 'status']
        : status === 'ready'
          ? ['approve', 'edit', 'reject', 'status']
          : status === 'storage-blocked'
            ? ['edit', 'reject', 'status']
            : ['retry', 'edit', 'reject', 'status'],
    activeOperation: operation,
    latestAttempt: operation,
    queuedInputs: {
      ids: status === 'retrying' ? ['input-1', 'input-2', 'input-3'] : [],
      count: status === 'retrying' ? 3 : 0,
      carriedCount: status === 'retrying' ? 1 : 0,
      heldCount: status === 'retrying' ? 1 : 0,
      releasedCount: 0,
    },
  });
}

describe('BriefReviewView recovery body', () => {
  it('renders the empty-state outcome, cause, consequence, and action at 40 columns', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'brief-review-recovery-empty-test-'));
    try {
      configStore.__testReset({ config: makeConfig(), projectDir });
      const filePath = join(projectDir, TASKS_FILE);
      await writeFile(filePath, '', 'utf-8');

      const ui = renderFeature(
        createElement(BriefReviewView, {
          filePath,
          height: 16,
          width: 40,
          recovery: recoveryProjection('blocked', {
            taskId: null,
            message: 'Planner returned zero Task Briefs',
          }),
        }),
      );
      await vi.waitFor(() => {
        const frame = stripAnsiStyles(ui.lastFrame() ?? '');
        expect(frame).toContain('No Task Briefs');
        expect(frame).toContain('BECAUSE');
        expect(frame).toContain('SO');
        expect(frame).toContain('NOW');
      });
      expect((ui.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(16);
      ui.unmount();
    } finally {
      configStore.__testReset();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('keeps general issues outside task rows and links task issues by stable ID', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'brief-review-recovery-issues-test-'));
    try {
      configStore.__testReset({ config: makeConfig(), projectDir });
      const filePath = join(projectDir, TASKS_FILE);
      await writeFile(
        filePath,
        formatTasks([makeTask({ id: 'T001', title: 'Task with a contract issue' })]),
        'utf-8',
      );

      const ui = renderFeature(
        createElement(BriefReviewView, {
          filePath,
          height: 16,
          width: 80,
          recovery: recoveryProjection('blocked', {
            taskId: 'T001',
            message: 'Task T001 has no tests',
          }),
        }),
      );
      await vi.waitFor(() => {
        const frame = stripAnsiStyles(ui.lastFrame() ?? '');
        expect(frame).toContain('T001');
        expect(frame).toContain('Task T001 has no tests');
      });
      ui.unmount();
    } finally {
      configStore.__testReset();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['storage-blocked', 'BECAUSE STORAGE', 'NOW import'],
    ['retrying', 'RETRYING', 'QUEUED 1'],
    ['ready', 'CONTRACT READY', 'NOW approve'],
  ] as const)('keeps %s outcome and action visible', async (status, outcome, action) => {
    const projectDir = await mkdtemp(join(tmpdir(), `brief-review-recovery-${status}-test-`));
    try {
      configStore.__testReset({ config: makeConfig(), projectDir });
      const filePath = join(projectDir, TASKS_FILE);
      await writeFile(filePath, formatTasks([makeTask()]), 'utf-8');

      const ui = renderFeature(
        createElement(BriefReviewView, {
          filePath,
          height: 16,
          width: 80,
          recovery: recoveryProjection(status),
        }),
      );
      await vi.waitFor(() => {
        const frame = stripAnsiStyles(ui.lastFrame() ?? '');
        expect(frame).toContain(outcome);
        expect(frame).toContain(action);
      });
      ui.unmount();
    } finally {
      configStore.__testReset();
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
