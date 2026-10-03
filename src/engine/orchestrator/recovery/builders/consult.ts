import type { Phase, RecoveryReason } from '../../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../../core/schemas/recovery/schemas.js';
import type { Task } from '../../../../core/schemas/task.js';
import type { WorkflowState } from '../../../../core/schemas/workflow.js';
import { BOUNDS } from '../../../../core/pipeline-spec/bounds.js';
import { lineageIdOf } from '../../../../core/state/task-insert.js';
import { availableActionsForReason } from './actions.js';
import { compactFacts, createRecoveryIssue, type RecoveryBuilderBase } from './issue.js';
import { taskFiles } from './details.js';

type ConsultBoundReason = Extract<RecoveryReason, 'consult-bound-spent' | 'planner-calls-spent'>;

/** Which counter of a lineage or the run is spent, with both sides of the bound. */
export type ConsultBoundSpent = Readonly<{
  reason: ConsultBoundReason;
  consults: number;
  consultAllowance: number;
  attempts: number;
  attemptAllowance: number;
  plannerCalls: number;
  plannerCallAllowance: number;
}>;

type ConsultBudget = Omit<ConsultBoundSpent, 'reason'>;

/**
 * The counters a consult or an attempt checks, with the defaults a lineage or
 * run that holds no record yet starts from: a fresh brief never reads spent.
 */
function consultBudget(state: WorkflowState, task: Task): ConsultBudget {
  const lineage = state.lineages?.[lineageIdOf(task)];
  return {
    consults: lineage?.consults ?? 0,
    consultAllowance: lineage?.consultAllowance ?? BOUNDS.consultsPerLineage,
    attempts: lineage?.attempts ?? 0,
    attemptAllowance: lineage?.attemptAllowance ?? BOUNDS.attemptsPerLineage,
    plannerCalls: state.plannerCalls?.used ?? 0,
    plannerCallAllowance: state.plannerCalls?.allowance ?? BOUNDS.plannerCallsPerRun,
  };
}

/** The bound a consult would exceed: the lineage's consults or attempts, else the run's planner calls. */
export function consultBoundSpent(state: WorkflowState, task: Task): ConsultBoundSpent | undefined {
  const budget = consultBudget(state, task);
  if (budget.consults >= budget.consultAllowance || budget.attempts >= budget.attemptAllowance) {
    return { reason: 'consult-bound-spent', ...budget };
  }
  if (budget.plannerCalls >= budget.plannerCallAllowance) {
    return { reason: 'planner-calls-spent', ...budget };
  }
  return undefined;
}

/** The bound an attempt would exceed: the lineage's attempts, else the run's planner calls. */
export function attemptBoundSpent(state: WorkflowState, task: Task): ConsultBoundSpent | undefined {
  const budget = consultBudget(state, task);
  if (budget.attempts >= budget.attemptAllowance) {
    return { reason: 'consult-bound-spent', ...budget };
  }
  if (budget.plannerCalls >= budget.plannerCallAllowance) {
    return { reason: 'planner-calls-spent', ...budget };
  }
  return undefined;
}

export interface ConsultBoundRecoveryOptions extends RecoveryBuilderBase {
  reason: ConsultBoundReason;
  phase: Phase;
  task: Task;
  /** The last planner diagnosis, or the error that stopped the last attempt. */
  lastDiagnosis: string;
  consults?: number | undefined;
  consultAllowance?: number | undefined;
  attempts?: number | undefined;
  attemptAllowance?: number | undefined;
  plannerCalls?: number | undefined;
  plannerCallAllowance?: number | undefined;
}

function remedyLine(reason: ConsultBoundReason): string {
  return reason === 'consult-bound-spent'
    ? 'Continuing grants one more consult and four more attempts.'
    : 'Continuing grants five more planner calls.';
}

function countersLine(opts: ConsultBoundRecoveryOptions): string {
  return (
    `Consults ${opts.consults ?? 0} of ${opts.consultAllowance ?? 0}; ` +
    `attempts ${opts.attempts ?? 0} of ${opts.attemptAllowance ?? 0}; ` +
    `planner calls ${opts.plannerCalls ?? 0} of ${opts.plannerCallAllowance ?? 0}.`
  );
}

/**
 * The ladder ran out of the budget it needs to ask the planner: the lineage's
 * consults or attempts, or the run's planner calls. The last diagnosis travels
 * in the details so the operator decides the grant on the evidence.
 */
export function buildConsultBoundRecoveryIssue(opts: ConsultBoundRecoveryOptions): RecoveryIssue {
  const actions = availableActionsForReason(opts.reason, {
    switchSeat: false,
    routeBigger: false,
  });
  return createRecoveryIssue({
    id: opts.id,
    seat: 'build',
    reason: opts.reason,
    phase: opts.phase,
    task: opts.task,
    files: taskFiles(opts.task),
    affectedTaskIds: [opts.task.id],
    message:
      opts.reason === 'consult-bound-spent'
        ? `${opts.task.id} used its consult allowance`
        : 'The run used its planner-call allowance',
    details: [`Last diagnosis: ${opts.lastDiagnosis}`, remedyLine(opts.reason), countersLine(opts)],
    facts: compactFacts({
      lastDiagnosis: opts.lastDiagnosis,
      consults: opts.consults,
      consultAllowance: opts.consultAllowance,
      attempts: opts.attempts,
      attemptAllowance: opts.attemptAllowance,
      plannerCalls: opts.plannerCalls,
      plannerCallAllowance: opts.plannerCallAllowance,
    }),
    availableActions: actions,
    recommendedAction: 'continue',
    ...(opts.attempts !== undefined && { attempts: opts.attempts }),
    createdAt: opts.createdAt,
  });
}
