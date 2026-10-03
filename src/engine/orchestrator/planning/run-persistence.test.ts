import { describe, it, expect, afterEach } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { auto, runPlanningTurn, type RunOpts } from '#testing/helpers/planning-phase.js';
import { readSpecFileOrEmpty } from '../../../core/paths-io.js';
import { PLAN_FILE, PLAN_JSON_FILE, TASKS_FILE } from '../../../core/paths.js';
import { parsePlanJson } from '../../../core/sessions/plan-file.js';
import { loadState } from '../../../core/state/persistence.js';
import type { EngineEvent } from '../../events/types.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function runTurn(opts: RunOpts = {}) {
  return runPlanningTurn(dirs, opts);
}

describe('runPlanningPhase — approval persistence', () => {
  it('stamps the resolved approve level onto persisted state', async () => {
    const { projectDir, sessionId } = await runTurn({ config: makeConfig({ workflow: auto() }) });

    expect(loadState({ projectDir, sessionId })?.approve).toBe('none');
  });
});

describe('runPlanningPhase — persistence', () => {
  it('saves the plan as plan.json and renders plan.md and tasks.md from it', async () => {
    const { result, projectDir, sessionId, events } = await runTurn({
      config: makeConfig({ workflow: auto() }),
    });
    const ref = { projectDir, sessionId };

    expect(result.disposition).toBe('ready-for-tasks');
    expect(parsePlanJson(readSpecFileOrEmpty(ref, PLAN_JSON_FILE))).toMatchObject({
      plan: { tasks: [{ id: 'T001' }] },
    });
    expect(readSpecFileOrEmpty(ref, PLAN_FILE)).toContain('Plan from the scripted briefs');
    expect(readSpecFileOrEmpty(ref, TASKS_FILE)).toContain('title: Create hello module');
    expect(
      events.flatMap((event) => (event.type === 'artifact_written' ? [event.filename] : [])),
    ).toEqual([PLAN_FILE, TASKS_FILE]);
  });
});

/** The excerpt of every tasks.md card the transcript would draw, in order. */
function briefCards(events: readonly EngineEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === 'artifact_written' && event.filename === TASKS_FILE
      ? [event.excerpt.join('\n')]
      : [],
  );
}

describe('runPlanningPhase — the Task Brief card', () => {
  it('announces tasks.md once with the compiled briefs', async () => {
    const { result, projectDir, sessionId, events } = await runTurn({
      config: makeConfig({ workflow: auto() }),
    });

    expect(result.disposition).toBe('ready-for-tasks');
    expect(briefCards(events)).toEqual([expect.stringContaining('Create hello module')]);
    expect(readSpecFileOrEmpty({ projectDir, sessionId }, TASKS_FILE)).toContain(
      'title: Create hello module',
    );
  });
});
