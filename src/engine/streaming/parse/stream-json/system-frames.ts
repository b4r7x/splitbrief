import {
  USAGE_LIMIT_WINDOWS,
  usageLimitStep,
  formatUsageLimitWarning,
} from '../../../../core/recovery/usage-limit-step.js';
import { formatDuration } from '../../../../utils/format/time.js';
import { isRecord } from '../../../../utils/type-guards.js';
import type { ParsedWarningInfo } from '../../../runners/types.js';
import { firstString } from '../fields.js';
import { ApiRetryEvent } from './events.js';
import type { StreamParseResult } from './result.js';

/** `overloaded (HTTP 529): retry 2 of 10 in 4.0s`, from the fields Claude Code documents. */
function apiRetryWarning(event: Record<string, unknown>): ParsedWarningInfo {
  const retry = ApiRetryEvent.safeParse(event);
  if (!retry.success) {
    return {
      code: 'claude_api_retry',
      severity: 'warning',
      message: 'retrying a failed API request',
    };
  }
  const { attempt, max_retries, retry_delay_ms, error_status, error } = retry.data;
  const status = error_status === null ? 'no HTTP response' : `HTTP ${error_status}`;
  return {
    code: 'claude_api_retry',
    severity: 'warning',
    message: `${error} (${status}): retry ${attempt} of ${max_retries} in ${formatDuration(retry_delay_ms)}`,
  };
}

/**
 * `claude-opus-5-5 → claude-opus-4-8 (refusal: cyber)`: the models and the cause Claude Code
 * names, short enough that an 80-column row keeps both models. With no cause, its own notice
 * gives the reason. The raw ids also ride along as structured fields, so a display layer that
 * knows the runner's catalog can spell those names without re-parsing the message.
 */
function modelFallbackWarning(event: Record<string, unknown>): ParsedWarningInfo {
  const from = firstString(event.original_model);
  const to = firstString(event.fallback_model);
  const cause = [firstString(event.trigger), firstString(event.api_refusal_category)]
    .filter((part) => part !== undefined)
    .join(': ');
  const notice = firstString(event.content);
  const models = from !== undefined && to !== undefined ? `${from} → ${to}` : 'switched model';
  const reason = cause !== '' ? ` (${cause})` : notice === undefined ? '' : `: ${notice}`;
  return {
    code: 'claude_fallback',
    severity: 'warning',
    message: `${models}${reason}`,
    ...(from !== undefined && { originalModel: from }),
    ...(to !== undefined && { fallbackModel: to }),
  };
}

/** A refusal with no model to fall back to; Claude Code sends it with an empty notice. */
function modelRefusalWarning(event: Record<string, unknown>): ParsedWarningInfo {
  const named = firstString(event.original_model);
  const model = named ?? 'the model';
  const category = firstString(event.api_refusal_category);
  const head = category === undefined ? `${model} refused` : `${model} refused (${category})`;
  const reason = firstString(event.api_refusal_explanation, event.content);
  return {
    code: 'claude_refusal',
    severity: 'error',
    message: `${head}: ${reason ?? 'no fallback model'}`,
    ...(named !== undefined && { originalModel: named }),
  };
}

function permissionDeniedWarning(event: Record<string, unknown>): ParsedWarningInfo {
  const tool = firstString(event.tool_name) ?? 'a tool';
  const decidedBy = firstString(event.decision_reason_type);
  const head = decidedBy === undefined ? `${tool} denied` : `${tool} denied (${decidedBy})`;
  const reason = firstString(event.decision_reason, event.message);
  return {
    code: 'claude_permission_denied',
    severity: 'warning',
    message: reason === undefined ? head : `${head}: ${reason}`,
  };
}

function noticeWarning(
  text: unknown,
  severity: 'warning' | 'error' = 'warning',
): ParsedWarningInfo | null {
  const message = firstString(text);
  return message === undefined ? null : { code: 'claude_notice', severity, message };
}

