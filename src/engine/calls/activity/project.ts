import type { z } from 'zod';
import { stripTerminalControls } from '../../../utils/display-text/sanitize.js';
import { redactSecretsWithMetadata } from '../../../utils/redact/secrets.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { assertNever } from '../../../utils/type-guards.js';
import { parseToolInputDelta, toolUseDetails } from './details.js';
import type { RunnerCallActivityStageSchema } from '../schema.js';
import type { RunnerCallEvent, RunnerCallWarning } from '../types.js';
import { showsRunnerCallWarningOnPrimarySurface } from '../warnings.js';
import {
  releaseCallActivityMemory,
  releaseToolUseActivityMemory,
  retainToolDeltaTarget,
  type RunnerCallActivityKind,
} from './memory.js';

const RUNNER_ACTIVITY_MAX_LENGTH = 512;
const RUNNER_ACTIVITY_TARGET_MAX_LENGTH = 2048;

type RunnerCallActivityStage = z.infer<typeof RunnerCallActivityStageSchema>;

export interface RunnerCallActivityProjection {
  activityId: string;
  stage: RunnerCallActivityStage;
  kind: RunnerCallActivityKind;
  label: string;
  target?: string | undefined;
  description?: string | undefined;
  moreLines?: number | undefined;
  redacted: boolean;
  rawAvailable: boolean;
  expandId: string;
  textPartial?: string | undefined;
  diagnosticPartial?: string | undefined;
  /** Raw model ids the warning names, carried for display-layer catalog resolution. */
  originalModel?: string | undefined;
  fallbackModel?: string | undefined;
  /** The call's terminal error: the process went away before it ended. */
  endUnknown?: true;
}

interface ActivityText {
  text: string;
  redacted: boolean;
}

export function projectRunnerCallActivity(
  event: RunnerCallEvent,
  sequence: number,
  rootDir: string,
): RunnerCallActivityProjection | null {
  switch (event.type) {
    case 'call_text_delta':
      if (event.channel !== 'system') return null;
      return buildActivity({
        activityId: `${event.callId}:system`,
        stage: 'updated',
        kind: 'text',
        label: 'system activity',
        textPartial: event.text,
      });
    case 'call_stderr_delta':
      return null;
    case 'call_tool_use_delta': {
      const name = event.name ?? event.toolUseId ?? 'unknown';
      const toolUseId = event.toolUseId;
      const activity = toolActivity({
        callId: event.callId,
        sequence,
        stage: event.inputDelta.trim().length > 0 ? 'updated' : 'started',
        toolUseId,
        name,
        input: parseToolInputDelta(event.inputDelta),
        rootDir,
      });
      if (activity === null || toolUseId === null) return activity;
      const retained = retainToolDeltaTarget(event.callId, toolUseId, activity);
      return {
        ...activity,
        kind: retained.kind,
        label: retained.label,
        redacted: retained.redacted,
        ...(retained.target !== undefined && { target: retained.target }),
        ...(retained.description !== undefined && { description: retained.description }),
        ...(retained.moreLines !== undefined && { moreLines: retained.moreLines }),
      };
    }
    case 'call_tool_use_done': {
      const activity = toolActivity({
        callId: event.callId,
        sequence,
        stage: 'completed',
        toolUseId: event.toolUse.id,
        name: event.toolUse.name,
        input: event.toolUse.input,
        rootDir,
      });
      releaseToolUseActivityMemory(event.callId, event.toolUse.id);
      return activity;
    }
    case 'call_session_id':
      return null;
    case 'call_artifact':
      return buildActivity({
        activityId: `${event.callId}:artifact:${event.artifact.id}`,
        stage: 'completed',
        kind: 'artifact',
        label: `artifact ${event.artifact.name}`,
        target: event.artifact.path ?? event.artifact.name,
      });
    case 'call_warning':
      return warningActivity(event.callId, event.warning);
    case 'call_unknown_upstream':
      return null;
    case 'call_error':
      releaseCallActivityMemory(event.callId);
      return buildActivity({
        activityId: `${event.callId}:terminal`,
        stage: event.status,
        kind: 'error',
        label: event.status,
        diagnosticPartial: event.error.message,
        rawAvailable: event.partial,
        endUnknown: event.endUnknown,
      });
    // A success is told by its settled batch and the block after it; only a failure is news.
    case 'call_completed':
      releaseCallActivityMemory(event.callId);
      return null;
    case 'call_started':
    case 'call_runtime_status':
    case 'call_usage':
    case 'call_stalled':
    case 'call_stall_cleared':
    case 'call_heartbeat':
      return null;
  }

  return assertNever(event);
}

