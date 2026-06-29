import type { Phase } from '../../core/schemas/enums.js';
import type { EventBus } from '../events/types.js';
import { eventPhase, isInfrastructurePhaseEvent } from '../events/schema.js';
import type { ClearQueueHandler, QueueHandler, WorkflowSinks } from '../orchestrator/types.js';

export type IpcWorkflowBridge = {
  sinks: WorkflowSinks;
  signal: AbortSignal;
  abort(): void;
  onUserInput(text: string): void;
  onQueueClear(): void;
  close(): void;
};

const MAX_BUFFERED_INPUTS = 100;

export function createIpcWorkflowBridge(bus: EventBus): IpcWorkflowBridge {
  let currentPhase: Phase = 'idle';
  let queueHandler: QueueHandler | null = null;
  let clearQueueHandler: ClearQueueHandler | null = null;
  let abortHandler: (() => void) | null = null;
  const controller = new AbortController();
  const bufferedInput: string[] = [];

  const unsubscribe = bus.subscribe((event) => {
    if (isInfrastructurePhaseEvent(event)) return;
    const phase = eventPhase(event);
    if (phase) currentPhase = phase;
  });

  function flushBuffer() {
    if (!queueHandler || bufferedInput.length === 0) return;
    for (const text of bufferedInput.splice(0)) {
      void Promise.resolve(queueHandler(text, currentPhase));
    }
  }

  return {
    sinks: {
      setAbortHandler: (handler) => {
        abortHandler = handler;
      },
      setQueueHandler: (handler) => {
        queueHandler = handler;
        flushBuffer();
      },
      setClearQueueHandler: (handler) => {
        clearQueueHandler = handler;
      },
    },
    signal: controller.signal,
    abort() {
      if (!controller.signal.aborted) {
        controller.abort();
      }
      if (abortHandler) {
        abortHandler();
        abortHandler = null;
      }
    },
    onUserInput(text) {
      const trimmed = text.trim();
      if (!trimmed) return;

      if (!queueHandler) {
        if (bufferedInput.length >= MAX_BUFFERED_INPUTS) {
          bus.publish({
            type: 'warning',
            ts: Date.now(),
            phase: currentPhase,
            message: 'IPC input buffer full; dropping input while queue is not ready',
          });
          return;
        }
        bufferedInput.push(trimmed);
        bus.publish({
          type: 'warning',
          ts: Date.now(),
          phase: currentPhase,
          message: `IPC input buffered (queue not ready): ${bufferedInput.length} pending input, ${Buffer.byteLength(trimmed, 'utf8')} bytes`,
        });
        return;
      }

      flushBuffer();
      void Promise.resolve(queueHandler(trimmed, currentPhase));
    },
    onQueueClear() {
      if (!clearQueueHandler) {
        const count = bufferedInput.splice(0).length;
        bus.publish({ type: 'queue_cleared', ts: Date.now(), phase: currentPhase, count });
        return;
      }
      void Promise.resolve(clearQueueHandler()).then((result) => {
        if (result.status === 'unavailable') {
          bus.publish({
            type: 'warning',
            ts: Date.now(),
            phase: currentPhase,
            message: result.message,
          });
        }
      });
    },
    close() {
      queueHandler = null;
      clearQueueHandler = null;
      unsubscribe();
    },
  };
}
