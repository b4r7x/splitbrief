import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Box, Text } from 'ink';
import { renderFeature } from '#testing/helpers/ink.js';
import { stripAnsiStyles } from '#testing/helpers/ansi.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import {
  BRIEF_QUALITY_FILE,
  BRIEF_READINESS_FILE,
  STATE_FILE,
  TASKS_FILE,
} from '../../../../core/paths.js';
import {
  type BriefRecoveryProjectionV1,
  BriefRecoveryProjectionV1Schema,
} from '../../../../core/schemas/brief-recovery/document.js';
import { createInitialState } from '../../../../core/state/machine.js';
import { createBriefRecoveryState } from '../../../../engine/orchestrator/planning/brief-recovery.js';
import { formatTasks } from '../../../../engine/spec/formatter.js';
import type { LoadBriefReviewDataResult } from '../../brief-review-loader.js';
import { reviewStore } from '../../../../stores/workflow/review.js';
import { PlanReviewHeader } from './header.js';
import { BriefReviewView } from './view.js';
import { useBriefData, type BriefDataLoader } from './use-load-state.js';

const itUnix = process.platform === 'win32' ? it.skip : it;
const tmpDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = createTempDir(prefix);
  tmpDirs.push(dir);
  return dir;
}

function writeTasks(dir: string): string {
  const filePath = join(dir, TASKS_FILE);
  writeFileSync(filePath, formatTasks([makeTask({ id: 'T001', title: 'Blocked brief' })]), 'utf8');
  return filePath;
}

function writeBlockingReadiness(dir: string): void {
  writeFileSync(
    join(dir, BRIEF_READINESS_FILE),
    JSON.stringify({
      ok: false,
      metadata: [],
      blocks: [
        {
          taskId: 'T001',
          kind: 'overflow',
          message: 'Task T001 overflows the selected worker context',
          nextAction: 'split the task or route it to a larger worker',
        },
      ],
    }),
    'utf8',
  );
}

function writePersistedBlockedState(dir: string): void {
  const sessionId = basename(dir);
  const hash = 'b'.repeat(64);
  const state = {
    ...createInitialState('persisted projection fixture'),
    stateRevision: 4,
    stateFence: { token: 1, ownerId: 'use-load-state-test' },
    phase: 'reviewing-briefs' as const,
    briefRecovery: createBriefRecoveryState(
      {
        sessionId,
        origin: { mode: 'standard', entry: 'initial' },
        continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
        activeBrief: { revision: 2, hash, path: TASKS_FILE },
        report: {
          briefHash: hash,
          report: { revision: 2, hash: 'r'.repeat(64), path: BRIEF_QUALITY_FILE },
          ruleVersion: 'brief-quality-v1',
          issues: [
            {
              code: 'empty_task_list',
              severity: 'error' as const,
              taskId: null,
              message: 'current persisted contract issue',
            },
          ],
          errorCount: 1,
        },
        qualityPolicyVersion: 'brief-quality-v1',
      },
      { epochId: 'epoch-1', recoveryRevision: 2 },
    ),
  };
  writeFileSync(join(dir, STATE_FILE), JSON.stringify(state), 'utf8');
}

function recoveryProjection(status: BriefRecoveryProjectionV1['status'] = 'blocked') {
  const hash = 'brief-hash';
  const issue = {
    code: 'empty_task_list',
    severity: 'error',
    taskId: null,
    message: 'current persisted contract issue',
  } as const;
  const ready = status === 'ready';
  return BriefRecoveryProjectionV1Schema.parse({
    version: 1,
    sessionId: 'session-1',
    stateRevision: 4,
    recoveryRevision: 2,
    epochId: 'epoch-1',
    status,
    origin: { mode: 'standard', entry: 'initial' },
    continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
    activeBrief: { revision: 2, hash, path: TASKS_FILE },
    matchingReport: {
      briefHash: hash,
      report: { revision: 2, hash: 'report-hash', path: BRIEF_READINESS_FILE },
      ruleVersion: 'brief-quality-v1',
      issues: ready ? [] : [issue],
    },
    blocker: ready ? null : { kind: 'quality', issues: [issue] },
    allowedActions: ready ? ['approve', 'edit', 'reject', 'revise'] : ['retry', 'edit', 'reject'],
    activeOperation: null,
    latestAttempt: null,
    queuedInputs: { ids: [], count: 0, carriedCount: 0, heldCount: 0, releasedCount: 0 },
  });
}

function projectedResult(projection: BriefRecoveryProjectionV1): LoadBriefReviewDataResult {
  return {
    tasks: [makeTask({ id: 'T001', title: 'Current task' })],
    quality: {
      version: 1 as const,
      passed: true,
      score: 1,
      issues: [],
    },
    readiness: null,
    reviewMetadata: new Map(),
    briefSources: ['current brief'],
    recovery: projection,
  };
}

function Harness({ filePath }: { filePath: string }) {
  const { tasks, quality, readiness } = useBriefData(filePath);
  const loadError = reviewStore.use((state) => state.loadError);
  return (
    <Box flexDirection="column">
      <PlanReviewHeader
        tasks={tasks}
        quality={quality}
        readiness={readiness}
        filePath={filePath}
        width={100}
        hasLoadError={loadError !== null}
      />
      <Text>{loadError === null ? 'load: ok' : 'load: failed'}</Text>
    </Box>
  );
}

