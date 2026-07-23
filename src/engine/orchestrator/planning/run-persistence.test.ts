import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import {
  auto,
  prepareState,
  runPhase as runPhaseHelper,
  makePassingTask,
  makePassingPlanner,
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
    const config = makeConfig({ workflow: { ...auto('standard') } });
    const pinned = { ...prepareState(), mode: 'speckit' as const };
    const { projectDir, sessionId } = await runPhase({ config, state: pinned });

    const persisted = loadState({ projectDir, sessionId });
    expect(persisted?.mode).toBe('speckit');
  });
});

describe('runPlanningPhase — persistence', () => {
  it('writes artifact text (not raw stdout) to disk', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { sessionDir, SPEC_FILE, PLAN_FILE } = await import('../../../core/paths.js');
    const { join } = await import('node:path');

    const artifactSpec = '# Resolved Spec\n\nAdd authentication.\n';
    const artifactPlan = '# Resolved Plan\n\nUse JWT.\n';
    const plan = vi.fn().mockResolvedValue({
      spec: artifactSpec,
      plan: artifactPlan,
      tasks: [makePassingTask()],
      usage: { inputTokens: 100, outputTokens: 50 },
      phases: [
        { text: artifactSpec, filename: 'spec.md', rawOutput: 'raw planner noise for spec' },
        { text: artifactPlan, filename: 'plan.md', rawOutput: 'raw planner noise for plan' },
      ],
    });

    const { projectDir, sessionId } = await runPhase({
      planner: makePassingPlanner({ plan }),
      config: makeConfig({ workflow: auto() }),
    });

    const specPath = join(sessionDir(projectDir, sessionId), SPEC_FILE);
    const planPath = join(sessionDir(projectDir, sessionId), PLAN_FILE);
    expect(existsSync(specPath)).toBe(true);
    expect(existsSync(planPath)).toBe(true);
    expect(readFileSync(specPath, 'utf-8')).toContain('Add authentication');
    expect(readFileSync(specPath, 'utf-8')).not.toContain('raw planner noise');
    expect(readFileSync(planPath, 'utf-8')).toContain('Use JWT');
    expect(readFileSync(planPath, 'utf-8')).not.toContain('raw planner noise');
  });
});
