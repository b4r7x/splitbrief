import type { Config } from '../../../core/schemas/config.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { createEventBus } from '../../events/bus.js';
import { createJsonlSink } from '../../events/sinks/jsonl.js';
import { createStdoutJsonSink } from '../../events/sinks/stdout-json.js';
import { createStdoutTextSink } from '../../events/sinks/stdout-text.js';
import { createLoggerSink } from '../../events/sinks/logger.js';
import { createCallEvidenceSink } from '../summary/call-evidence.js';
import type { EventBus } from '../../events/types.js';
import { createHookSink } from '../../hooks/sink.js';
import type { HookContext } from '../../hooks/types.js';
import type { RunWorkflowOptions } from './init.js';

const initSinkUnsubscribers = new WeakMap<EventBus, Array<() => void>>();

export type AttachRunSinksInput = {
  opts: Pick<RunWorkflowOptions, 'eventBus' | 'tuiSink' | 'headless' | 'plain' | '_eventSink'>;
  config: Config;
  projectDir: string;
  sessionId: string;
  getTrackedState?: (() => WorkflowState | undefined) | undefined;
};

/** Returns the run's bus with every configured sink subscribed; sinks from a prior run on the same bus are unsubscribed first. */
export function attachRunSinks(input: AttachRunSinksInput): EventBus {
  const { opts, config, projectDir, sessionId, getTrackedState } = input;
  const bus = opts.eventBus ?? createEventBus();
  const prev = initSinkUnsubscribers.get(bus);
  if (prev) {
    for (const unsub of prev) unsub();
  }
  const unsubs: Array<() => void> = [];
  if (opts.tuiSink) unsubs.push(bus.subscribe(opts.tuiSink));
  unsubs.push(
    bus.subscribe(
      createJsonlSink({
        projectDir,
        sessionId,
        onDegraded: (warning) => bus.publish(warning),
      }),
    ),
  );
  unsubs.push(bus.subscribe(createLoggerSink()));
  // The run's own per-call usage record, kept in memory so the summary reads what
  // the run observed rather than what reached the log in time.
  unsubs.push(bus.subscribe(createCallEvidenceSink({ projectDir, sessionId })));
  // `--plain` renders the same stream as text on the same stdout, so exactly one
  // of the two stdout sinks is ever installed.
  if (opts.headless) {
    unsubs.push(bus.subscribe(opts.plain ? createStdoutTextSink() : createStdoutJsonSink()));
  }
  if (opts._eventSink) unsubs.push(bus.subscribe(opts._eventSink));
  if (config.hooks)
    unsubs.push(
      bus.subscribe(
        createHookSink(
          config.hooks,
          (): HookContext => ({
            projectDir,
            workspaceDir: getTrackedState?.()?.workspace?.path ?? projectDir,
            sessionId,
          }),
          bus,
        ),
      ),
    );
  initSinkUnsubscribers.set(bus, unsubs);
  return bus;
}
