import { PLAN_FILE, RESEARCH_FILE, SPEC_FILE, TASKS_FILE } from '../../../src/core/paths.js';
import type { Task } from '../../../src/core/schemas/task.js';
import type { TokenDelta } from '../../../src/core/schemas/tokens.js';
import { createPlannerCallContext } from '../../../src/engine/planners/call-context.js';
import { normalizePlannerPhase } from '../../../src/engine/planners/normalize.js';
import type {
  ArtifactCallResult,
  PlannerArtifactLogicalName,
  PlannerDocumentCall,
} from '../../../src/engine/planners/types.js';
import { makeRunnerCallResult } from './runner-call.js';
import { PLANNER_DOCUMENT_SECTIONS } from '../../../src/core/pipeline-spec/planner-documents.js';

const ARTIFACT: Record<PlannerDocumentCall, PlannerArtifactLogicalName> = {
  research: RESEARCH_FILE,
  spec: SPEC_FILE,
  plan: PLAN_FILE,
  tasks: TASKS_FILE,
};

export const PLANNER_DOCUMENT_FIXTURES = {
  research:
    '# Research\n\n' +
    PLANNER_DOCUMENT_SECTIONS.research.map((heading) => `## ${heading}\nFindings.`).join('\n\n'),
  spec:
    '# Spec\n\n' +
    PLANNER_DOCUMENT_SECTIONS.spec.map((heading) => `## ${heading}\nRequirements.`).join('\n\n'),
  plan:
    '# Plan\n\n' +
    PLANNER_DOCUMENT_SECTIONS.plan
      .map(
        (heading) =>
          `## ${heading}\n${heading === 'File Structure' ? '### New Files\n- `src/auth.ts`\n  Purpose: the module.\n### Modified Files\nNone.' : 'Implementation details.'}`,
      )
      .join('\n\n'),
  tasks: '# Task Briefs',
};

/** One planner call's result, shaped the way a real backend returns it. */
export function makePhaseCallResult(opts: {
  call: PlannerDocumentCall;
  text?: string | undefined;
  tasks?: Task[] | undefined;
  usage?: TokenDelta | null | undefined;
}): ArtifactCallResult {
  const text = opts.text ?? PLANNER_DOCUMENT_FIXTURES[opts.call];
  const callContext = createPlannerCallContext({ backendKind: 'api' }, 'planner');
  const result = makeRunnerCallResult({
    status: 'completed',
    text,
    callId: callContext.callId,
    role: 'planner',
  });
  return {
    kind: 'artifact',
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
