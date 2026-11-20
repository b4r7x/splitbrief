import { z } from 'zod';
import { RUNNER_KINDS } from './enums.js';

// Primitive runner-call vocabulary only. The canonical event/result schemas live
// in `src/engine/calls/schema.ts`.
export const RUNNER_CALL_ROLES = [
  'planner',
  'implementer',
  'review',
  'summary',
  'compaction',
  'escalation',
] as const;

export const RUNNER_CALL_BACKEND_KINDS = RUNNER_KINDS;

export const RUNNER_CALL_TEXT_CHANNELS = ['stdout', 'assistant', 'result', 'system'] as const;
export const RUNNER_CALL_NON_TEXT_CHANNELS = ['stderr', 'tool'] as const;

export const RUNNER_CALL_CHANNELS = [
  ...RUNNER_CALL_TEXT_CHANNELS,
  ...RUNNER_CALL_NON_TEXT_CHANNELS,
] as const;

export const RUNNER_CALL_STATUSES = [
  'completed',
  'failed',
  'truncated',
  'aborted',
  'timeout',
  'refused',
  'unsupported_tool',
  'incomplete',
] as const;

export const RUNNER_CALL_FAILURE_STATUSES = [
  'failed',
  'truncated',
  'aborted',
  'timeout',
  'refused',
  'unsupported_tool',
  'incomplete',
] as const;

export const RUNNER_CALL_WARNING_SEVERITIES = ['debug', 'info', 'warning', 'error'] as const;
export const RUNNER_CALL_WARNING_SURFACES = [
  'hidden',
  'status',
  'activity',
  'transcript',
  'debug',
] as const;
export const RUNNER_CALL_ACTIVITY_STAGES = [
  'started',
  'updated',
  'completed',
  'failed',
  'aborted',
  'timeout',
  'truncated',
  'refused',
  'unsupported_tool',
  'incomplete',
  'warning',
] as const;
export const RUNNER_CALL_ACTIVITY_KINDS = [
  'tool',
  'file',
  'text',
  'read',
  'write',
  'edit',
  'command',
  'search',
  'glob',
  'task',
  'mcp',
  'web',
  'plan',
  'session',
  'warning',
  'error',
  'unknown',
] as const;

export const RunnerCallTextChannelSchema = z.enum(RUNNER_CALL_TEXT_CHANNELS);
export type RunnerCallTextChannel = z.infer<typeof RunnerCallTextChannelSchema>;
