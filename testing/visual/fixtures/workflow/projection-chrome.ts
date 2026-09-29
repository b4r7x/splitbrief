import { PhaseSchema, type Phase } from '../../../../src/core/schemas/enums.js';
import { getWorkflowFixturePromptRows, type WorkflowFixtureProjection } from './projections.js';

// The phase the screen is in at the checkpoint: the last event that carries one.
export function checkpointPhase(projection: WorkflowFixtureProjection): Phase {
  for (let index = projection.events.length - 1; index >= 0; index -= 1) {
    const parsed = PhaseSchema.safeParse(projection.events[index]?.phase);
    if (parsed.success) return parsed.data;
  }
  return 'idle';
}

export interface WorkflowProjectionChromeFacts {
  readonly phase: Phase;
  readonly cancelled: boolean;
  readonly halted: boolean;
  readonly promptRows: number;
  readonly atRest: boolean;
}

/**
 * The chrome facts the workflow page computes from its stores (`src/app/screens/workflow.tsx`) and
 * the snapshot reads back from the same facts (`src/features/workflow/layout/snapshot.ts`), here
 * derived from the fixture projection the page was mounted from. `getProgressRows` decides the
 * build block's rows and therefore every body rect from these, so the gallery's crop locators ask
 * the question the screen asked instead of inventing a narrower one. The stop menu is the one fact
 * a projection cannot carry — it opens on a keypress — but no screen scenario that declares a
 * transcript element parks with it open.
 */
export function projectionChromeFacts(
  projection: WorkflowFixtureProjection,
  cols: number,
): WorkflowProjectionChromeFacts {
  return {
    phase: checkpointPhase(projection),
    // `workflow_cancelled` is what sets the lifecycle's cancelled flag; nothing else does.
    cancelled: projection.events.some((event) => event.type === 'workflow_cancelled'),
    // A saved halt is the only recovery notice a fixture resumes into.
    halted: projection.resumeState?.pendingRecovery !== undefined,
    promptRows: getWorkflowFixturePromptRows(projection, cols),
    atRest: projection.atRest !== undefined,
  };
}
