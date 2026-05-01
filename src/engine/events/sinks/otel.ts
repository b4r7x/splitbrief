import { trace, ROOT_CONTEXT, SpanKind, SpanStatusCode, type Span, type Context, type TracerProvider } from '@opentelemetry/api';
import type { EngineEvent, EventSink } from '../types.js';
import type { TaskId } from '../../../core/schemas/task.js';

export interface OtelSinkOptions {
  provider: TracerProvider;
  serviceName?: string;
}

/**
 * EventSink that emits OpenTelemetry spans for workflow lifecycle events.
 * - Workflow lifecycle: root span 'diptych.workflow'
 * - Phases: nested 'diptych.phase.<name>' spans under workflow
 * - Tasks: nested 'diptych.task' spans under workflow during implementing phase
 * - Point events (cost_update, validate, error, warning): attributes/events on active spans
 *
 * Requires a TracerProvider scoped to this workflow run. Context is propagated
 * by passing it explicitly to startSpan (SDK v2 pattern — no global registration needed).
 */
export function createOtelSink(opts: OtelSinkOptions): EventSink {
  const tracer = opts.provider.getTracer(opts.serviceName ?? 'diptych');

  let workflowSpan: Span | null = null;
  let workflowCtx: Context = ROOT_CONTEXT;
  let phaseSpan: Span | null = null;
  let phaseCtx: Context = ROOT_CONTEXT;
  let lastPhase: string | null = null;
  const taskSpans = new Map<string, Span>();
  const taskKey = (id: TaskId): string => id as string;

  return (event: EngineEvent) => {
    switch (event.type) {
      case 'workflow_started': {
        workflowSpan = tracer.startSpan('diptych.workflow', {
          kind: SpanKind.INTERNAL,
          attributes: { 'diptych.feature': event.feature },
        }, ROOT_CONTEXT);
        workflowCtx = trace.setSpan(ROOT_CONTEXT, workflowSpan);
        return;
      }
      case 'workflow_config': {
        if (workflowSpan) {
          workflowSpan.setAttribute('diptych.mode', event.mode);
          workflowSpan.setAttribute('diptych.planner.tool', event.plannerTool);
          if (event.plannerModel) workflowSpan.setAttribute('diptych.planner.model', event.plannerModel);
          workflowSpan.setAttribute('diptych.implementer.tool', event.implementerTool);
          if (event.implementerModel) workflowSpan.setAttribute('diptych.implementer.model', event.implementerModel);
        }
        return;
      }
      case 'workflow_complete': {
        for (const t of taskSpans.values()) t.end();
        taskSpans.clear();
        if (phaseSpan) { phaseSpan.end(); phaseSpan = null; }
        if (workflowSpan) {
          workflowSpan.setStatus({ code: SpanStatusCode.OK });
          workflowSpan.end();
          workflowSpan = null;
        }
        return;
      }
      case 'workflow_cancelled': {
        for (const t of taskSpans.values()) {
          t.setStatus({ code: SpanStatusCode.ERROR, message: 'workflow cancelled' });
          t.end();
        }
        taskSpans.clear();
        if (phaseSpan) {
          phaseSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'cancelled' });
          phaseSpan.end();
          phaseSpan = null;
        }
        if (workflowSpan) {
          workflowSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'cancelled' });
          workflowSpan.end();
          workflowSpan = null;
        }
        return;
      }
      case 'planner_status': {
        if (event.status === 'running' && event.phase !== lastPhase && workflowSpan) {
          if (phaseSpan) phaseSpan.end();
          phaseSpan = tracer.startSpan(`diptych.phase.${event.phase}`, {
            attributes: { 'diptych.phase': event.phase },
          }, workflowCtx);
          phaseCtx = trace.setSpan(workflowCtx, phaseSpan);
          lastPhase = event.phase;
        }
        if (event.status === 'done' && phaseSpan && event.phase === lastPhase) {
          if (event.duration !== undefined) {
            phaseSpan.setAttribute('diptych.phase.duration_ms', event.duration);
          }
        }
        return;
      }
      case 'task_started': {
        if (workflowSpan) {
          const parentCtx = phaseSpan ? phaseCtx : workflowCtx;
          const span = tracer.startSpan('diptych.task', {
            attributes: {
              'diptych.task.id': taskKey(event.taskId),
              'diptych.task.title': event.title,
              'diptych.task.file': event.file,
              'diptych.task.action': event.action,
              'diptych.task.index': event.index,
              'diptych.task.total': event.total,
            },
          }, parentCtx);
          taskSpans.set(taskKey(event.taskId), span);
        }
        return;
      }
      case 'task_completed': {
        const span = taskSpans.get(taskKey(event.taskId));
        if (span) {
          span.setAttribute('diptych.task.method', event.method);
          span.setAttribute('diptych.task.retries', event.retries);
          span.setAttribute('diptych.task.duration_ms', event.duration);
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          taskSpans.delete(taskKey(event.taskId));
        }
        return;
      }
      case 'task_failed':
      case 'task_full_fail': {
        const span = taskSpans.get(taskKey(event.taskId));
        if (span) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: 'task failed' });
          span.end();
          taskSpans.delete(taskKey(event.taskId));
        }
        return;
      }
      case 'task_skipped': {
        const span = taskSpans.get(taskKey(event.taskId));
        if (span) {
          span.setAttribute('diptych.task.skip_reason', event.reason);
          span.end();
          taskSpans.delete(taskKey(event.taskId));
        }
        return;
      }
      case 'cost_update': {
        if (workflowSpan) {
          const u = event.tokenUsage;
          workflowSpan.setAttribute('diptych.cost.input_tokens', u.plannerInput + u.implementerInput + u.escalationInput);
          workflowSpan.setAttribute('diptych.cost.output_tokens', u.plannerOutput + u.implementerOutput + u.escalationOutput);
        }
        return;
      }
      case 'validate': {
        const span = phaseSpan ?? workflowSpan;
        if (span && event.status === 'done') {
          span.addEvent('diptych.validate', {
            'diptych.validate.passed': event.passed,
            'diptych.validate.tsc': event.stages.tsc,
            'diptych.validate.lint': event.stages.lint,
            'diptych.validate.test': event.stages.test,
            ...(event.error ? { 'diptych.validate.error': event.error } : {}),
          });
        }
        return;
      }
      case 'error': {
        if (workflowSpan) {
          workflowSpan.recordException(new Error(event.message));
        }
        return;
      }
      case 'warning': {
        if (workflowSpan) {
          workflowSpan.addEvent('diptych.warning', { 'diptych.warning.message': event.message });
        }
        return;
      }
      default:
        return;
    }
  };
}