describe('useBriefData', () => {
  beforeEach(() => {
    resetAllStores();
  });

  afterEach(() => {
    resetAllStores();
    for (const dir of tmpDirs.splice(0)) cleanupTempDir(dir);
  });

  it('carries the loaded readiness report to the header', async () => {
    const dir = tempDir('brief-data-report');
    const filePath = writeTasks(dir);
    writeBlockingReadiness(dir);

    const ui = renderFeature(<Harness filePath={filePath} />);
    try {
      await vi.waitFor(() => {
        const frame = stripAnsiStyles(ui.lastFrame());
        expect(frame).toContain('readiness 1 blocked');
        expect(frame).toContain('approve again overrides');
        expect(frame).toContain('load: ok');
      });
    } finally {
      ui.unmount();
    }
  });

  itUnix('reports a link-attacked brief artifact as a load error, claiming no blocks', async () => {
    const dir = tempDir('brief-data-linked-brief');
    const outside = tempDir('brief-data-outside-brief');
    writeTasks(outside);
    writeBlockingReadiness(dir);
    const filePath = join(dir, TASKS_FILE);
    symlinkSync(join(outside, TASKS_FILE), filePath);

    const ui = renderFeature(<Harness filePath={filePath} />);
    try {
      await vi.waitFor(() => {
        expect(stripAnsiStyles(ui.lastFrame())).toContain('load: failed');
      });
      const frame = stripAnsiStyles(ui.lastFrame());
      expect(frame).not.toContain('blocked');
      expect(frame).not.toContain('approve again overrides');
    } finally {
      ui.unmount();
    }
  });

  itUnix(
    'reports a link-attacked readiness artifact as a load error, claiming no blocks',
    async () => {
      const dir = tempDir('brief-data-linked-report');
      const outside = tempDir('brief-data-outside-report');
      writeBlockingReadiness(outside);
      const filePath = writeTasks(dir);
      symlinkSync(join(outside, BRIEF_READINESS_FILE), join(dir, BRIEF_READINESS_FILE));

      const ui = renderFeature(<Harness filePath={filePath} />);
      try {
        await vi.waitFor(() => {
          expect(stripAnsiStyles(ui.lastFrame())).toContain('load: failed');
        });
        const frame = stripAnsiStyles(ui.lastFrame());
        expect(frame).not.toContain('blocked');
        expect(frame).not.toContain('approve again overrides');
      } finally {
        ui.unmount();
      }
    },
  );

  it('uses the current persisted projection instead of stale quality artifacts', async () => {
    const dir = tempDir('brief-data-current-projection');
    const filePath = writeTasks(dir);
    writePersistedBlockedState(dir);
    writeFileSync(
      join(dir, BRIEF_QUALITY_FILE),
      JSON.stringify({
        version: 1,
        passed: false,
        score: 0,
        issues: [
          {
            taskId: 'T001',
            severity: 'error',
            code: 'missing_scope',
            message: 'stale artifact issue',
          },
        ],
      }),
      'utf8',
    );

    function ProjectionHarness() {
      const data = useBriefData(filePath);
      return (
        <Text>
          {data.recovery?.status ?? 'none'}|{data.quality?.issues[0]?.message ?? 'no issue'}
        </Text>
      );
    }

    reviewStore.setReviewFile(filePath);
    const ui = renderFeature(<ProjectionHarness />);
    try {
      await vi.waitFor(() => {
        expect(stripAnsiStyles(ui.lastFrame())).toContain(
          'blocked|current persisted contract issue',
        );
      });
      expect(stripAnsiStyles(ui.lastFrame())).not.toContain('stale artifact issue');
    } finally {
      ui.unmount();
    }
  });

  it('does not let a late projection replace a newer owner revision', async () => {
    const dir = tempDir('brief-data-stale-projection');
    const filePath = writeTasks(dir);
    const firstProjection = recoveryProjection('checking');
    const currentProjection = recoveryProjection('ready');
    let resolveFirst: ((value: LoadBriefReviewDataResult) => void) | undefined;
    let current: BriefDataLoader = () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      });
    const load: BriefDataLoader = (options) => current(options);

    function ProjectionHarness() {
      const data = useBriefData(filePath, load);
      return <Text>{data.recovery?.status ?? 'none'}</Text>;
    }

    reviewStore.setReviewFile(filePath);
    const ui = renderFeature(<ProjectionHarness />);
    try {
      await vi.waitFor(() => expect(resolveFirst).toBeTypeOf('function'));
      reviewStore.reloadReviewFile();
      current = async () => projectedResult(currentProjection);
      await vi.waitFor(() => expect(stripAnsiStyles(ui.lastFrame())).toContain('ready'));
      resolveFirst?.({ ...projectedResult(firstProjection) });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(stripAnsiStyles(ui.lastFrame())).toContain('ready');
      expect(stripAnsiStyles(ui.lastFrame())).not.toContain('checking');
    } finally {
      ui.unmount();
    }
  });

  it('renders an explicit loading state without recovery actions while the brief is pending', async () => {
    const dir = tempDir('brief-data-loading');
    const filePath = writeTasks(dir);
    let resolveLoad: ((value: LoadBriefReviewDataResult) => void) | undefined;
    const load: BriefDataLoader = () =>
      new Promise((resolve) => {
        resolveLoad = resolve;
      });

    reviewStore.setReviewFile(filePath);
    const ui = renderFeature(
      <BriefReviewView
        filePath={filePath}
        height={16}
        width={80}
        recovery={recoveryProjection('blocked')}
        load={load}
      />,
    );
    try {
      await vi.waitFor(() => expect(resolveLoad).toBeTypeOf('function'));
      const loadingFrame = stripAnsiStyles(ui.lastFrame());
      expect(loadingFrame).toContain('loading briefs');
      expect(loadingFrame).not.toContain('NOW retry');
      expect(loadingFrame).not.toContain('NOW approve');

      resolveLoad?.(projectedResult(recoveryProjection('blocked')));
      await vi.waitFor(() => {
        expect(stripAnsiStyles(ui.lastFrame())).toContain('CONTRACT BLOCKED');
      });
    } finally {
      ui.unmount();
    }
  });
});
