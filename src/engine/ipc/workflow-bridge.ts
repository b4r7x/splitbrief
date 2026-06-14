import type { Phase } from '../../core/schemas/enums.js';
import { truncateWithEllipsis } from '../../utils/truncate.js';
import type { EventBus } from '../events/types.js';
import { eventPhase } from '../events/schema.js';
import type { QueueHandler, WorkflowSinks } from '../orchestrator/types.js';

export type IpcWorkflowBridge = {
  sinks: WorkflowSinks;
  signal: AbortSignal;
  abort(): void;
  onUserInput(text: string): void;
  close(): void;
};

const MAX_BUFFERED_INPUTS = 100;

export function createIpcWorkflowBridge(bus: EventBus): IpcWorkflowBridge {
  let currentPhase: Phase = 'idle';
  let queueHandler: QueueHandler | null = null;
  let abortHandler: (() => void) | null = null;
  const controller = new AbortController();
  const bufferedInput: string[] = [];

  const unsubscribe = bus.subscribe((event) => {
    const phase = eventPhase(event);
    if (phase) currentPhase = phase;
  });

  function flushBuffer() {
    if (!queueHandler || bufferedInput.length === 0) return;
    for (const text of bufferedInput.splice(0)) {
      queueHandler(text, currentPhase);
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
          message: `IPC input buffered (queue not ready): ${truncateWithEllipsis(trimmed, 40)}`,
        });
        return;
      }

      flushBuffer();
      queueHandler(trimmed, currentPhase);
    },
    close() {
      queueHandler = null;
      unsubscribe();
    },
  };
}
