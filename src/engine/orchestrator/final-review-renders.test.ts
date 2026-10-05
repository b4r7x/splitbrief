import { chmodSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeNoValidationConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { setupGitSessionProject } from '#testing/helpers/git-session.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { prependPath, trustedShimGate } from '#testing/helpers/command-shim.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import {
  passingReviewVerdict,
  planFromTasks,
  typedCallPlanAndReview,
} from '#testing/helpers/typed-planner.js';
import { createEvidenceLedger, withUpdatedTask } from '../../core/evidence/ledger-state.js';
import { writeEvidenceLedger } from '../../core/evidence/ledger-storage.js';
import { PLAN_FILE, sessionDir } from '../../core/paths.js';
import { writeSpecFile } from '../../core/paths-io.js';
import { sha256Hex } from '../../utils/sha256.js';
import type { TypedCallContext } from '../planners/types.js';
import {
  captureChangedFilesBaseline,
  serializeChangedFilesBaseline,
} from './changed-files-baseline.js';
import { currentCandidateId } from './evidence/record-checks.js';
import { runFinalReviewPhase } from './final-review.js';
import { NO_VISION_REVIEW } from './review-renders.js';
import { createCliPlanner } from '../planners/cli.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

describe('final review render delivery', () => {
  it.each([
    { withSinks: false, withImage: true },
    { withSinks: true, withImage: true },
    { withSinks: false, withImage: false },
    { withSinks: true, withImage: false },
  ])(
    'dispatches a required Codex render with sinks=$withSinks and image=$withImage',
    async ({ withSinks, withImage }) => {
      const { projectDir, sessionId } = setupGitSessionProject({
        prefix: 'final-review-renders',
        sessionId: 'sess-renders',
      });
      dirs.push(projectDir);
      const ref = { projectDir, sessionId };
      writeSpecFile(ref, PLAN_FILE, 'Render the dashboard.', null);
      const png = join(sessionDir(projectDir, sessionId), 'dashboard.png');
      const pngBytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1X8AAAAASUVORK5CYII=',
        'base64',
      );
      writeFileSync(png, pngBytes);
      const task = makeTask({ id: 'T001', status: 'done' });
      const baseline = await captureChangedFilesBaseline(projectDir);
      const candidateId = await currentCandidateId(projectDir, baseline);
      const state = makeImplState([task], {
        changedFilesBaseline: serializeChangedFilesBaseline(baseline),
        plan: {
          summary: 'Render the dashboard.',
          decisions: [],
          criteria: [{ id: 'C1', text: 'The dashboard is readable', checkIds: ['K1'] }],
          checks: [{ id: 'K1', kind: 'render', value: 'dashboard', required: true }],
          validation: null,
        },
      });
      const ledger = withUpdatedTask(
        createEvidenceLedger({ sessionId, feature: state.feature, tasks: [task] }),
        task.id,
        (entry) => ({
          ...entry,
          checks: [
            {
              id: 'K1',
              command: 'render dashboard',
              exitCode: 0,
              artifacts: [{ path: png, sha256: sha256Hex(pngBytes) }],
              workspaceSnapshotId: withImage ? candidateId : 'older-candidate',
              ts: '2026-10-06T03:00:00.000Z',
            },
          ],
        }),
      );
      writeEvidenceLedger(ref, ledger);
      const contexts: TypedCallContext[] = [];
      const prompts: string[] = [];
      const call = typedCallPlanAndReview(
        () => planFromTasks([]),
        (prompt) => {
          prompts.push(prompt);
          const verdict = passingReviewVerdict(prompt);
          return {
            ...verdict,
            criteria: verdict.criteria.map((criterion) => ({
              ...criterion,
              evidence: 'dashboard: labels are readable and columns align.',
            })),
          };
        },
      );
      const reviewer = makePlanner({
        typedCall: (ctx) => {
          contexts.push(ctx);
          return call(ctx);
        },
      });

      const result = await runFinalReviewPhase({
        ...ref,
        workspaceDir: projectDir,
        state,
        config: makeNoValidationConfig({ reviewer: { kind: 'cli', tool: 'codex' } }),
        reviewer,
        callbacks: makeCallbacks().callbacks,
        bus: makeBusRecorder().bus,
        ...(withSinks ? { sinks: { setAbortHandler: () => {}, setQueueHandler: () => {} } } : {}),
      });

      expect(result.reviewStatus).toBe('written');
      expect(contexts).toHaveLength(1);
      expect(contexts[0]).toMatchObject({ seat: 'reviewer', projectDir });
      expect(prompts).toHaveLength(1);
      if (withImage) {
        expect(contexts[0]?.images).toEqual([
          expect.objectContaining({
            path: realpathSync(png),
            kind: 'image',
            mimeType: 'image/png',
          }),
        ]);
        expect(prompts[0]).toContain('The rendered scenarios are attached as images.');
        expect(prompts[0]).toContain('Write one critique per rendered scenario');
        expect(prompts[0]).not.toContain(NO_VISION_REVIEW);
        expect(result.verdict?.outcome.kind).toBe('pass');
        expect(result.state.review?.verdict.criteria[0]?.evidence).toContain('dashboard:');
      } else {
        expect(contexts[0]?.images).toBeUndefined();
        expect(prompts[0]).toContain(NO_VISION_REVIEW);
        expect(prompts[0]).toContain('dashboard → no image produced');
        expect(result.verdict?.outcome.kind).toBe('fail');
        expect(result.verdict?.outcome.unverifiedCriteria).toEqual(['C1']);
        expect(result.state.review?.verdict.criteria[0]?.status).toBe('unverified');
      }
    },
  );

  it('hands the attached render to the Codex reviewer process as --image', async () => {
    const { projectDir, sessionId } = setupGitSessionProject({
      prefix: 'final-review-render-argv',
      sessionId: 'sess-render-argv',
    });
    dirs.push(projectDir);
    const ref = { projectDir, sessionId };
    writeSpecFile(ref, PLAN_FILE, 'Render the dashboard.', null);
    const png = join(sessionDir(projectDir, sessionId), 'dashboard.png');
    const pngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1X8AAAAASUVORK5CYII=',
      'base64',
    );
    writeFileSync(png, pngBytes);
    const task = makeTask({ id: 'T001', status: 'done' });
    const baseline = await captureChangedFilesBaseline(projectDir);
    const candidateId = await currentCandidateId(projectDir, baseline);
    const state = makeImplState([task], {
      changedFilesBaseline: serializeChangedFilesBaseline(baseline),
      plan: {
        summary: 'Render the dashboard.',
        decisions: [],
        criteria: [{ id: 'C1', text: 'The dashboard is readable', checkIds: ['K1'] }],
        checks: [{ id: 'K1', kind: 'render', value: 'dashboard', required: true }],
        validation: null,
      },
    });
    writeEvidenceLedger(
      ref,
      withUpdatedTask(
        createEvidenceLedger({ sessionId, feature: state.feature, tasks: [task] }),
        task.id,
        (entry) => ({
          ...entry,
          checks: [
            {
              id: 'K1',
              command: 'render dashboard',
              exitCode: 0,
              artifacts: [{ path: png, sha256: sha256Hex(pngBytes) }],
              workspaceSnapshotId: candidateId,
              ts: '2026-10-06T03:00:00.000Z',
            },
          ],
        }),
      ),
    );
    const shimDir = createTempDir('final-review-render-shim');
    dirs.push(shimDir);
    const argvFile = join(shimDir, 'argv.txt');
    const verdict = JSON.stringify({
      tasks: [{ id: 'T001', plan: 'met', note: '' }],
      criteria: [
        {
          id: 'C1',
          status: 'pass',
          evidence: 'dashboard: labels are readable and columns align.',
        },
      ],
      findings: [],
    });
    const line = (value: unknown): string =>
      `printf '%s\\n' '${JSON.stringify(value).replace(/'/g, "'\\''")}'`;
    writeFileSync(
      join(shimDir, 'codex'),
      [
        '#!/bin/bash',
        'cat > /dev/null',
        `printf '%s\\n' "$@" > '${argvFile}'`,
        line({ type: 'thread.started', thread_id: 'codex-review-thread' }),
        line({ type: 'item.completed', item: { type: 'agent_message', text: verdict } }),
        line({ type: 'turn.completed' }),
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(join(shimDir, 'codex'), 0o755);
    const restorePath = prependPath(shimDir);
    try {
      const reviewer = createCliPlanner({
        config: makeNoValidationConfig({ planner: { kind: 'cli', tool: 'codex' } }),
        trustedCli: trustedShimGate({ dir: shimDir, tool: 'codex' }),
      });

      const result = await runFinalReviewPhase({
        ...ref,
        workspaceDir: projectDir,
        state,
        config: makeNoValidationConfig({ reviewer: { kind: 'cli', tool: 'codex' } }),
        reviewer,
        callbacks: makeCallbacks().callbacks,
        bus: makeBusRecorder().bus,
      });

      expect(result.reviewStatus).toBe('written');
      const argv = readFileSync(argvFile, 'utf8').split('\n');
      expect(argv).toContain('--image');
      expect(argv[argv.indexOf('--image') + 1]).toBe(realpathSync(png));
    } finally {
      restorePath();
    }
  });
});
