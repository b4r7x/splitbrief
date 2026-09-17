import type { CallUsageEvidence } from '../../../core/schemas/usage-evidence.js';
import { applyRunnerCallUsageSample } from '../../calls/usage.js';
import type { EngineEvent } from '../../events/types.js';

type RunnerCallEngineEvent = Extract<EngineEvent, { type: `runner_call_${string}` }>;

type CallFold = {
  evidence: CallUsageEvidence;
  started: boolean;
  terminal: boolean;
};

function isRunnerCallEvent(event: EngineEvent): event is RunnerCallEngineEvent {
  return event.type.startsWith('runner_call_');
}

/**
 * One row per recorded call, attributed only from what the call itself recorded:
 * a task, attempt or boundary the record does not carry stays absent (`unknown`
 * for the boundary), and a call that reported no usage keeps `usage: null`.
 * Samples follow the collector: delta adds, cumulative and final replace, and
 * nothing after the terminal record counts, so a repeated final is not added twice.
 */
export function collectCallUsageEvidence(events: Iterable<EngineEvent>): CallUsageEvidence[] {
  const rows: CallFold[] = [];
  const open = new Map<string, CallFold>();

  for (const event of events) {
    if (!isRunnerCallEvent(event)) continue;
    let call = open.get(event.callId);
    // Call ids restart with the process, so a resumed run can reuse one; a second
    // start is a new call, not more usage for the old one.
    if (
      call === undefined ||
      (event.type === 'runner_call_started' && (call.started || call.terminal))
    ) {
      call = {
        evidence: {
          callId: event.callId,
          role: event.role,
          backendKind: event.backendKind,
          usageBoundary: 'unknown',
          usage: null,
        },
        started: false,
        terminal: false,
      };
      rows.push(call);
      open.set(event.callId, call);
    }
    fillAttribution(call.evidence, event);
    if (event.type === 'runner_call_started') call.started = true;
    if (call.terminal) continue;

    if (event.type === 'runner_call_usage') {
      call.evidence.usage = applyRunnerCallUsageSample(call.evidence.usage, {
        semantics: event.semantics,
        usage: event.usage,
      });
    } else if (event.type === 'runner_call_completed' || event.type === 'runner_call_error') {
      call.terminal = true;
      if (event.usage !== null) {
        call.evidence.usage = applyRunnerCallUsageSample(call.evidence.usage, {
          semantics: 'final',
          usage: event.usage,
        });
      }
    }
  }

  return rows.map((row) => row.evidence);
}

function fillAttribution(evidence: CallUsageEvidence, event: RunnerCallEngineEvent): void {
  // A `review` role is also used for planning-time checks. Keep its phase on
  // the live evidence so the projection applies the same seat rule as the
  // persisted reconciliation path.
  if (evidence.phase === undefined && event.role === 'review') evidence.phase = event.phase;
  if (evidence.taskId === undefined && event.taskId !== undefined) evidence.taskId = event.taskId;
  if (evidence.attempt === undefined && event.attempt !== undefined) {
    evidence.attempt = event.attempt;
  }
  if (evidence.runnerName === undefined && event.runnerName !== undefined) {
    evidence.runnerName = event.runnerName;
  }
  if (evidence.model === undefined && event.model !== undefined) evidence.model = event.model;
  if (evidence.usageBoundary === 'unknown' && event.usageBoundary !== undefined) {
    evidence.usageBoundary = event.usageBoundary;
  }
  if (evidence.invocationIdentity === undefined && event.invocationIdentity !== undefined) {
    evidence.invocationIdentity = event.invocationIdentity;
  }
}
