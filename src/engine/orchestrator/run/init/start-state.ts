import { resolveApproveLevel } from '../../../../core/config/runtime/resolve.js';
import { sessionDir } from '../../../../core/paths.js';
import {
  notAppliedWarnings,
  startReadinessWarnings,
  createStartReadinessRecord,
} from '../../../../core/readiness/format.js';
import type { Config } from '../../../../core/schemas/config.js';
import type { WorkflowState } from '../../../../core/schemas/workflow/state.js';
import type { SkillMeta } from '../../../../core/skills/types.js';
import { createInitialState } from '../../../../core/state/machine.js';
import { plainUserMessage } from '../../../../core/types/user-input.js';
import type { EventBus } from '../../../events/types.js';
import type { PreparedExecution } from '../../../runners/prepare-execution/prepared.js';
import { publishWarning } from '../../publish/notice.js';
import { publishPlannerStatus } from '../../publish/runner.js';
import { transitionAndSave } from '../../state-ops/transition.js';
import type { SummaryBase } from '../../summary/build.js';
import { seatFieldsOf } from '../../summary/seat-identity.js';
import { recordUserMessage } from '../../transcript/user-message.js';
import type { RunWorkflowOptions } from './options.js';
import { shouldPublishResumePlannerStatus } from './resume-repair.js';

// TUI and headless recovery turns share their loop's signal; a restart owns a new one. Each session
// the loop initialized keeps the warnings it told, so one loop tells one warning of a run once.
const toldWarningsBySignal = new WeakMap<AbortSignal, Map<string, Set<string>>>();

type RunStateInput = Readonly<{
  projectDir: string;
  sessionId: string;
  bus: EventBus;
  config: Config;
  summaryBase: SummaryBase;
  prepared: PreparedExecution;
  /** The settled saved state of a resume; a start has none. */
  savedState: WorkflowState | undefined;
  /** The state a new workflow starts from when its caller holds one. */
  startFrom: WorkflowState | undefined;
  selectedSkills: SkillMeta[] | undefined;
  resumeCause: RunWorkflowOptions['resumeCause'];
  signal: AbortSignal | undefined;
  setTrackedState: (s: WorkflowState) => void;
}>;

/** Resumes the saved state, or saves and starts a new one, and tells each readiness warning once per loop. */
export function enterRunState(input: RunStateInput): WorkflowState {
  const { projectDir, sessionId, bus, config, prepared, signal, setTrackedState } = input;
  const { runtime } = prepared;
  const feature = runtime.feature;
  const sessionPath = sessionDir(projectDir, sessionId);
  const initializedSessions = signal === undefined ? undefined : toldWarningsBySignal.get(signal);
  const toldWarnings = initializedSessions?.get(sessionPath) ?? new Set<string>();
  let state: WorkflowState;

  if (input.savedState) {
    state = input.savedState;
    setTrackedState(state);
    bus.publish({
      type: 'workflow_resumed',
      ts: Date.now(),
      phase: state.phase,
      ...(initializedSessions?.has(sessionPath) && { inProcess: true }),
      ...(input.resumeCause !== undefined && { cause: input.resumeCause }),
    });
    for (const lines of notAppliedWarnings(prepared.report)) {
      const message = lines.join('\n');
      if (toldWarnings.has(message)) continue;
      toldWarnings.add(message);
      publishWarning({ bus, phase: state.phase, message });
    }
    if (shouldPublishResumePlannerStatus(state)) {
      publishPlannerStatus(bus, state, 'running');
    }
  } else {
    state = input.startFrom ?? createInitialState(feature);
    // Saved with the start, as planning resolves them: planning keeps them only in memory, and
    // its first call reads the saved state back, so a run that saved none later took the config's.
    state = {
      ...state,
      approve: resolveApproveLevel(config),
      ...seatFieldsOf(input.summaryBase),
      ...(input.selectedSkills && input.selectedSkills.length > 0
        ? { selectedSkills: input.selectedSkills.map((s) => s.id) }
        : {}),
      ...(runtime.plannerContext !== undefined && { plannerContext: runtime.plannerContext }),
    };
    state = transitionAndSave(
      { projectDir, sessionId },
      state,
      { type: 'START' },
      { expectedRevision: state.stateRevision },
    );
    setTrackedState(state);
    bus.publish({ type: 'workflow_started', ts: Date.now(), phase: state.phase, feature });
    publishPlannerStatus(bus, state, 'running');
    recordUserMessage(
      { projectDir, sessionId, bus, phase: state.phase },
      { ...plainUserMessage(feature), attachedInputs: [...(runtime.attachedInputs ?? [])] },
    );
    for (const message of startReadinessWarnings(
      createStartReadinessRecord(prepared.report, { projectDir, sessionId }),
    )) {
      toldWarnings.add(message);
      publishWarning({ bus, phase: state.phase, message });
    }
  }

  if (signal !== undefined) {
    const sessions = initializedSessions ?? new Map<string, Set<string>>();
    sessions.set(sessionPath, toldWarnings);
    toldWarningsBySignal.set(signal, sessions);
  }
  return state;
}
