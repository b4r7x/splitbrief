import { PLAN_FILE, RESEARCH_FILE, SPEC_FILE, TASKS_FILE } from '../../../src/core/paths.js';
import type { Task } from '../../../src/core/schemas/task.js';
import type { TokenDelta } from '../../../src/core/schemas/tokens.js';
import { createPlannerCallContext } from '../../../src/engine/planners/call-context.js';
import { normalizePlannerPhase } from '../../../src/engine/planners/normalize.js';
import type {
  PhaseCallResult,
  PlannerArtifactLogicalName,
  PlannerDocumentCall,
} from '../../../src/engine/planners/types.js';
import { makeRunnerCallResult } from './runner-call.js';

const ARTIFACT: Record<PlannerDocumentCall, PlannerArtifactLogicalName> = {
  research: RESEARCH_FILE,
  spec: SPEC_FILE,
  plan: PLAN_FILE,
  tasks: TASKS_FILE,
};

const DEFAULT_TEXT: Record<PlannerDocumentCall, string> = {
  research: '# Research\n\nFindings.',
  spec: '# Spec\n\nRequirements.',
  plan: '# Plan\n\n## File Structure\n### New Files\n- `src/auth.ts`\n  Purpose: the module.',
  tasks: '# Task Briefs',
};

/** One planner call's result, shaped the way a real backend returns it. */
export function makePhaseCallResult(opts: {
  call: PlannerDocumentCall;
  text?: string | undefined;
  tasks?: Task[] | undefined;
  usage?: TokenDelta | null | undefined;
}): PhaseCallResult {
  const text = opts.text ?? DEFAULT_TEXT[opts.call];
  const callContext = createPlannerCallContext({ backendKind: 'api' }, 'planner');
  const result = makeRunnerCallResult({
    status: 'completed',
    text,
    callId: callContext.callId,
    role: 'planner',
  });
  return {
    text,
    usage: opts.usage ?? null,
    artifact: normalizePlannerPhase({
      result,
      callContext,
      logicalName: ARTIFACT[opts.call],
      text,
    }),
    ...(opts.call === 'tasks' ? { tasks: opts.tasks ?? [] } : {}),
  };
}
