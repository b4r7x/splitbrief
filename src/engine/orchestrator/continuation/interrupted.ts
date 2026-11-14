import type { StepRef } from '../../../core/schemas/run-step.js';
import { readSessionLog } from '../../../core/sessions/log/reader.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { engineEventFromLogEntry } from '../../events/replay.js';
import { PARTIAL_MAX_CHARS } from '../../spec/prompts/continuation.js';

/**
 * The cut call's assistant stream, bounded to the continuation prompt's
 * existing limit. A final interrupted marker identifies that call even when
 * the buffer already flushed its last text chunk or the call printed nothing.
 * A later call start clears every earlier candidate.
 */
export async function readInterruptedPartial(ref: SessionRef): Promise<string | undefined> {
  let latest: string | undefined;
  let tail = '';
  let truncated = false;
  try {
    for await (const entry of readSessionLog(ref)) {
      if (entry.kind === 'event' && entry.type === 'runner_call_started') {
        latest = undefined;
        tail = '';
        truncated = false;
      }
      if (entry.kind !== 'message' || entry.role !== 'assistant') continue;
      tail += entry.text;
      if (tail.length > PARTIAL_MAX_CHARS) {
        tail = tail.slice(1 - PARTIAL_MAX_CHARS);
        truncated = true;
      }
      if (entry.interrupted === true) {
        latest = truncated ? `…${tail}` : tail;
        tail = '';
        truncated = false;
      }
    }
  } catch {
    return undefined;
  }
  return latest;
}

/**
 * The brief a stop cut mid-step that has not run again. The latest `turn_interrupted` names it until
 * a later call starts, a later stop replaces it, the operator redoes that brief (`task_reset`), or
 * the operator resolves a halt by anything but continuing (retry, skip, end): the rule
 * `readInterruptedPartial` applies to the partial.
 */
export async function readUnresumedBriefCut(ref: SessionRef): Promise<
  | {
      step: Extract<StepRef, { kind: 'brief' }>;
      source: 'user' | 'watchdog';
      at: string;
    }
  | undefined
> {
  let cut: Awaited<ReturnType<typeof readUnresumedBriefCut>>;
  for await (const entry of readSessionLog(ref)) {
    if (entry.kind !== 'event') continue;
    if (entry.type === 'runner_call_started') {
      cut = undefined;
      continue;
    }
    if (
      entry.type !== 'turn_interrupted' &&
      entry.type !== 'recovery_resolved' &&
      entry.type !== 'task_reset'
    )
      continue;
    const event = engineEventFromLogEntry(entry);
    if (event?.type === 'task_reset') {
      if (event.taskId === cut?.step.taskId) cut = undefined;
    } else if (event?.type === 'recovery_resolved') {
      if (event.outcome !== 'continued') cut = undefined;
    } else if (event?.type === 'turn_interrupted') {
      cut =
        event.at === 'mid-step' && event.step?.kind === 'brief'
          ? {
              step: event.step,
              source: event.source ?? 'user',
              at: new Date(event.ts).toISOString(),
            }
          : undefined;
    }
  }
  return cut;
}
