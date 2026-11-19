import { join } from 'node:path';
import { resolveApproveLevel } from '../../../core/config/runtime/resolve.js';
import { sessionDir, PLAN_FILE, PLAN_JSON_FILE } from '../../../core/paths.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { readSpecFileOrEmpty } from '../../../core/sessions/spec-files.js';
import { planRevisedTurn } from '../../spec/prompts/plan-session.js';
import { planConfirmations } from '../approval/confirm.js';
import { persistApprovalEvidence } from '../evidence/decisions.js';
import { publishPlannerStatus } from '../publish/runner.js';
import { publishTasksPlanned } from '../publish/task.js';
import { formatDrainedMessages } from '../queue/prompt.js';
import { closeRunIfOpen } from '../run/close.js';
import { rebaseOnPersistedWorkflowState } from '../state-ops/head.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { recordUserMessage } from '../transcript/user-message.js';
import { applyPlanEdit } from './compile.js';
import { handlePlanningFailure } from './failure.js';
import { drainAndFormat } from './queue-drain.js';
import { runPlanningSession } from './session.js';
import type { PlanningPhaseOptions, PlanningPhaseResult } from './types.js';

/**
 * The plan card: the plan waits for the user's approval, when the run asks for one, before the
 * build begins. Approving it confirms the protected operations it lists; typed text, or a message
 * still queued, is a correction the planning session answers with a new plan; an edit of plan.json
 * is checked and compiled. A run parked at the card reopens it here.
 */
export async function runPlanApproval(
  opts: PlanningPhaseOptions,
  state: WorkflowState,
): Promise<PlanningPhaseResult> {
  const { wctx } = opts;
  const { projectDir, sessionId, bus, signal } = wctx;
  const ref = { projectDir, sessionId };
  const cardPath = join(sessionDir(projectDir, sessionId), PLAN_FILE);
  let current = state;

  while (resolveApproveLevel(wctx.config) === 'plan') {
    publishTasksPlanned({ bus, phase: current.phase }, current.tasks);
    if (current.phase !== 'reviewing-plan') {
      current = transitionAndSave(ref, current, { type: 'PLAN_DONE', tasks: current.tasks });
      publishPlannerStatus(bus, current, 'running');
    }
    if (signal?.aborted) return { disposition: 'terminal', state: current, outcome: 'cancelled' };
    const reviewed = readSpecFileOrEmpty(ref, PLAN_JSON_FILE);
    const queued = await drainAndFormat(projectDir, sessionId, current, bus);
    current = queued.state;
    let correction = queued.prefix.trim();
    let displayCorrection = formatDrainedMessages(
      queued.messages.map((message) => ({ ...message, text: message.displayText })),
    ).trim();

    if (correction === '') {
      try {
        const confirmations = planConfirmations(
          current.tasks,
          wctx.workspaceDir ?? projectDir,
          current.plan,
        );
        bus.publish({ type: 'plan_card_opened', ts: Date.now(), phase: current.phase });
        const result = await wctx.callbacks.onApprovalNeeded(
          'plan',
          cardPath,
          confirmations.map((confirmation) => confirmation.actionDescription),
        );
        if (signal?.aborted)
          return { disposition: 'terminal', state: current, outcome: 'cancelled' };
        if (result.approved) {
          if (result.unattended !== true) {
            persistApprovalEvidence({
              wctx,
              state: current,
              decision: { allow: true, confirmApprovals: confirmations },
            });
          }
          bus.publish({ type: 'plan_approved', ts: Date.now(), phase: current.phase });
          break;
        }
        if (result.action === 'end-run') {
          current = (await closeRunIfOpen({ projectDir, sessionId, bus }, current)).state;
          publishPlannerStatus(bus, current, 'done');
          bus.publish({ type: 'plan_rejected', ts: Date.now(), phase: current.phase });
          return { disposition: 'terminal', state: current, outcome: 'closed' };
        }
        if (result.action === 'edit') {
          current = await applyPlanEdit(wctx, current, reviewed);
          continue;
        }
        if (result.action !== 'revise' || result.message.text.trim() === '') continue;
        correction = result.message.text;
        displayCorrection = result.message.displayText;
        if (result.recorded !== true) {
          recordUserMessage({ ...ref, bus, phase: 'reviewing-plan' }, result.message);
          current = rebaseOnPersistedWorkflowState(ref, current);
        }
      } catch (err) {
        return handlePlanningFailure({ err, projectDir, sessionId, state: current, wctx });
      }
    }

    bus.publish({
      type: 'plan_regenerated',
      ts: Date.now(),
      phase: current.phase,
      comment: displayCorrection,
    });
    current = transitionAndSave(ref, current, { type: 'CORRECT_PLAN', comment: correction });
    const revised = await runPlanningSession(
      { ...opts, state: current, attachments: undefined, beforeFirstCall: undefined },
      planRevisedTurn(reviewed, correction),
    );
    if (revised.disposition === 'terminal') return revised;
    current = revised.state;
  }

  current = transitionAndSave(ref, current, { type: 'BEGIN_IMPLEMENTATION' });
  return { disposition: 'ready-for-tasks', state: current, tasks: current.tasks };
}
