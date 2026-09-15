import { createEventBus } from '../../events/bus.js';
import { createJsonlSink } from '../../events/sinks/jsonl.js';
import type { EventBus, EventSink } from '../../events/types.js';

export interface RecoveryBusInput {
  projectDir: string;
  sessionId: string;
  /** The host's own projection — the TUI transcript — subscribed ahead of the log. */
  sink?: EventSink | undefined;
}

/**
 * The bus a recovery answered outside a live run publishes on. A halt is resolved
 * between two turns, when no orchestrator holds a bus, so the prompt and the
 * applied action still reach the host's projection and `session.jsonl` through the
 * same sinks a running turn would have used.
 */
export function createRecoveryBus({ projectDir, sessionId, sink }: RecoveryBusInput): EventBus {
  const bus = createEventBus();
  if (sink !== undefined) bus.subscribe(sink);
  bus.subscribe(
    createJsonlSink({
      projectDir,
      sessionId,
      onDegraded: (warning) => bus.publish(warning),
    }),
  );
  return bus;
}
