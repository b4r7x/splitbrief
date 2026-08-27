import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { taskId } from '../../../core/schemas/task.js';
import { BRIEF_READINESS_FILE, sessionDir } from '../../../core/paths.js';
import { DEFAULT_UNKNOWN_CONTEXT_LENGTH } from '../../../core/tokens/context-length.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import type { BriefReadinessBlockKind, BriefReadinessGateReport } from './brief-readiness-gate.js';
import {
  evaluateBriefReadiness,
  formatBriefReadinessBlocks,
  runBriefReadinessGate,
  runBriefReadinessGateAndReport,
} from './brief-readiness-gate.js';

function readyTask() {
  return makeTask({
    id: 'T001',
    evidence: ['proof is recorded'],
    scope: { inBounds: ['src/hello.ts'], outOfBounds: [] },
  });
}

const CACHE_CONTEXT_LENGTH = 200_000;
const DETECTED_CONTEXT_LENGTH = 120_000;

// Overflows DEFAULT_UNKNOWN_CONTEXT_LENGTH (~48k estimated tokens) but fits either
// routing-resolved window, so the resolved window alone decides blocked vs unblocked.
function oversizedTask() {
  return makeTask({
    id: 'T001',
    description: 'implement the oversized packet. '.repeat(6000),
    evidence: ['proof is recorded'],
    scope: { inBounds: ['src/hello.ts'], outOfBounds: [] },
  });
}

const LOCAL_AGENT_PROFILE = {
  kind: 'agent',
  command: 'local-worker',
  model: 'local-model',
  costTier: 'cheap',
} as const;

function blockedReport(kinds: BriefReadinessBlockKind[]): BriefReadinessGateReport {
  const blocks = kinds.map((kind, index) => ({
    taskId: taskId(`T${String(index + 1).padStart(3, '0')}`),
    kind,
    message: 'blocked',
    nextAction: 'act now',
  }));
  return {
    ok: false,
    metadata: blocks.map((block) => ({ taskId: block.taskId })),
    blocks,
  };
}

describe('evaluateBriefReadiness', () => {
  it.each([
    [
      'overflow',
      {
        taskId: taskId('T001'),
        contextFit: 'overflow' as const,
        estimatedTokens: 50_000,
        contextLength: 8_000,
      },
      'split the task or route it to a larger worker',
    ],
    [
      'no-capable-worker',
      {
        taskId: taskId('T001'),
        contextFit: 'fits' as const,
        estimatedTokens: 500,
        routingBlockKind: 'no-capable-worker' as const,
      },
      'route a larger worker or split the task',
    ],
    [
      'stale-conflict',
      {
        taskId: taskId('T001'),
        contextFit: 'fits' as const,
        workerProfile: 'local',
        estimatedTokens: 500,
        stale: true,
      },
      'resolve the conflict or revise the brief with current code context',
    ],
  ])('blocks %s with a next action', (kind, metadata, nextAction) => {
    const task = readyTask();
    const report = evaluateBriefReadiness([task], [metadata]);

    expect(report.ok).toBe(false);
    expect(report.blocks[0]).toMatchObject({ kind, taskId: 'T001', nextAction });
    expect(formatBriefReadinessBlocks(report)).toContain('Next best action');
  });

  it('passes when routing metadata is refreshed and complete', () => {
    const task = readyTask();
    const report = evaluateBriefReadiness(
      [task],
      [
        {
          taskId: task.id,
          contextFit: 'fits',
          workerProfile: 'local',
          estimatedTokens: 500,
          contextLength: 32_000,
        },
      ],
    );

    expect(report.ok).toBe(true);
    expect(report.blocks).toHaveLength(0);
  });

  it('still blocks a genuine user-edit conflict', () => {
    const task = readyTask();
    const report = evaluateBriefReadiness(
      [task],
      [
        {
          taskId: task.id,
          contextFit: 'fits',
          workerProfile: 'local',
          estimatedTokens: 500,
          conflict: { kind: 'current-task-conflict', files: ['src/hello.ts'] },
        },
      ],
    );

    expect(report.ok).toBe(false);
    expect(report.blocks[0]).toMatchObject({ taskId: 'T001', kind: 'stale-conflict' });
  });
});

