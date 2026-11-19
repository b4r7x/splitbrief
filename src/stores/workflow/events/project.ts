import type { EngineEvent, EngineEventOf } from '../../../engine/events/types.js';
import { sanitizeTerminalDiagnosticText } from '../../../utils/display-text/diagnostic.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text/sanitize.js';

export function projectEventForTuiEventLog(event: EngineEvent): EngineEvent | null {
  switch (event.type) {
    case 'runner_call_activity':
      return projectRunnerActivityForTuiEventLog(event);
    // The transcript reads only that the call finished; an error ends it through its terminal activity.
    case 'runner_call_completed':
      return {
        type: 'runner_call_completed',
        ts: event.ts,
        phase: event.phase,
        ...(event.taskId !== undefined && { taskId: event.taskId }),
        callId: event.callId,
        role: event.role,
        backendKind: event.backendKind,
        sequence: event.sequence,
        status: event.status,
        error: null,
        partial: false,
        startedAt: event.startedAt,
        endedAt: event.endedAt,
        durationMs: event.durationMs,
        usage: null,
        nativeSessionId: null,
      };
    case 'runner_call_started':
    case 'runner_call_runtime_status':
    case 'runner_call_text_delta':
    case 'runner_call_usage':
    case 'runner_call_tool_use':
    case 'runner_call_session_id':
    case 'runner_call_warning':
    case 'runner_call_error':
    case 'runner_call_stalled':
    case 'runner_call_stall_cleared':
    case 'runner_call_heartbeat':
      return null;
    case 'planner_heartbeat':
      return null;
    // The plan announcement drives the run view's briefs, not a transcript row, and it is
    // republished on every resume and re-attach. Keeping it out of the capped log spends no entries
    // on a payload nothing renders.
    case 'tasks_planned':
      return null;
    case 'info':
      return { ...event, message: sanitizeTerminalDiagnosticText(event.message) };
    // A warning may state its facts one per line, as a readiness warning or a plan send-back does.
    case 'warning':
      return {
        ...event,
        ...(event.checkout !== undefined && {
          checkout: {
            summary: sanitizeTerminalDiagnosticText(event.checkout.summary),
            details: event.checkout.details.map((line) => sanitizeTerminalDiagnosticText(line)),
          },
        }),
        message: sanitizeTerminalDiagnosticText(event.message, { preserveLineBreaks: true }),
      };
    case 'error':
      return { ...event, message: sanitizeTerminalDiagnosticText(event.message) };
    default:
      return event;
  }
}

function projectRunnerActivityForTuiEventLog(
  event: EngineEventOf<'runner_call_activity'>,
): EngineEventOf<'runner_call_activity'> | null {
  if (event.kind === 'session') return null;
  const label = cleanRequiredTuiEventLogText(event.label);
  if (label === null) return null;

  const target = cleanOptionalTuiEventLogText(event.target);
  const description = cleanOptionalTuiEventLogText(event.description);
  const textPartial = cleanOptionalTuiEventLogText(event.textPartial);
  const diagnosticPartial = cleanOptionalTuiEventLogText(event.diagnosticPartial);
  const rawAvailable = event.rawAvailable === true;
  const runnerName = cleanOptionalTuiEventLogText(event.runnerName);
  const model = cleanOptionalTuiEventLogText(event.model);
  const axes = event.axes?.map(cleanOptionalTuiEventLogText).filter((axis) => axis !== undefined);
  const originalModel = cleanOptionalTuiEventLogText(event.originalModel);
  const fallbackModel = cleanOptionalTuiEventLogText(event.fallbackModel);
  const redacted =
    event.redacted ||
    label.changed ||
    target?.changed === true ||
    description?.changed === true ||
    textPartial?.changed === true ||
    diagnosticPartial?.changed === true ||
    runnerName?.changed === true ||
    model?.changed === true ||
    axes?.some((axis) => axis.changed) === true ||
    originalModel?.changed === true ||
    fallbackModel?.changed === true;

  return {
    type: 'runner_call_activity',
    ts: event.ts,
    phase: event.phase,
    ...(event.taskId !== undefined && { taskId: event.taskId }),
    callId: event.callId,
    role: event.role,
    backendKind: event.backendKind,
    ...(runnerName !== undefined && { runnerName: runnerName.text }),
    ...(model !== undefined && { model: model.text }),
    ...(axes !== undefined && { axes: axes.map((axis) => axis.text) }),
    ...(event.attempt !== undefined && { attempt: event.attempt }),
    sequence: event.sequence,
    activityId: event.activityId,
    stage: event.stage,
    kind: event.kind,
    label: label.text,
    ...(target !== undefined && { target: target.text }),
    ...(description !== undefined && { description: description.text }),
    ...(event.moreLines !== undefined && { moreLines: event.moreLines }),
    redacted,
    ...(rawAvailable && { rawAvailable: true }),
    ...(textPartial !== undefined && { textPartial: textPartial.text }),
    ...(diagnosticPartial !== undefined && { diagnosticPartial: diagnosticPartial.text }),
    ...(originalModel !== undefined && { originalModel: originalModel.text }),
    ...(fallbackModel !== undefined && { fallbackModel: fallbackModel.text }),
    ...(event.endUnknown && { endUnknown: true }),
  };
}

function cleanRequiredTuiEventLogText(
  value: string,
): { readonly text: string; readonly changed: boolean } | null {
  const clean = sanitizeTerminalDisplayText(value);
  if (clean.length === 0) return null;
  return { text: clean, changed: clean !== value };
}

function cleanOptionalTuiEventLogText(
  value: string | undefined,
): { readonly text: string; readonly changed: boolean } | undefined {
  if (value === undefined) return undefined;
  const clean = sanitizeTerminalDisplayText(value);
  return clean.length === 0 ? undefined : { text: clean, changed: clean !== value };
}
