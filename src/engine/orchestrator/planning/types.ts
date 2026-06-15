import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import type { PlannerCallbacksContext } from '../types.js';
import type { Planner, PlanResult, PriorMessage } from '../../planners/types.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import type { SkillMeta } from '../../../core/skills/types.js';
import type { ApproveLevel } from '../../../core/schemas/enums.js';
import type { Attachment } from '../../../core/schemas/attachment.js';
import type { SpecMetadata } from '../../../core/paths-io.js';

export type PlanningPhaseOptions = {
  wctx: PlannerCallbacksContext;
  planner: Planner;
  state: WorkflowState;
  feature: string;
  selectedSkills?: SkillMeta[] | undefined;
  rewindPending?: { target: 'spec' | 'plan'; comment?: string | undefined } | undefined;
  codebaseContext?: string | undefined;
  approveLevel?: ApproveLevel | undefined;
  attachments?: Attachment[] | undefined;
  deferBriefGate?: boolean | undefined;
};

export type PlanningRunContext = {
  approveLevel: ApproveLevel;
  metadata: SpecMetadata;
  skillsContext: string | undefined;
  state: WorkflowState;
};

export type PlanningPhaseResult = {
  state: WorkflowState;
  tasks: Task[];
  cancelled: boolean;
  failed?: boolean | undefined;
};

export type PlannerCallRunResult = {
  state: WorkflowState;
  result: PlanResult;
};

export type PlannerCallOptions = {
  wctx: PlannerCallbacksContext;
  state: WorkflowState;
  planner: Planner;
  feature: string;
  mode: 'quick' | 'speckit';
  skillsContext?: string | undefined;
  codebaseContext?: string | undefined;
  priorMessages?: PriorMessage[] | undefined;
  collectedQuestions?: ClarificationQuestion[] | undefined;
  attachments?: Attachment[] | undefined;
  phaseHint?: string | undefined;
};

export type BriefsApprovalLoopOptions = {
  tasks: Task[];
  planner: Planner;
  projectDir: string;
  sessionId: string;
  callbacks: import('../types.js').OrchestratorCallbacks;
  bus: import('../../events/types.js').EventBus;
  state: WorkflowState;
  metadata: import('../../../core/paths-io.js').SpecMetadata;
  signal?: AbortSignal | undefined;
};

export type BriefsApprovalLoopResult = {
  state: WorkflowState;
  tasks: Task[];
  rejected: boolean;
  aborted?: boolean | undefined;
};
