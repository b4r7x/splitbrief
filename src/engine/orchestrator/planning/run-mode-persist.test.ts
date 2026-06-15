import { describe, it, expect, afterEach } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  auto,
  prepareState,
  runPhase as runPhaseHelper,
  type RunOpts,
} from '#testing/helpers/planning-phase.js';
import { loadState } from '../../../core/state/persistence.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function runPhase(opts: RunOpts = {}) {
  return runPhaseHelper(dirs, opts);
}

describe('runPlanningPhase — mode persistence', () => {
  it('stamps the resolved mode and approve level onto persisted state', async () => {
    const config = makeConfig({ workflow: { ...auto('speckit') } });
    const { projectDir, sessionId } = await runPhase({ config });

    const persisted = loadState({ projectDir, sessionId });
    expect(persisted?.mode).toBe('speckit');
    expect(persisted?.approve).toBe('none');
  });

  it('reuses a saved mode over the current config default', async () => {
    // Config says 'standard' but the resumed state already pins 'speckit'; the saved
    // value must win and remain persisted.
    const config = makeConfig({ workflow: { ...auto('standard') } });
    const pinned = { ...prepareState(), mode: 'speckit' as const };
    const { projectDir, sessionId } = await runPhase({ config, state: pinned });

    const persisted = loadState({ projectDir, sessionId });
    expect(persisted?.mode).toBe('speckit');
  });
});
