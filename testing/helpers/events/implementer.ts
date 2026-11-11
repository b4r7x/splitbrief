import type { EngineEvent } from '../../../src/engine/events/types.js';
import { taskId } from '../../../src/core/schemas/task.js';

type EventOfType<T extends EngineEvent['type']> = Extract<EngineEvent, { type: T }>;

type ImplementerGenerateEvent = Extract<
  EngineEvent,
  {
    type:
      | 'implementer_generate_running'
      | 'implementer_generate_done'
      | 'implementer_generate_failed';
  }
>;
type ImplementerGenerateRunningEvent = EventOfType<'implementer_generate_running'>;
type ImplementerGenerateDoneEvent = EventOfType<'implementer_generate_done'>;
type ImplementerGenerateFailedEvent = EventOfType<'implementer_generate_failed'>;

type RunningOverrides = Partial<Omit<ImplementerGenerateRunningEvent, 'type'>> & {
  status: 'running';
};
type DoneOverrides = Partial<Omit<ImplementerGenerateDoneEvent, 'type'>> & { status?: 'done' };
type FailedOverrides = Partial<Omit<ImplementerGenerateFailedEvent, 'type'>> & { status: 'failed' };

export function makeImplementerGenerate(
  overrides: RunningOverrides,
): ImplementerGenerateRunningEvent;
export function makeImplementerGenerate(overrides: FailedOverrides): ImplementerGenerateFailedEvent;
export function makeImplementerGenerate(overrides?: DoneOverrides): ImplementerGenerateDoneEvent;
export function makeImplementerGenerate(
  overrides?: RunningOverrides | DoneOverrides | FailedOverrides,
): ImplementerGenerateEvent {
  const base = {
    ts: Date.now(),
    phase: 'implementing' as const,
    taskId: taskId('T001'),
  };

  if (overrides?.status === 'running') {
    const { status: _status, ...rest } = overrides;
    return {
      type: 'implementer_generate_running',
      ...base,
      ...rest,
    };
  }
  if (overrides?.status === 'failed') {
    const { status: _status, ...rest } = overrides;
    return {
      type: 'implementer_generate_failed',
      ...base,
      model: 'qwen2.5-coder:7b',
      ...rest,
    };
  }
  const { status: _status, ...rest } = overrides ?? {};
  return {
    type: 'implementer_generate_done',
    ...base,
    file: 'src/test.ts',
    linesAdded: 10,
    linesRemoved: 2,
    duration: 5000,
    ...rest,
  };
}

// Each build of the row model reads `diff` of each done event, so the count is a build count.
export function makeDiffReadCounter() {
  let count = 0;
  return {
    done(diff: string, ts: number): ImplementerGenerateDoneEvent {
      const event = makeImplementerGenerate({ diff, ts });
      Object.defineProperty(event, 'diff', {
        enumerable: true,
        get: () => {
          count += 1;
          return diff;
        },
      });
      return event;
    },
    count: () => count,
    reset: () => {
      count = 0;
    },
  };
}
