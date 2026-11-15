import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import type { Config } from '../../../../core/schemas/config.js';
import type { WorkflowState } from '../../../../core/schemas/workflow/state.js';
import { ensureSessionDir } from '../../../../core/sessions/spec-files.js';
import { createInitialState } from '../../../../core/state/machine.js';
import {
  seatIdentitiesFromConfig,
  writeSeatIdentities,
} from '../../../../core/state/seats/record.js';
import { createEventBus } from '../../../events/bus.js';
import type { EngineEvent } from '../../../events/types.js';
import { NULL_CACHE } from '../../../providers/model/runtime-snapshot.js';
import { settleSavedState } from './saved-state.js';

const PLANNER = { kind: 'cli', tool: 'codex', model: 'gpt-5' } as const;
const IMPLEMENTER = { kind: 'cli', tool: 'opencode', model: 'deepseek/deepseek-flash' } as const;
const RECORDED = makeConfig({ planner: PLANNER, implementer: IMPLEMENTER });

async function resumeOn(projectDir: string, config: Config) {
  const ref = { projectDir, sessionId: 'resume-seat-record' };
  ensureSessionDir(projectDir, ref.sessionId);
  writeSeatIdentities(ref, seatIdentitiesFromConfig(RECORDED));
  const bus = createEventBus();
  const events: EngineEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const tracked: { current: WorkflowState | undefined } = { current: undefined };
  const settled = await settleSavedState({
    ...ref,
    bus,
    config,
    modelCache: NULL_CACHE,
    savedState: {
      ...createInitialState('resume the run'),
      phase: 'implementing',
      plannerSessionId: 'session-of-the-recorded-planner',
    },
    setTrackedState: (state) => {
      tracked.current = state;
    },
    signal: undefined,
  });
  return { settled, events, tracked };
}

describe('settleSavedState', () => {
  it('reads a moved plan seat as planSeatChanged and drops the session of the planner that left', async () => {
    await withTempDir('splitbrief-saved-state-plan-moved', async (projectDir) => {
      const { settled, events, tracked } = await resumeOn(
        projectDir,
        makeConfig({
          planner: { kind: 'cli', tool: 'claude-code', model: 'opus' },
          implementer: IMPLEMENTER,
        }),
      );

      expect(settled.planSeatChanged).toBe(true);
      expect(settled.savedState?.plannerSessionId).toBeNull();
      expect(tracked.current?.plannerSessionId).toBeNull();
      expect(
        events.filter((event) => event.type === 'seat_switched').map((event) => event.seat),
      ).toContain('plan');
    });
  });

  it('keeps planSeatChanged false and the planner session when only the BUILD seat moved', async () => {
    await withTempDir('splitbrief-saved-state-build-moved', async (projectDir) => {
      const { settled, events } = await resumeOn(
        projectDir,
        makeConfig({
          planner: PLANNER,
          implementer: { kind: 'cli', tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' },
        }),
      );

      expect(settled.planSeatChanged).toBe(false);
      expect(settled.savedState?.plannerSessionId).toBe('session-of-the-recorded-planner');
      expect(
        events.filter((event) => event.type === 'seat_switched').map((event) => event.seat),
      ).toEqual(['build']);
    });
  });
});
