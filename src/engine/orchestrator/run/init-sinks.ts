import type { Config } from '../../../core/schemas/config.js';
import { createEventBus } from '../../events/bus.js';
import { createJsonlSink } from '../../events/sinks/jsonl.js';
import { createStdoutJsonSink } from '../../events/sinks/stdout-json.js';
import { createOtelSink } from '../../events/sinks/otel.js';
import { createTreeRecorderSink } from '../../events/sinks/tree-recorder.js';
import { createLoggerSink } from '../../events/sinks/logger.js';
import type { EventBus } from '../../events/types.js';
import { createHookSink } from '../../hooks/sink.js';
import type { RunWorkflowOptions } from './init.js';

const initSinkUnsubscribers = new WeakMap<EventBus, Array<() => void>>();

export type AttachRunSinksInput = {
  opts: Pick<RunWorkflowOptions, 'eventBus' | 'tuiSink' | 'headless' | '_eventSink'>;
  config: Config;
  projectDir: string;
  sessionId: string;
};

/** Returns the run's bus with every configured sink subscribed; sinks from a prior run on the same bus are unsubscribed first. */
export async function attachRunSinks(input: AttachRunSinksInput): Promise<EventBus> {
  const { opts, config, projectDir, sessionId } = input;
  const bus = opts.eventBus ?? createEventBus();
  const prev = initSinkUnsubscribers.get(bus);
  if (prev) {
    for (const unsub of prev) unsub();
  }
  const unsubs: Array<() => void> = [];
  const { persistTranscript } = config.workflow;
  if (opts.tuiSink) unsubs.push(bus.subscribe(opts.tuiSink));
  unsubs.push(
    bus.subscribe(
      createJsonlSink({
        projectDir,
        sessionId,
        persistTranscript,
        onDegraded: (warning) => bus.publish(warning),
      }),
    ),
  );
  unsubs.push(bus.subscribe(createTreeRecorderSink({ projectDir, sessionId, persistTranscript })));
  unsubs.push(bus.subscribe(createLoggerSink({ persistTranscript })));
  if (opts.headless) unsubs.push(bus.subscribe(createStdoutJsonSink({ persistTranscript })));
  if (opts._eventSink) unsubs.push(bus.subscribe(opts._eventSink));
  if (config.hooks)
    unsubs.push(bus.subscribe(createHookSink(config.hooks, { projectDir, sessionId }, bus)));
  if (config.otel?.enabled) {
    const { trace } = await import('@opentelemetry/api');
    unsubs.push(
      bus.subscribe(
        createOtelSink({
          provider: trace.getTracerProvider(),
          serviceName: config.otel.serviceName,
          persistTranscript,
        }),
      ),
    );
  }
  initSinkUnsubscribers.set(bus, unsubs);
  return bus;
}
