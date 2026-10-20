import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSession } from '../../../src/core/sessions/io.js';
import { deriveRunStatus } from '../../../src/core/sessions/run-status.js';
import { loadState, saveState } from '../../../src/core/state/persistence.js';
import { stagedWorkspaceRoot } from '../../../src/engine/orchestrator/isolation/retention.js';
import { createSnapshot } from '../../../src/engine/snapshots/create.js';
import { makeWorkflowState, RUN_CREW } from '#testing/helpers/factories/workflow-state.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import { applyLiveRun, copyLiveArtifacts } from './live-harness.js';

describe('live run Apply', () => {
  it('applies the reviewed workspace and finalizes the copied publish summary', async () => {
    await withTempDir('live-apply', async (projectDir) => {
      const ref = { projectDir, sessionId: 'test-apply' };
      const base = await createSnapshot({ ...ref, phase: 'manual', name: 'baseline' });
      const workspace = join(stagedWorkspaceRoot(ref, `stage-${'a'.repeat(32)}`), 'workspace');
      mkdirSync(join(workspace, 'src'), { recursive: true });
      const artifact = 'export const liveEasy = "live-easy";\n';
      writeFileSync(join(workspace, 'src/live-easy.ts'), artifact);
      saveState(
        ref,
        makeWorkflowState({
          ...RUN_CREW,
          phase: 'complete',
          reviewStatus: 'passed',
          workspace: {
            kind: 'staged-copy',
            path: workspace,
            base: { snapshotId: base.manifest.id, head: null },
          },
        }),
      );
      expect(existsSync(join(projectDir, 'src/live-easy.ts'))).toBe(false);
      await applyLiveRun(ref);
      expect(readFileSync(join(projectDir, 'src/live-easy.ts'), 'utf-8')).toBe(artifact);
      const state = loadState(ref);
      if (state === null) throw new Error('missing applied state');
      expect(deriveRunStatus({ state, liveness: 'not-alive' })).toEqual({
        kind: 'closed',
        as: 'applied',
      });
      expect(readSession(ref)?.status).toBe('complete');
      const artifacts = copyLiveArtifacts({
        ...ref,
        rowId: 'publish-smoke',
        root: join(projectDir, '.test-artifacts'),
      });
      if (artifacts.summary === null) throw new Error('missing copied summary');
      expect(JSON.parse(readFileSync(artifacts.summary, 'utf-8'))).toMatchObject({
        status: 'complete',
        apply: 'applied',
      });
      expect(existsSync(workspace)).toBe(false);
    });
  });

  it('rejects a missing or unfinished run before evaluating an artifact', async () => {
    await withTempDir('live-not-ready', async (projectDir) => {
      const ref = { projectDir, sessionId: 'test-not-ready' };
      await expect(applyLiveRun(ref)).rejects.toThrow(/no saved state/);
      saveState(ref, makeWorkflowState({ ...RUN_CREW, phase: 'planning' }));
      await expect(applyLiveRun(ref)).rejects.toThrow(/ready-to-apply.*open/);
      expect(existsSync(join(projectDir, 'src/live-easy.ts'))).toBe(false);
    });
  });

  it('fails the row when Apply requires confirmation instead of applying', async () => {
    await withTempDir('live-apply-confirmation', async (projectDir) => {
      const ref = { projectDir, sessionId: 'test-confirmation' };
      const base = await createSnapshot({ ...ref, phase: 'manual', name: 'baseline' });
      const workspace = join(stagedWorkspaceRoot(ref, `stage-${'b'.repeat(32)}`), 'workspace');
      mkdirSync(workspace, { recursive: true });
      saveState(
        ref,
        makeWorkflowState({
          ...RUN_CREW,
          phase: 'complete',
          reviewStatus: 'failed',
          acceptedAsIs: { at: new Date().toISOString(), findings: ['review failed'] },
          workspace: {
            kind: 'staged-copy',
            path: workspace,
            base: { snapshotId: base.manifest.id, head: null },
          },
        }),
      );
      await expect(applyLiveRun(ref)).rejects.toThrow(/outcome is needs-confirmation/);
      expect(loadState(ref)?.applied).toBeUndefined();
      expect(existsSync(workspace)).toBe(true);
    });
  });
});
