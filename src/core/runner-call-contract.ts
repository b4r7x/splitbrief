import { z } from 'zod';
import { RUNNER_KINDS } from './schemas/enums.js';

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

export const RUNNER_CALL_USAGE_SEMANTICS = ['delta', 'cumulative', 'final'] as const;
export const RUNNER_CALL_WARNING_SEVERITIES = ['debug', 'info', 'warning', 'error'] as const;
export const RUNNER_CALL_WARNING_SURFACES = [
  'hidden',
  'status',
  'activity',
  'transcript',
  'debug',
] as const;
export const RUNNER_CALL_ARTIFACT_SOURCES = ['stream', 'file', 'tool', 'derived'] as const;
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
  'artifact',
  'warning',
  'error',
  'unknown',
] as const;

const nonnegativeInteger = z.number().int().nonnegative();

export const RunnerCallTextChannelSchema = z.enum(RUNNER_CALL_TEXT_CHANNELS);
export type RunnerCallTextChannel = z.infer<typeof RunnerCallTextChannelSchema>;

export const runnerCallUsageFields = {
  inputTokens: nonnegativeInteger,
  outputTokens: nonnegativeInteger,
  cacheReadTokens: nonnegativeInteger.optional(),
  cacheCreateTokens: nonnegativeInteger.optional(),
  reasoningTokens: nonnegativeInteger.optional(),
} as const;

export const RunnerCallUsageContractSchema = z.strictObject(runnerCallUsageFields);