/**
 * The `system` frames a headless operator needs: a request Claude Code retries, a model it
 * swapped or that refused, a tool call it denied, a notification it colours as a warning or an
 * error (in stream-json mode Claude Code sends its own terminal warnings this way, such as the
 * effort cap), and an informational banner at `warning` level. The frame keeps the severity its
 * activity row is coloured by: a refusal with no fallback and an error-coloured notification
 * are errors, while a retry, a fallback, a denial and a `warning`-level banner stay warnings.
 * A `notice` banner (hook feedback is one), like an `info` or `suggestion` banner and every
 * other frame, is below the warning channel and is bookkeeping.
 */
function systemFrameWarning(
  subtype: string | undefined,
  event: Record<string, unknown>,
): ParsedWarningInfo | null {
  switch (subtype) {
    case 'api_retry':
      return apiRetryWarning(event);
    case 'model_fallback':
    case 'model_consent_fallback':
    case 'model_refusal_fallback':
      return modelFallbackWarning(event);
    case 'model_refusal_no_fallback':
      return modelRefusalWarning(event);
    case 'permission_denied':
      return permissionDeniedWarning(event);
    case 'notification':
      return event.color === 'warning' || event.color === 'error'
        ? noticeWarning(event.text, event.color === 'error' ? 'error' : 'warning')
        : null;
    case 'informational':
      return event.level === 'warning' ? noticeWarning(event.content, 'warning') : null;
    default:
      return null;
  }
}

/**
 * A `system` frame is never text. One the operator needs becomes a warning; the rest — init,
 * hooks, status, thinking-token estimates, background tasks — are Claude Code's own bookkeeping,
 * a heartbeat that keeps a thinking seat from reading as silent.
 */
export function parseSystemProgress(event: Record<string, unknown>): StreamParseResult | null {
  const type = firstString(event.type);
  if (!type) return null;
  const sessionId = firstString(event.session_id);
  if (type === 'system') {
    const subtype = firstString(event.subtype);
    const warning = systemFrameWarning(subtype, event);
    const resolvedModel = subtype === 'init' ? firstString(event.model) : undefined;
    return {
      sessionId,
      ...(subtype === 'init' && { isSessionInit: true }),
      ...(resolvedModel !== undefined && { resolvedModel }),
      ...(warning === null ? { isHeartbeat: true } : { warning: [warning] }),
    };
  }
  if (type === 'api_error') {
    return {
      sessionId,
      warning: [
        {
          code: 'claude_api_error',
          severity: 'warning',
          message: firstString(event.message) ?? type,
        },
      ],
    };
  }
  if (type === 'api_retry' || type === 'plugin_progress') return { sessionId, isHeartbeat: true };
  return null;
}

export function parseRateLimitEvent(event: Record<string, unknown>): StreamParseResult | null {
  if (firstString(event.type) !== 'rate_limit_event') return null;
  const sessionId = firstString(event.session_id);
  const info = isRecord(event.rate_limit_info) ? event.rate_limit_info : null;
  const unified = info !== null && isRecord(info.unifiedWindows) ? info.unifiedWindows : null;
  const warnings: ParsedWarningInfo[] = [];

  if (unified !== null) {
    for (const window of USAGE_LIMIT_WINDOWS) {
      const windowData = isRecord(unified[window]) ? unified[window] : null;
      if (windowData === null) continue;
      const utilization = windowData.utilization;
      if (typeof utilization !== 'number' || !Number.isFinite(utilization)) continue;
      const percent = Math.floor(utilization * 100);
      const step = usageLimitStep(percent);
      if (step === null) continue;

      const resetsAtSeconds = windowData.resetsAt;
      const resetsAt =
        typeof resetsAtSeconds === 'number' && Number.isFinite(resetsAtSeconds)
          ? resetsAtSeconds * 1000
          : undefined;

      warnings.push({
        code: 'claude_rate_limit',
        severity: 'warning',
        message: formatUsageLimitWarning({
          step,
          tool: 'Claude Code',
          window,
          resetsAt,
        }),
        usage: {
          window,
          step,
          ...(resetsAt !== undefined && { resetsAt }),
        },
      });
    }
  }

  return {
    sessionId,
    isHeartbeat: true,
    ...(warnings.length > 0 && { warning: warnings }),
  };
}
