import type { Phase } from '../../core/schemas/enums.js';
import type { EngineEvent, EventBus } from '../events/types.js';
import type { QueueHandler, WorkflowSinks } from '../orchestrator/types.js';

export type IpcWorkflowBridge = {
  sinks: WorkflowSinks;
  signal: AbortSignal;
  abort(): void;
  onUserInput(text: string): void;
  close(): void;
};

function phaseFromEvent(event: EngineEvent): Phase | null {
  return 'phase' in event ? event.phase : null;
}

export function createIpcWorkflowBridge(bus: EventBus): IpcWorkflowBridge {
  let currentPhase: Phase = 'idle';
  let queueHandler: QueueHandler | null = null;
  let abortHandler: (() => void) | null = null;
  const controller = new AbortController();

  const unsubscribe = bus.subscribe((event) => {
    const phase = phaseFromEvent(event);
    if (phase) currentPhase = phase;
  });

  return {
    sinks: {
      setAbortHandler: (handler) => {
        abortHandler = handler;
      },
      setQueueHandler: (handler) => {
        queueHandler = handler;
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
        bus.publish({
          type: 'warning',
          ts: Date.now(),
          phase: currentPhase,
          message: 'IPC input received before the workflow queue was ready.',
        });
        return;
      }

      queueHandler(trimmed, currentPhase);
    },
    close() {
      queueHandler = null;
      unsubscribe();
    },
  };
}