describe('formatBriefReadinessBlocks', () => {
  it('names every blocking task kind with its count, sorted by descending count then kind name', () => {
    const report = blockedReport([
      'no-capable-worker',
      'stale-conflict',
      'no-capable-worker',
      'overflow',
    ]);
    const message = formatBriefReadinessBlocks(report);

    expect(message).toContain('4 of 4 tasks blocked');
    expect(message).toContain('no-capable-worker (2)');
    expect(message).toContain('overflow (1)');
    expect(message).toContain('stale-conflict (1)');
    expect(message.indexOf('no-capable-worker (2)')).toBeLessThan(message.indexOf('overflow (1)'));
    expect(message.indexOf('overflow (1)')).toBeLessThan(message.indexOf('stale-conflict (1)'));
  });

  it('caps the blocked-task-id list at eight ids and reports the remainder', () => {
    const report = blockedReport(Array(10).fill('overflow'));
    const message = formatBriefReadinessBlocks(report);

    expect(message).toContain('T001, T002, T003, T004, T005, T006, T007, T008');
    expect(message).not.toContain('T009');
    expect(message).toContain('(+2 more)');
  });

  it('returns an empty string for an unblocked report', () => {
    expect(formatBriefReadinessBlocks({ ok: true, metadata: [], blocks: [] })).toBe('');
  });
});

describe('runBriefReadinessGateAndReport', () => {
  const sessionId = 'sess-readiness';
  let projectDir: string;

  afterEach(() => {
    cleanupTempDir(projectDir);
  });

  it('writes a passing artifact and publishes brief_readiness_passed with the task count', async () => {
    projectDir = createTempDir('readiness-gate');
    ensureSessionDir(projectDir, sessionId);
    const { bus, events } = makeBusRecorder();

    const report = await runBriefReadinessGateAndReport({
      tasks: [readyTask()],
      config: makeConfig(),
      projectDir,
      sessionId,
      bus,
      phase: 'reviewing-briefs',
    });

    expect(report.ok).toBe(true);
    const artifact = JSON.parse(
      readFileSync(join(sessionDir(projectDir, sessionId), BRIEF_READINESS_FILE), 'utf-8'),
    );
    expect(artifact).toMatchObject({ ok: true });
    expect(artifact.blocks).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'brief_readiness_passed', taskCount: 1 }),
    );
  });

  it('writes the blocked artifact before publishing, and the event carries every blocked task id and kind', async () => {
    projectDir = createTempDir('readiness-gate');
    ensureSessionDir(projectDir, sessionId);
    mkdirSync(join(projectDir, 'src'));
    const { bus, events } = makeBusRecorder();
    let artifactAtPublish = false;
    bus.subscribe((event) => {
      if (event.type === 'brief_readiness_blocked') {
        artifactAtPublish = existsSync(
          join(sessionDir(projectDir, sessionId), BRIEF_READINESS_FILE),
        );
      }
    });

    const report = await runBriefReadinessGateAndReport({
      tasks: [
        makeTask({ id: 'T001', action: 'modify', file: 'src' }),
        makeTask({ id: 'T002', action: 'modify', file: 'src' }),
      ],
      config: makeConfig(),
      projectDir,
      sessionId,
      bus,
      phase: 'reviewing-briefs',
    });

    expect(report.ok).toBe(false);
    expect(report.blocks).toHaveLength(2);
    expect(artifactAtPublish).toBe(true);
    const artifact = JSON.parse(
      readFileSync(join(sessionDir(projectDir, sessionId), BRIEF_READINESS_FILE), 'utf-8'),
    );
    expect(artifact.ok).toBe(false);
    expect(artifact.blocks).toHaveLength(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'brief_readiness_blocked',
        taskCount: 2,
        blockedCount: 2,
        blockedTaskIds: ['T001', 'T002'],
        kinds: ['stale-conflict'],
      }),
    );
  });
});

