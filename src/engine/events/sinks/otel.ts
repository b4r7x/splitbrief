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
import { assertNever } from '../../../utils/type-guards.js';
import { error } from '../../../utils/error.js';
import { protectConsumerPayload } from '../../../core/consumer-policy.js';
import { projectEngineEventForTranscriptPolicy } from '../protection/protect.js';
import { SPLITBRIEF_IDENTITY } from '../../../core/identity.js';

export interface OtelSinkOptions {
  provider: TracerProvider;
  serviceName?: string;
  persistTranscript?: boolean | undefined;
}

function otelString(value: string): string {
  const payload = protectConsumerPayload({ context: 'otel', payload: value }).payload;
  return typeof payload === 'string' ? payload : '';
}

// SDK v2 pattern — context is propagated by passing it explicitly to startSpan, no global registration.
export function createOtelSink(opts: OtelSinkOptions): EventSink {
  const namespace = SPLITBRIEF_IDENTITY.slug;
  const tracer = opts.provider.getTracer(opts.serviceName ?? namespace);
  const persistTranscript = opts.persistTranscript ?? true;

  let workflowSpan: Span | null = null;
  let workflowCtx: Context = ROOT_CONTEXT;
  let phaseSpan: Span | null = null;
  let phaseCtx: Context = ROOT_CONTEXT;
  let lastPhase: string | null = null;
  const taskSpans = new Map<string, Span>();

  return (rawEvent: EngineEvent) => {
    const event = projectEngineEventForTranscriptPolicy(rawEvent, persistTranscript);
    if (event === null) return;

    switch (event.type) {
      case 'workflow_started': {
        workflowSpan = tracer.startSpan(
          `${namespace}.workflow`,
          {
            kind: SpanKind.INTERNAL,
            attributes: {
              [`${namespace}.feature`]: otelString(event.feature),
            },
          },
          ROOT_CONTEXT,
        );
        workflowCtx = trace.setSpan(ROOT_CONTEXT, workflowSpan);
        return;
      }
      case 'workflow_config': {
        if (workflowSpan) {
          workflowSpan.setAttribute(`${namespace}.mode`, event.mode);
          workflowSpan.setAttribute(`${namespace}.planner.tool`, otelString(event.plannerTool));
          if (event.plannerModel)
            workflowSpan.setAttribute(`${namespace}.planner.model`, otelString(event.plannerModel));
          workflowSpan.setAttribute(
            `${namespace}.implementer.tool`,
            otelString(event.implementerTool),
          );
          if (event.implementerModel)
            workflowSpan.setAttribute(
              `${namespace}.implementer.model`,
              otelString(event.implementerModel),
            );
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
            `${namespace}.workflow`,
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
            `${namespace}.phase.${event.phase}`,
            {
              attributes: { [`${namespace}.phase`]: event.phase },
            },
            workflowCtx,
          );
          phaseCtx = trace.setSpan(workflowCtx, phaseSpan);
          lastPhase = event.phase;
        }
        if (event.status === 'done' && phaseSpan && event.phase === lastPhase) {
          if (event.duration !== undefined) {
            phaseSpan.setAttribute(`${namespace}.phase.duration_ms`, event.duration);
          }
        }
        return;
      }
      case 'task_started': {
        if (workflowSpan) {
          const parentCtx = phaseSpan ? phaseCtx : workflowCtx;
          const span = tracer.startSpan(
            `${namespace}.task`,
            {
              attributes: {
                [`${namespace}.task.id`]: taskIdToString(event.taskId),
                [`${namespace}.task.index`]: event.index,
                [`${namespace}.task.total`]: event.total,
                ...(persistTranscript
                  ? {
                      [`${namespace}.task.title`]: otelString(event.title),
                      [`${namespace}.task.file`]: otelString(event.file),
                      [`${namespace}.task.action`]: otelString(event.action),
                    }
                  : {}),
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
          span.setAttribute(`${namespace}.task.method`, event.method);
          span.setAttribute(`${namespace}.task.retries`, event.retries);
          span.setAttribute(`${namespace}.task.duration_ms`, event.duration);
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
          if (persistTranscript) {
            span.setAttribute(`${namespace}.task.skip_reason`, otelString(event.reason));
          }
          span.end();
          taskSpans.delete(taskIdToString(event.taskId));
        }
        return;
      }
      case 'cost_update': {
        if (workflowSpan) {
          workflowSpan.setAttribute(
            `${namespace}.cost.input_tokens`,
            totalInputTokens(event.tokenUsage),
          );
          workflowSpan.setAttribute(
            `${namespace}.cost.output_tokens`,
            totalOutputTokens(event.tokenUsage),
          );
        }
        return;
      }
      case 'validate': {
        const span = phaseSpan ?? workflowSpan;
        if (span && event.status === 'done') {
          span.addEvent(`${namespace}.validate`, {
            [`${namespace}.validate.passed`]: event.passed,
            [`${namespace}.validate.typecheck`]: event.stages.typecheck,
            [`${namespace}.validate.lint`]: event.stages.lint,
            [`${namespace}.validate.test`]: event.stages.test,
            ...(event.error ? { [`${namespace}.validate.error`]: otelString(event.error) } : {}),
          });
        }
        return;
      }
      case 'error': {
        if (workflowSpan) {
          const message = otelString(event.message);
          workflowSpan.recordException(error('engine-event-error', message));
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
          workflowSpan.addEvent(`${namespace}.warning`, {
            [`${namespace}.warning.message`]: otelString(event.message),
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
      case 'turn_interrupted':
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
      case 'brief_readiness_passed':
      case 'brief_readiness_blocked':
      case 'drift_report':
      case 'drift_chain_detected':
      case 'snapshot_created':
      case 'snapshot_restored':
      case 'snapshot_restore_conflict':
      case 'mode_resolved':
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
      case 'validation_baseline':
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
      case 'runner_call_started':
      case 'runner_call_text_delta':
      case 'runner_call_usage':
      case 'runner_call_tool_use':
      case 'runner_call_activity':
      case 'runner_call_session_id':
      case 'runner_call_artifact':
      case 'runner_call_warning':
      case 'runner_call_error':
      case 'runner_call_completed':
      case 'runner_call_stalled':
      case 'runner_call_stall_cleared':
        return;
      default:
        return assertNever(event);
    }
  };
}
