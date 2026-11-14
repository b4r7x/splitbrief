import { assertNever } from '../../../../utils/type-guards.js';
import { type HeadTailEventLog, createHeadTailEventLog } from '../../../calls/output-limit.js';
import type { RunnerCallRecorder } from '../../../calls/recorder/types.js';
import type { CliProtocolEvent } from '../contract.js';

/**
 * The parsed events of one call, kept for the adapter's terminal reducers. Past
 * `maxBytes` the text, tool-use and heartbeat events drop from the middle: the
 * head and the tail stay, so the final group still parses. Every usage,
 * session, warning and result event stays, because the reducers read the last
 * of each and sum the usage of all.
 */
export function createProtocolEventLog(maxBytes: number): HeadTailEventLog<CliProtocolEvent> {
  return createHeadTailEventLog(maxBytes, droppableBytes);
}

function droppableBytes(event: CliProtocolEvent): number | null {
  switch (event.type) {
    case 'text':
    case 'input-ack':
      return event.text.length;
    case 'tool-use-delta':
      return event.inputDelta.length;
    case 'tool-use':
      return (
        JSON.stringify(event.input).length +
        (event.output === undefined ? 0 : JSON.stringify(event.output).length)
      );
    case 'heartbeat':
      return 0;
    case 'usage':
    case 'session':
    case 'warning':
    case 'result':
      return null;
    default:
      return assertNever(event);
  }
}

export function recordCliProtocolEvent(
  recorder: RunnerCallRecorder,
  event: CliProtocolEvent,
): void {
  switch (event.type) {
    case 'text':
      if (event.channel === 'stderr') recorder.stderr({ text: event.text });
      else {
        recorder.text({
          channel: event.channel,
          text: event.text,
          ...(event.subagentId !== undefined && { subagentId: event.subagentId }),
          ...(event.semantics !== undefined && { semantics: event.semantics }),
        });
      }
      return;
    case 'usage':
      recorder.usage({ usage: event.usage, semantics: event.semantics });
      return;
    case 'session':
      recorder.sessionId({
        nativeSessionId: event.nativeSessionId,
        ...(event.resolvedModel !== undefined && { resolvedModel: event.resolvedModel }),
      });
      return;
    case 'tool-use-delta':
      recorder.toolUseDelta({
        toolUseId: event.id,
        name: event.name,
        inputDelta: event.inputDelta,
      });
      return;
    case 'tool-use':
      if (event.stage === 'started') {
        recorder.toolUseDelta({
          toolUseId: event.id,
          name: event.name,
          inputDelta: JSON.stringify(event.input),
          stage: 'started',
        });
      } else {
        recorder.toolUseDone({
          toolUse: {
            id: event.id,
            name: event.name,
            input: { ...event.input },
            ...(event.output !== undefined && { output: event.output }),
          },
        });
      }
      return;
    case 'warning':
      recorder.warning({
        warning: {
          code: event.code,
          source: 'provider',
          message: event.message,
          ...(event.severity !== undefined && { severity: event.severity }),
          ...(event.originalModel !== undefined && { originalModel: event.originalModel }),
          ...(event.fallbackModel !== undefined && { fallbackModel: event.fallbackModel }),
          ...(event.usage !== undefined && { usage: event.usage }),
        },
      });
      return;
    case 'heartbeat':
      recorder.heartbeat();
      return;
    case 'input-ack':
    case 'result':
      return;
    default:
      assertNever(event);
  }
}
