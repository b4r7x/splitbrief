import { stripRecoveryResetClause } from '../../../../core/recovery/reset-clock.js';
import type { Section } from '../../../../core/sections/types.js';
import { SOFT_SEP } from '../../../../core/separators.js';
import type { EngineEventOf, EngineEvent } from '../../../../engine/events/types.js';
import { isTranscriptRowlessEvent } from '../event-rows/visibility.js';
import type { RecoveryFold } from './types.js';

type FailedCall = {
  event: EngineEventOf<'runner_call_activity' | 'runner_call_error' | 'runner_call_warning'>;
  events: EngineEvent[];
  words: Set<string>;
};

type RecoveryChain = {
  recovery: RecoveryFold & { prompted: EngineEventOf<'recovery_prompted'> };
  events: EngineEvent[];
  call: FailedCall | undefined;
  halt: EngineEventOf<'error'> | undefined;
  failure: EngineEventOf<'implementer_generate_failed'> | undefined;
  automaticSwitch?: EngineEventOf<'seat_switched'>;
};

export function automaticRecoveryFolds(sections: readonly Section<EngineEvent>[]) {
  const hidden = new Set<EngineEvent>();
  const switches = new Set<EngineEvent>();
  const recoveries = new Map<EngineEvent, RecoveryFold>();
  const calls = new Map<string, FailedCall>();
  const latestCalls = new Map<string | undefined, FailedCall>();
  const issues = new Map<string, RecoveryChain>();
  let selected: RecoveryChain | undefined;
  let previous: EngineEvent | undefined;
  let failure: EngineEventOf<'implementer_generate_failed'> | undefined;

  for (const section of sections) {
    for (const [index, event] of section.items.entries()) {
      if (
        event.type === 'runner_call_error' ||
        event.type === 'runner_call_warning' ||
        (event.type === 'runner_call_activity' &&
          (event.kind === 'warning' || event.kind === 'error'))
      ) {
        let call = calls.get(event.callId);
        if (call === undefined) {
          call = { event, events: [], words: new Set() };
          calls.set(event.callId, call);
        }
        call.events.push(event);
        const words =
          event.type === 'runner_call_activity'
            ? event.diagnosticPartial
            : event.type === 'runner_call_error'
              ? event.error.message
              : event.warning.message;
        if (words !== undefined && words !== '') call.words.add(words);
        latestCalls.set(event.taskId, call);
      } else if (event.type === 'implementer_generate_failed') {
        failure = event;
      } else if (event.type === 'recovery_prompted') {
        const existing = issues.get(event.issueId);
        if (existing !== undefined && existing.recovery.selected === undefined) {
          existing.events.push(event);
        } else {
          issues.set(event.issueId, {
            recovery: {
              firstIndex: section.startIndex + index,
              issueId: event.issueId,
              prompted: event,
            },
            events: [event],
            call: latestCalls.get(event.taskId),
            halt:
              previous?.type === 'error' && previous.phase === event.phase ? previous : undefined,
            failure,
          });
        }
      } else if (event.type === 'recovery_action_selected') {
        selected = issues.get(event.issueId);
        if (selected !== undefined) {
          selected.recovery.selected = event;
          selected.events.push(event);
        }
      } else if (event.type === 'seat_switched') {
        if (
          event.auto &&
          selected?.recovery.selected?.action === 'switch-seat' &&
          selected.recovery.selected.seat === event.seat &&
          selected.recovery.prompted.reason === event.cause &&
          selected.recovery.prompted.phase === event.phase
        )
          selected.automaticSwitch = event;
      } else if (event.type === 'recovery_resolved') {
        const chain = issues.get(event.issueId);
        const switched = chain?.automaticSwitch;
        if (
          chain !== undefined &&
          switched !== undefined &&
          typeof switched.from !== 'string' &&
          event.action === 'switch-seat' &&
          event.seat === switched.seat &&
          event.reason === chain.recovery.prompted.reason &&
          (event.outcome === 'continued' || event.outcome === 'retry-current-task')
        ) {
          const { recovery, halt } = chain;
          recovery.resolved = event;
          const call = chain.call;
          const linkedCall =
            call !== undefined &&
            call.event.taskId === recovery.prompted.taskId &&
            call.event.phase === recovery.prompted.phase &&
            call.event.runnerName === switched.from.tool &&
            call.event.model === switched.from.model;
          const words = new Set<string>();
          if (linkedCall) {
            for (const diagnostic of call.events) hidden.add(diagnostic);
            for (const word of call.words) words.add(word);
          }
          if (
            switched.seat === 'build' &&
            chain.failure !== undefined &&
            chain.failure.taskId === recovery.prompted.taskId &&
            chain.failure.phase === recovery.prompted.phase &&
            chain.failure.model === switched.from.model
          ) {
            hidden.add(chain.failure);
            if (chain.failure.error !== undefined) words.add(chain.failure.error);
          }
          if (
            halt !== undefined &&
            (restatesHalt(halt, recovery.prompted) ||
              [...words].some((word) => halt.message.includes(word)))
          )
            hidden.add(halt);
          for (const folded of chain.events) hidden.add(folded);
          hidden.add(event);
          recoveries.set(recovery.prompted, {
            ...recovery,
            automaticSwitch: switched,
            diagnostics: [...words],
          });
          switches.add(switched);
        }
        if (selected === chain) selected = undefined;
      } else if (event.type === 'recovery_action_failed') {
        if (selected?.recovery.issueId === event.issueId) selected = undefined;
      } else if (event.type === 'task_started') {
        failure = undefined;
      }
      if (!isTranscriptRowlessEvent(event)) previous = event;
    }
  }
  return { hidden, switches, recoveries };
}

// A restart the recovery made on the same worker restates the header; one on another seat or
// profile is news the reader needs.
export function sameHeader(
  open: EngineEventOf<'task_started'>,
  next: EngineEventOf<'task_started'>,
): boolean {
  return (
    open.taskId === next.taskId &&
    open.tool === next.tool &&
    open.model === next.model &&
    open.implementerProfile === next.implementerProfile
  );
}

export function joinsRecovery(recovery: RecoveryFold, event: EngineEvent): boolean {
  if (recovery.resolved !== undefined) return false;
  switch (event.type) {
    // A resumed run prompts the same issue again; it is still the one halt.
    case 'recovery_prompted':
      if (event.issueId !== recovery.issueId || recovery.selected !== undefined) return false;
      recovery.prompted = event;
      return true;
    case 'recovery_action_selected':
      if (event.issueId !== recovery.issueId || recovery.selected !== undefined) return false;
      recovery.selected = event;
      return true;
    case 'task_reset':
      if (recovery.selected === undefined || recovery.reset !== undefined) return false;
      recovery.reset = event;
      return true;
    case 'recovery_resolved':
      if (event.issueId !== recovery.issueId) return false;
      recovery.resolved = event;
      return true;
    default:
      return false;
  }
}

// The error row already names the halt; the prompt's card would say it a second time. A headline
// that carries the halt's evidence joins it with ` · ` where the error sentence uses ` — `.
export function restatesHalt(
  previous: EngineEvent | null,
  prompted: EngineEventOf<'recovery_prompted'>,
): boolean {
  return (
    previous?.type === 'error' &&
    previous.message
      .replace(' — ', SOFT_SEP)
      .startsWith(stripRecoveryResetClause(prompted.headline))
  );
}