function toolActivity(opts: {
  callId: string;
  sequence: number;
  stage: RunnerCallActivityStage;
  toolUseId: string | null;
  name: string;
  input: Record<string, unknown> | null;
  rootDir: string;
}): RunnerCallActivityProjection | null {
  if (opts.name.toLowerCase() === 'structuredoutput') return null;
  const details = toolUseDetails(opts.name, opts.input, opts.rootDir);
  return buildActivity({
    activityId: `${opts.callId}:tool:${opts.toolUseId ?? opts.sequence}`,
    stage: opts.stage,
    ...details,
  });
}

function warningActivity(
  callId: string,
  warning: RunnerCallWarning,
): RunnerCallActivityProjection | null {
  if (!showsRunnerCallWarningOnPrimarySurface(warning)) return null;
  const kind = warning.severity === 'error' ? 'error' : 'warning';
  const diagnosticPartial = cleanActivityText(warning.message, RUNNER_ACTIVITY_TARGET_MAX_LENGTH);
  const identity =
    warning.fingerprint || warningActivityIdentity(kind, diagnosticPartial?.text ?? '');

  return buildActivity({
    activityId: `${callId}:warning:${identity}`,
    stage: 'warning',
    kind,
    label: kind,
    diagnosticPartial: warning.message,
    rawAvailable: warning.rawRef !== undefined,
    redacted: warning.redacted,
    ...(warning.originalModel !== undefined && { originalModel: warning.originalModel }),
    ...(warning.fallbackModel !== undefined && { fallbackModel: warning.fallbackModel }),
  });
}

function warningActivityIdentity(label: string, diagnosticPartial: string): string {
  return sha256Hex(`${label}\0${diagnosticPartial}`).slice(0, 16);
}

function buildActivity(opts: {
  activityId: string;
  stage: RunnerCallActivityStage;
  kind: RunnerCallActivityKind;
  label: string;
  target?: string | undefined;
  rawAvailable?: boolean | undefined;
  redacted?: boolean | undefined;
  textPartial?: string | undefined;
  diagnosticPartial?: string | undefined;
  description?: string | undefined;
  moreLines?: number | undefined;
  originalModel?: string | undefined;
  fallbackModel?: string | undefined;
  endUnknown?: true | undefined;
}): RunnerCallActivityProjection | null {
  const label = cleanActivityText(opts.label, RUNNER_ACTIVITY_MAX_LENGTH);
  if (label === null) return null;

  const target =
    opts.target === undefined
      ? undefined
      : cleanActivityText(opts.target, RUNNER_ACTIVITY_TARGET_MAX_LENGTH);
  const textPartial =
    opts.textPartial === undefined
      ? undefined
      : cleanActivityText(opts.textPartial, RUNNER_ACTIVITY_TARGET_MAX_LENGTH);
  const diagnosticPartial =
    opts.diagnosticPartial === undefined
      ? undefined
      : cleanActivityText(opts.diagnosticPartial, RUNNER_ACTIVITY_TARGET_MAX_LENGTH);
  const description =
    opts.description === undefined
      ? undefined
      : cleanActivityText(opts.description, RUNNER_ACTIVITY_MAX_LENGTH);
  return {
    activityId: opts.activityId,
    stage: opts.stage,
    kind: opts.kind,
    label: label.text,
    ...(target !== undefined && target !== null && { target: target.text }),
    ...(description !== undefined && description !== null && { description: description.text }),
    ...(opts.moreLines !== undefined && { moreLines: opts.moreLines }),
    rawAvailable: opts.rawAvailable === true,
    expandId: opts.activityId,
    ...(textPartial !== undefined && textPartial !== null && { textPartial: textPartial.text }),
    ...(diagnosticPartial !== undefined &&
      diagnosticPartial !== null && { diagnosticPartial: diagnosticPartial.text }),
    ...(opts.originalModel !== undefined && { originalModel: opts.originalModel }),
    ...(opts.fallbackModel !== undefined && { fallbackModel: opts.fallbackModel }),
    ...(opts.endUnknown && { endUnknown: true }),
    redacted:
      opts.redacted === true ||
      label.redacted ||
      target?.redacted === true ||
      textPartial?.redacted === true ||
      diagnosticPartial?.redacted === true ||
      description?.redacted === true,
  };
}

function cleanActivityText(value: string, maxLength: number): ActivityText | null {
  const redacted = redactSecretsWithMetadata(stripTerminalControls(value));
  const clean = redacted.text.replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return null;
  return {
    text:
      clean.length <= maxLength
        ? clean
        : `${clean.slice(0, maxLength - 1).replace(/[\uD800-\uDBFF]$/, '')}…`,
    redacted: redacted.redacted,
  };
}