describe('runBriefReadinessGate', () => {
  let projectDir: string;

  afterEach(() => {
    cleanupTempDir(projectDir);
  });

  it('does not block a create-then-modify chain over files absent from disk', async () => {
    projectDir = createTempDir('readiness-gate');
    const report = await runBriefReadinessGate({
      tasks: [
        makeTask({ id: 'T001', action: 'create', file: 'src/hello.ts' }),
        makeTask({ id: 'T002', action: 'modify', file: 'src/hello.ts' }),
      ],
      config: makeConfig(),
      projectDir,
    });

    expect(report.ok).toBe(true);
    expect(report.blocks).toEqual([]);
    const modifyMetadata = report.metadata.find((item) => item.taskId === 'T002');
    expect(modifyMetadata?.estimateStatus).toBe('pending-earlier-task');
  });

  it('does not block a modify target that is simply missing, while metadata still flags it', async () => {
    projectDir = createTempDir('readiness-gate');
    const report = await runBriefReadinessGate({
      tasks: [makeTask({ id: 'T001', action: 'modify', file: 'src/hello.ts' })],
      config: makeConfig(),
      projectDir,
    });

    expect(report.ok).toBe(true);
    expect(report.blocks).toEqual([]);
    expect(report.metadata[0]?.estimateStatus).toBe('missing-current-code');
  });

  it('still blocks a modify target whose current code cannot be read for a non-ENOENT reason', async () => {
    projectDir = createTempDir('readiness-gate');
    mkdirSync(join(projectDir, 'src'));
    const report = await runBriefReadinessGate({
      tasks: [makeTask({ id: 'T001', action: 'modify', file: 'src' })],
      config: makeConfig(),
      projectDir,
    });

    expect(report.ok).toBe(false);
    expect(report.blocks[0]).toMatchObject({ taskId: 'T001', kind: 'stale-conflict' });
  });

  it('unblocks an oversized brief at the model cache window and blocks it at the conservative fallback without the cache', async () => {
    projectDir = createTempDir('readiness-gate');
    const tasks = [oversizedTask()];
    const config = makeConfig({
      implementerProfiles: {
        default: 'local-agent',
        profiles: {
          'local-agent': LOCAL_AGENT_PROFILE,
          'catalog-api': {
            kind: 'api',
            provider: 'openrouter',
            apiBase: 'https://openrouter.ai/api/v1',
            apiKey: 'test-key',
            model: 'runtime-wide',
            costTier: 'standard',
          },
        },
      },
    });

    const routed = await runBriefReadinessGate({
      tasks,
      config,
      projectDir,
      modelCache: makeModelCacheAccessor({
        providerModels: {
          openrouter: [{ id: 'runtime-wide', contextLength: CACHE_CONTEXT_LENGTH }],
        },
      }),
      detectedContextLength: 4_096,
    });
    const unrouted = await runBriefReadinessGate({ tasks, config, projectDir });

    expect(routed.ok).toBe(true);
    expect(routed.blocks).toEqual([]);
    expect(routed.metadata[0]).toMatchObject({
      taskId: 'T001',
      workerProfile: 'catalog-api',
      contextFit: 'fits',
      contextLength: CACHE_CONTEXT_LENGTH,
    });
    expect(unrouted.ok).toBe(false);
    expect(unrouted.blocks[0]).toMatchObject({ taskId: 'T001', kind: 'overflow' });
    expect(unrouted.metadata[0]?.contextLength).toBe(DEFAULT_UNKNOWN_CONTEXT_LENGTH);
  });

  it('unblocks an oversized brief at the detected window and blocks it at the conservative fallback without it', async () => {
    projectDir = createTempDir('readiness-gate');
    const tasks = [oversizedTask()];
    const config = makeConfig({
      implementerProfiles: {
        default: 'local-agent',
        profiles: { 'local-agent': LOCAL_AGENT_PROFILE },
      },
    });

    const routed = await runBriefReadinessGate({
      tasks,
      config,
      projectDir,
      detectedContextLength: DETECTED_CONTEXT_LENGTH,
    });
    const unrouted = await runBriefReadinessGate({ tasks, config, projectDir });

    expect(routed.ok).toBe(true);
    expect(routed.metadata[0]).toMatchObject({
      taskId: 'T001',
      workerProfile: 'local-agent',
      contextFit: 'fits',
      contextLength: DETECTED_CONTEXT_LENGTH,
    });
    expect(unrouted.ok).toBe(false);
    expect(unrouted.blocks[0]).toMatchObject({ taskId: 'T001', kind: 'overflow' });
    expect(unrouted.metadata[0]?.contextLength).toBe(DEFAULT_UNKNOWN_CONTEXT_LENGTH);
  });
});
