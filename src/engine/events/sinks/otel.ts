import {
  trace,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  type Span,
  type Context,
  type TracerProvider,
} from '@opentelemetry/api';
import type { EngineEvent, EventSink } from '../types.js';
import { taskIdToString } from '../../../core/schemas/task.js';
import { totalInputTokens, totalOutputTokens } from '../../../core/schemas/tokens.js';
import { redactSecrets } from '../../../utils/redact.js';
import { assertNever } from '../../../utils/type-guards.js';

export interface OtelSinkOptions {
  provider: TracerProvider;
  serviceName?: string;
}

// SDK v2 pattern — context is propagated by passing it explicitly to startSpan, no global registration.
export function createOtelSink(opts: OtelSinkOptions): EventSink {
  const tracer = opts.provider.getTracer(opts.serviceName ?? 'diptych');

  let workflowSpan: Span | null = null;
  let workflowCtx: Context = ROOT_CONTEXT;
  let phaseSpan: Span | null = null;
  let phaseCtx: Context = ROOT_CONTEXT;
  let lastPhase: string | null = null;
  const taskSpans = new Map<string, Span>();

  return (event: EngineEvent) => {
    switch (event.type) {
      case 'workflow_started': {
        workflowSpan = tracer.startSpan(
          'diptych.workflow',
          {
            kind: SpanKind.INTERNAL,
            attributes: { 'diptych.feature': redactSecrets(event.feature) },
          },
          ROOT_CONTEXT,
        );
        workflowCtx = trace.setSpan(ROOT_CONTEXT, workflowSpan);
        return;
      }
      case 'workflow_config': {
        if (workflowSpan) {
          workflowSpan.setAttribute('diptych.mode', event.mode);
          workflowSpan.setAttribute('diptych.planner.tool', event.plannerTool);
          if (event.plannerModel)
            workflowSpan.setAttribute('diptych.planner.model', event.plannerModel);
          workflowSpan.setAttribute('diptych.implementer.tool', event.implementerTool);
          if (event.implementerModel)
            workflowSpan.setAttribute('diptych.implementer.model', event.implementerModel);
        }
        return;
      }
      case 'workflow_complete': {
        for (const t of taskSpans.values()) t.end();
        taskSpans.clear();
        if (phaseSpan) {
          phaseSpan.end();
          phaseSpan = null;
        }
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
      case 'workflow_resumed': {
        if (!workflowSpan) {
          workflowSpan = tracer.startSpan(
            'diptych.workflow',
            { kind: SpanKind.INTERNAL },
            ROOT_CONTEXT,
          );
          workflowCtx = trace.setSpan(ROOT_CONTEXT, workflowSpan);
        }
        return;
      }
      case 'planner_status': {
        if (
          event.status === 'running' &&
          event.phase !== lastPhase &&
          event.phase !== 'escalating' &&
          workflowSpan
        ) {
          if (phaseSpan) phaseSpan.end();
          phaseSpan = tracer.startSpan(
            `diptych.phase.${event.phase}`,
            {
              attributes: { 'diptych.phase': event.phase },
            },
            workflowCtx,
          );
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
          const span = tracer.startSpan(
            'diptych.task',
            {
              attributes: {
                'diptych.task.id': taskIdToString(event.taskId),
                'diptych.task.title': event.title,
                'diptych.task.file': event.file,
                'diptych.task.action': event.action,
                'diptych.task.index': event.index,
                'diptych.task.total': event.total,
              },
            },
            parentCtx,
          );
          taskSpans.set(taskIdToString(event.taskId), span);
        }
        return;
      }
      case 'task_completed': {
        const span = taskSpans.get(taskIdToString(event.taskId));
        if (span) {
          span.setAttribute('diptych.task.method', event.method);
          span.setAttribute('diptych.task.retries', event.retries);
          span.setAttribute('diptych.task.duration_ms', event.duration);
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          taskSpans.delete(taskIdToString(event.taskId));
        }
        return;
      }
      case 'task_full_fail': {
        const span = taskSpans.get(taskIdToString(event.taskId));
        if (span) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: 'task failed' });
          span.end();
          taskSpans.delete(taskIdToString(event.taskId));
        }
        return;
      }
      case 'task_skipped': {
        const span = taskSpans.get(taskIdToString(event.taskId));
        if (span) {
          span.setAttribute('diptych.task.skip_reason', event.reason);
          span.end();
          taskSpans.delete(taskIdToString(event.taskId));
        }
        return;
      }
      case 'cost_update': {
        if (workflowSpan) {
          workflowSpan.setAttribute(
            'diptych.cost.input_tokens',
            totalInputTokens(event.tokenUsage),
          );
          workflowSpan.setAttribute(
            'diptych.cost.output_tokens',
            totalOutputTokens(event.tokenUsage),
          );
        }
        return;
      }
      case 'validate': {
        const span = phaseSpan ?? workflowSpan;
        if (span && event.status === 'done') {
          span.addEvent('diptych.validate', {
            'diptych.validate.passed': event.passed,
            'diptych.validate.typecheck': event.stages.typecheck,
            'diptych.validate.lint': event.stages.lint,
            'diptych.validate.test': event.stages.test,
            ...(event.error ? { 'diptych.validate.error': event.error } : {}),
          });
        }
        return;
      }
      case 'error': {
        if (workflowSpan) {
          const message = redactSecrets(event.message);
          workflowSpan.recordException(new Error(message));
          for (const t of taskSpans.values()) {
            t.setStatus({ code: SpanStatusCode.ERROR, message });
            t.end();
          }
          taskSpans.clear();
          if (phaseSpan) {
            phaseSpan.setStatus({ code: SpanStatusCode.ERROR, message });
            phaseSpan.end();
            phaseSpan = null;
          }
          workflowSpan.setStatus({ code: SpanStatusCode.ERROR, message });
          workflowSpan.end();
          workflowSpan = null;
        }
        return;
      }
      case 'warning': {
        if (workflowSpan) {
          workflowSpan.addEvent('diptych.warning', {
            'diptych.warning.message': redactSecrets(event.message),
          });
        }
        return;
      }
      case 'paused_external_changes':
      case 'recovery_prompted':
      case 'recovery_action_selected':
      case 'recovery_action_failed':
      case 'recovery_resolved':
      case 'planner_text':
      case 'planner_heartbeat':
      case 'spec_rejected':
      case 'spec_regenerated':
      case 'plan_approved':
      case 'plan_rejected':
      case 'plan_regenerated':
      case 'rewind_to_spec':
      case 'rewind_to_plan':
      case 'all_tasks_done':
      case 'brief_quality_passed':
      case 'brief_quality_failed':
      case 'drift_report':
      case 'drift_chain_detected':
      case 'snapshot_created':
      case 'snapshot_restored':
      case 'snapshot_restore_conflict':
      case 'mode_resolved':
      case 'mode_downgrade_advised':
      case 'mode_advice':
      case 'instant_plan_received':
      case 'task_retry':
      case 'task_escalating':
      case 'task_reset':
      case 'task_tokens':
      case 'task_review_needed':
      case 'hint_failed':
      case 'implementer_generate_running':
      case 'implementer_generate_done':
      case 'implementer_generate_failed':
      case 'escalate':
      case 'git_commit':
      case 'git_checkpoint':
      case 'git_branch_created':
      case 'clarifications_collected':
      case 'clarification_answered':
      case 'message_queued':
      case 'message_injected_native':
      case 'queue_drained':
      case 'queue_cleared':
      case 'user_message':
      case 'planner_attachments_dropped':
      case 'cost_prediction':
      case 'budget_warning':
      case 'budget_paused':
      case 'budget_exceeded':
      case 'approval_prompted':
      case 'approval_granted':
      case 'approval_rejected':
      case 'approval_sticky_recorded':
      case 'approval_mode_changed':
      case 'ipc_server_started':
      case 'ipc_client_attached':
      case 'ipc_client_detached':
      case 'ipc_reconnect_attempt':
      case 'ipc_reconnect_failed':
      case 'replay_started':
      case 'replay_complete':
        return;
      default:
        return assertNever(event);
    }
  };
}
