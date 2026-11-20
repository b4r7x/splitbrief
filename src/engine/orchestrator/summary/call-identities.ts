import type { RunnerKind } from '../../../core/schemas/enums.js';
import { isRunnerCallEvent, type RunnerCallEngineEvent } from '../../calls/interrupted.js';
import type { EngineEvent } from '../../events/types.js';

export type CallIdentity = Pick<RunnerCallEngineEvent, 'callId' | 'role' | 'backendKind'> &
  Partial<
    Pick<
      RunnerCallEngineEvent,
      'phase' | 'taskId' | 'attempt' | 'runnerName' | 'model' | 'invocationIdentity'
    >
  >;

type CallFold = {
  evidence: CallIdentity;
  started: boolean;
  terminal: boolean;
};

export function collectCallIdentities(events: Iterable<EngineEvent>): CallIdentity[] {
  const rows: CallFold[] = [];
  const open = new Map<string, CallFold>();

  for (const event of events) {
    if (!isRunnerCallEvent(event)) continue;
    let call = open.get(event.callId);
    // Call ids restart with the process, so a resumed run can reuse one; a second
    // start is a new call.
    if (
      call === undefined ||
      (event.type === 'runner_call_started' && (call.started || call.terminal))
    ) {
      call = {
        evidence: {
          callId: event.callId,
          role: event.role,
          backendKind: event.backendKind,
        },
        started: false,
        terminal: false,
      };
      rows.push(call);
      open.set(event.callId, call);
    }
    fillAttribution(call.evidence, event);
    if (event.type === 'runner_call_started') call.started = true;
    if (event.type === 'runner_call_completed' || event.type === 'runner_call_error') {
      call.terminal = true;
    }
  }

  return rows.map((row) => row.evidence);
}

function fillAttribution(evidence: CallIdentity, event: RunnerCallEngineEvent): void {
  // A `review` role is also used for planning-time checks. Keep its phase on
  // the live evidence so the projection applies the same seat rule as the
  // persisted reconciliation path.
  if (evidence.phase === undefined) evidence.phase = event.phase;
  if (evidence.taskId === undefined && event.taskId !== undefined) evidence.taskId = event.taskId;
  if (evidence.attempt === undefined && event.attempt !== undefined) {
    evidence.attempt = event.attempt;
  }
  if (evidence.runnerName === undefined && event.runnerName !== undefined) {
    evidence.runnerName = event.runnerName;
  }
  if (evidence.model === undefined && event.model !== undefined) evidence.model = event.model;
  if (evidence.invocationIdentity === undefined && event.invocationIdentity !== undefined) {
    evidence.invocationIdentity = event.invocationIdentity;
  }
}

export function recordedRunnerKind(
  evidence: readonly CallIdentity[] | undefined,
  role: CallIdentity['role'],
  tool: string,
): RunnerKind | 'ambiguous' | undefined {
  if (evidence === undefined) return undefined;
  const kinds = new Set<RunnerKind>();
  for (const call of evidence) {
    if (call.role !== role) continue;
    const runner = call.invocationIdentity?.runner;
    const id = runner?.id ?? call.runnerName;
    if (id !== tool) continue;
    kinds.add(runner?.kind ?? call.backendKind);
  }
  if (kinds.size === 0) return undefined;
  return kinds.size === 1 ? [...kinds][0] : 'ambiguous';
}
