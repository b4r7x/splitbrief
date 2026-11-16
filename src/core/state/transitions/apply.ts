import { awaitsApply, deriveRunStatus } from '../../sessions/run/status.js';
import type { WorkflowState } from '../../schemas/workflow/state.js';
import { fixCyclesOf } from '../selectors.js';
import { assertNever } from '../../../utils/type-guards.js';
import { transitionError } from '../errors.js';
import type { MachineAction } from '../types.js';

type FamilyAction = Extract<
  MachineAction,
  {
    type:
      | 'RECORD_WORKSPACE'
      | 'ACCEPT_AS_IS'
      | 'APPLY_REVIEW_START'
      | 'APPLY_RECHECK_START'
      | 'RECORD_APPLY_INTEGRATED'
      | 'BIND_APPLY_INTEGRATED'
      | 'RECORD_APPLY_RECHECK'
      | 'APPLY_START'
      | 'APPLY_DONE'
      | 'APPLY_RESTORED'
      | 'APPLY_UNDONE'
      | 'CLOSE_RUN';
  }
>;

export function transitionApply(
  state: WorkflowState,
  action: FamilyAction,
  now: Date,
): WorkflowState {
  switch (action.type) {
    case 'RECORD_WORKSPACE':
      return { ...state, workspace: action.workspace };

    case 'ACCEPT_AS_IS':
      return {
        ...state,
        acceptedAsIs: {
          at: now.toISOString(),
          findings: action.findings,
          ...(action.redChecks !== undefined &&
            action.redChecks.length > 0 && { redChecks: action.redChecks }),
          ...(action.note !== undefined && { note: action.note }),
          ...(action.by !== undefined && { by: action.by }),
        },
        applyReview: undefined,
        pendingTriage: undefined,
      };

    case 'APPLY_REVIEW_START':
    case 'APPLY_RECHECK_START': {
      if (
        deriveRunStatus({ state, liveness: 'not-alive', reviewNone: false }).kind !==
        'ready-to-apply'
      ) {
        throw transitionError.invalidActionForPhase(state.phase, action.type);
      }
      const fixCycles = fixCyclesOf(state);
      return {
        ...state,
        phase: 'final-review',
        reviewStatus: undefined,
        completedAt: undefined,
        acceptedAsIs: undefined,
        applyReview: { merged: action.merged, failures: [] },
        ...(action.type === 'APPLY_REVIEW_START' &&
          (action.triage !== undefined
            ? { pendingTriage: { inputs: action.triage } }
            : { fixCycles: { ...fixCycles, used: fixCycles.used + 1 } })),
      };
    }

    case 'RECORD_APPLY_INTEGRATED': {
      const paths = new Set(action.integrated.map((record) => record.path));
      return {
        ...state,
        applyIntegrated: [
          ...(state.applyIntegrated ?? []).filter((record) => !paths.has(record.path)),
          ...action.integrated,
        ],
      };
    }

    // A resolution at the run base or on the checkout's side ends its record: Apply merges that
    // file again from then on.
    case 'BIND_APPLY_INTEGRATED':
      return {
        ...state,
        applyIntegrated: (state.applyIntegrated ?? []).flatMap((record) => {
          if (record.workspace !== null) return [record];
          const workspace = action.candidate[record.path];
          return workspace === undefined || workspace === record.checkout
            ? []
            : [{ ...record, workspace }];
        }),
      };

    case 'RECORD_APPLY_RECHECK':
      if (state.applyReview === undefined) {
        throw transitionError.invalidActionForPhase(state.phase, action.type);
      }
      return {
        ...state,
        applyReview: { ...state.applyReview, failures: action.failures, notRun: action.notRun },
      };

    case 'APPLY_START':
      if (!awaitsApply(state)) {
        throw transitionError.invalidActionForPhase(state.phase, action.type);
      }
      return { ...state, applying: { at: now.toISOString(), backupId: action.backupId } };

    case 'APPLY_DONE': {
      if (state.applying === undefined) {
        throw transitionError.invalidActionForPhase(state.phase, action.type);
      }
      const at = now.toISOString();
      return {
        ...state,
        applying: undefined,
        applied: { at, backupId: state.applying.backupId, files: action.files },
        closed: { at, as: 'applied' },
      };
    }

    case 'APPLY_RESTORED':
      if (state.applying === undefined) {
        throw transitionError.invalidActionForPhase(state.phase, action.type);
      }
      return { ...state, applying: undefined };

    case 'APPLY_UNDONE':
      if (state.applied === undefined || state.applied.undone !== undefined) {
        throw transitionError.invalidActionForPhase(state.phase, action.type);
      }
      return {
        ...state,
        applied: {
          ...state.applied,
          undone: { at: now.toISOString(), conflicts: action.conflicts },
        },
      };

    case 'CLOSE_RUN':
      if (deriveRunStatus({ state, liveness: 'not-alive', reviewNone: false }).kind === 'closed') {
        return state;
      }
      return {
        ...state,
        closed: {
          at: action.at ?? now.toISOString(),
          as: action.as ?? 'ended',
          ...(action.patch !== undefined && { patch: action.patch }),
        },
        interruptedStep: undefined,
        pendingRecovery: undefined,
        pendingPlannerConversation: undefined,
      };

    default:
      return assertNever(action);
  }
}
