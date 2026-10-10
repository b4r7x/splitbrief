import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeImplState } from '#testing/helpers/factories/workflow-state.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createRunIsolation } from './create.js';
import { publishRetainedWorkspaceNotice, readWorkspaceRecord } from './retention.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) cleanupTempDir(dir);
});

describe('retained workspace handoff', () => {
  it.each(['stop', 'failure', 'ready', 'closed', 'not-retained', 'no-workspace'] as const)(
    'publishes a successful retention notice only for a continuable %s',
    async (outcome) => {
      const projectDir = createTempDir('retention-handoff');
      dirs.push(projectDir);
      writeFileSync(join(projectDir, 'source.txt'), 'original\n');
      const ref = { projectDir, sessionId: 'retention-handoff' };
      const isolation = createRunIsolation({
        ...ref,
        strategy: 'staged-copy',
        onFallback: () => {},
      });
      const workspace = await isolation.acquire({ role: 'implementer', config: makeConfig() });
      if (outcome !== 'not-retained') await workspace.retain?.();
      await isolation.dispose();
      const record = await readWorkspaceRecord(ref);
      expect(record?.retained).toBe(outcome !== 'not-retained');
      const state = makeImplState([], {
        ...(outcome !== 'no-workspace' && {
          workspace: {
            kind: 'staged-copy',
            path: workspace.projectDir,
            base: { snapshotId: 'workspace-base', head: null },
          },
        }),
        ...(outcome === 'failure' && {
          lastFailure: {
            message: 'call failed',
            step: { kind: 'review', cycle: 0 },
            at: '2026-10-10T00:00:00.000Z',
          },
        }),
        ...(outcome === 'ready' && { phase: 'complete', reviewStatus: 'passed' }),
        ...(outcome === 'closed' && { closed: { as: 'ended', at: '2026-10-10T00:00:00.000Z' } }),
      });
      const { bus, events } = makeBusRecorder();
      await publishRetainedWorkspaceNotice({ ...ref, state, bus });
      const messages = events.flatMap((event) => (event.type === 'warning' ? [event.message] : []));
      expect(messages).toEqual(
        outcome === 'stop' || outcome === 'failure'
          ? [
              `Workspace kept at ${workspace.projectDir} for Continue, with its private CLI state and caches.`,
            ]
          : [],
      );
    },
  );
});
