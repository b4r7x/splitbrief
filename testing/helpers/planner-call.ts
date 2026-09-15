import { buildLanguageContext } from '../../src/engine/spec/prompts/language-context.js';
import type {
  PhaseCallResult,
  PhaseInputs,
  Planner,
  PlannerCallbacks,
  PlannerDocumentCall,
} from '../../src/engine/planners/types.js';

/** A complete `PhaseInputs` with test defaults for everything the caller omits. */
export function phaseInputs(overrides: Partial<PhaseInputs> = {}): PhaseInputs {
  return {
    feature: 'test-feature',
    projectContext: '',
    languageContext: buildLanguageContext(undefined),
    ...overrides,
  };
}

/**
 * One planner call with test defaults: the `tasks` call with the quick prompt,
 * which is the shortest real call a backend can make.
 */
export function callPhase(
  planner: Planner,
  opts: Partial<PhaseInputs> & {
    projectDir: string;
    callbacks: PlannerCallbacks;
    call?: PlannerDocumentCall | undefined;
  },
): Promise<PhaseCallResult> {
  const { projectDir, callbacks, call, ...inputs } = opts;
  return planner.runPhase({
    call: call ?? 'tasks',
    projectDir,
    callbacks,
    inputs: phaseInputs({ quickPlan: { trivial: false }, ...inputs }),
  });
}
