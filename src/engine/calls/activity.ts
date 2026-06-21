import type { z } from 'zod';
import { redactSecretsWithMetadata } from '../../utils/redact.js';
import { stripTerminalControls, truncateTerminalDisplayText } from '../../utils/display-text.js';
import { sha256Hex } from '../../utils/sha256.js';
import { isRecord } from '../../utils/type-guards.js';
import type { RunnerCallActivityKindSchema, RunnerCallActivityStageSchema } from './schema.js';
import type { RunnerCallEvent } from './types.js';

const RUNNER_ACTIVITY_MAX_CELLS = 80;
const RUNNER_ACTIVITY_TARGET_MAX_CELLS = 120;

type RunnerCallActivityStage = z.infer<typeof RunnerCallActivityStageSchema>;
type RunnerCallActivityKind = z.infer<typeof RunnerCallActivityKindSchema>;

export interface RunnerCallActivityProjection {
  activityId: string;
  stage: RunnerCallActivityStage;
  kind: RunnerCallActivityKind;
  label: string;
  target?: string | undefined;
  redacted: boolean;
  rawAvailable: boolean;
  expandId: string;
  textPartial?: string | undefined;
  diagnosticPartial?: string | undefined;
}

interface ActivityText {
  text: string;
  redacted: boolean;
}

interface ActivityDetails {
  kind: RunnerCallActivityKind;
  label: string;
  target?: string | undefined;
  rawAvailable?: boolean | undefined;
  textPartial?: string | undefined;
  diagnosticPartial?: string | undefined;
}

export function projectRunnerCallActivity(
  event: RunnerCallEvent,
  sequence: number,
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
      return warningActivity(event.callId, 'stderr', event.text);
    case 'call_tool_use_delta': {
      const name = event.name ?? event.toolUseId ?? 'unknown';
      return toolActivity({
        callId: event.callId,
        sequence,
        stage: event.inputDelta.trim().length > 0 ? 'updated' : 'started',
        toolUseId: event.toolUseId,
        name,
        input: parseToolInputDelta(event.inputDelta),
      });
    }
    case 'call_tool_use_done':
      return toolActivity({
        callId: event.callId,
        sequence,
        stage: 'completed',
        toolUseId: event.toolUse.id,
        name: event.toolUse.name,
        input: event.toolUse.input,
      });
    case 'call_session_id':
      return buildActivity({
        activityId: `${event.callId}:session`,
        stage: 'completed',
        kind: 'session',
        label: `session ${event.nativeSessionId}`,
        target: event.nativeSessionId,
      });
    case 'call_artifact':
      return buildActivity({
        activityId: `${event.callId}:artifact:${event.artifact.id}`,
        stage: 'completed',
        kind: 'artifact',
        label: `artifact ${event.artifact.name}`,
        target: event.artifact.path ?? event.artifact.name,
      });
    case 'call_warning':
      return warningActivity(event.callId, event.warning.code, event.warning.message);
    case 'call_unknown_upstream':
      return warningActivity(event.callId, unknownUpstreamWarningLabel(event), event.rawPreview);
    case 'call_error':
      return buildActivity({
        activityId: `${event.callId}:terminal`,
        stage: event.status,
        kind: 'error',
        label: `${event.status} ${event.error.code}`,
        diagnosticPartial: event.error.message,
        rawAvailable: event.partial,
      });
    case 'call_completed':
      return buildActivity({
        activityId: `${event.callId}:terminal`,
        stage: 'completed',
        kind: 'text',
        label: `completed ${event.role}`,
      });
    case 'call_started':
    case 'call_usage':
      return null;
  }
}

function toolActivity(opts: {
  callId: string;
  sequence: number;
  stage: RunnerCallActivityStage;
  toolUseId: string | null;
  name: string;
  input: Record<string, unknown> | null;
}): RunnerCallActivityProjection | null {
  const details = toolUseDetails(opts.name, opts.input);
  return buildActivity({
    activityId: `${opts.callId}:tool:${opts.toolUseId ?? opts.name ?? opts.sequence}`,
    stage: opts.stage,
    ...details,
  });
}

function warningActivity(
  callId: string,
  code: string,
  message: string,
): RunnerCallActivityProjection | null {
  const label = cleanActivityText(`warning ${code}`, RUNNER_ACTIVITY_MAX_CELLS);
  if (label === null) return null;
  const diagnosticPartial = cleanActivityText(message, RUNNER_ACTIVITY_TARGET_MAX_CELLS);
  const identity = warningActivityIdentity(label.text, diagnosticPartial?.text ?? '');

  return buildActivity({
    activityId: `${callId}:warning:${identity}`,
    stage: 'warning',
    kind: 'warning',
    label: `warning ${code}`,
    diagnosticPartial: message,
    rawAvailable: true,
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
  textPartial?: string | undefined;
  diagnosticPartial?: string | undefined;
}): RunnerCallActivityProjection | null {
  const label = cleanActivityText(opts.label, RUNNER_ACTIVITY_MAX_CELLS);
  if (label === null) return null;

  const target =
    opts.target === undefined
      ? undefined
      : cleanActivityText(opts.target, RUNNER_ACTIVITY_TARGET_MAX_CELLS);
  const textPartial =
    opts.textPartial === undefined
      ? undefined
      : cleanActivityText(opts.textPartial, RUNNER_ACTIVITY_TARGET_MAX_CELLS);
  const diagnosticPartial =
    opts.diagnosticPartial === undefined
      ? undefined
      : cleanActivityText(opts.diagnosticPartial, RUNNER_ACTIVITY_TARGET_MAX_CELLS);
  return {
    activityId: opts.activityId,
    stage: opts.stage,
    kind: opts.kind,
    label: label.text,
    ...(target !== undefined && target !== null && { target: target.text }),
    rawAvailable: opts.rawAvailable === true,
    expandId: opts.activityId,
    ...(textPartial !== undefined && textPartial !== null && { textPartial: textPartial.text }),
    ...(diagnosticPartial !== undefined &&
      diagnosticPartial !== null && { diagnosticPartial: diagnosticPartial.text }),
    redacted:
      label.redacted ||
      target?.redacted === true ||
      textPartial?.redacted === true ||
      diagnosticPartial?.redacted === true,
  };
}

function unknownUpstreamWarningLabel(
  event: Extract<RunnerCallEvent, { type: 'call_unknown_upstream' }>,
): string {
  const parts = [
    'unknown_upstream',
    event.backendMetadata.parser,
    event.backendMetadata.upstreamType,
    event.backendMetadata.channel,
  ].filter((part): part is string => part !== undefined && part.length > 0);
  return parts.join(':');
}

function parseToolInputDelta(inputDelta: string | undefined): Record<string, unknown> | null {
  if (inputDelta === undefined || inputDelta.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(inputDelta);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toolUseDetails(name: string, input: Record<string, unknown> | null): ActivityDetails {
  const normalized = name.toLowerCase();
  const filePath = stringInput(input, 'file_path') ?? stringInput(input, 'path');
  const command = stringInput(input, 'command') ?? stringInput(input, 'cmd');
  const pattern =
    stringInput(input, 'pattern') ?? stringInput(input, 'regex') ?? stringInput(input, 'query');
  const agentType = stringInput(input, 'subagent_type') ?? stringInput(input, 'agent_type');
  const url = stringInput(input, 'url') ?? stringInput(input, 'uri');
  const mcpTarget = mcpCallTarget(input);

  if (command !== undefined && isCommandTool(normalized)) {
    return { kind: 'command', label: `running ${command}`, target: command };
  }
  if (isPatchTool(normalized)) return { kind: 'edit', label: 'applying patch' };
  if (filePath !== undefined && isReadTool(normalized)) {
    return { kind: 'read', label: `reading ${filePath}`, target: filePath };
  }
  if (filePath !== undefined && isWriteTool(normalized)) {
    return { kind: 'write', label: `editing ${filePath}`, target: filePath };
  }
  if (pattern !== undefined && isGrepTool(normalized)) {
    return { kind: 'search', label: `searching ${pattern}`, target: pattern };
  }
  if (pattern !== undefined && isGlobTool(normalized)) {
    return { kind: 'glob', label: `matching ${pattern}`, target: pattern };
  }
  if (isTaskTool(normalized, agentType)) {
    return { kind: 'task', label: `task ${agentType ?? name}`, target: agentType ?? name };
  }

  const target = safeCallTarget(url);
  if (target !== null && isWebTool(normalized)) {
    return { kind: 'web', label: `calling ${name} ${target}`, target };
  }
  if (mcpTarget !== null && isMcpTool(normalized)) {
    return { kind: 'mcp', label: `calling ${name} ${mcpTarget}`, target: mcpTarget };
  }
  if (target !== null && isMcpTool(normalized)) {
    return { kind: 'mcp', label: `calling ${name} ${target}`, target };
  }
  const domain = stringInput(input, 'domain');
  if (domain !== undefined && isExternalCallTool(normalized)) {
    return {
      kind: activityKindForExternalTool(normalized),
      label: `calling ${name} ${domain}`,
      target: domain,
    };
  }
  if (isExternalCallTool(normalized)) {
    return { kind: activityKindForExternalTool(normalized), label: `calling ${name}` };
  }
  if (isPlanTool(normalized)) return { kind: 'plan', label: `planning ${name}` };

  if (filePath !== undefined)
    return { kind: 'unknown', label: `${name} ${filePath}`, target: filePath };
  if (pattern !== undefined)
    return { kind: 'unknown', label: `${name} ${pattern}`, target: pattern };
  if (command !== undefined)
    return { kind: 'unknown', label: `${name} ${command}`, target: command };
  return { kind: 'unknown', label: `tool ${name}` };
}

function mcpCallTarget(input: Record<string, unknown> | null): string | null {
  const server = stringInput(input, 'server');
  const toolName = stringInput(input, 'tool_name');
  if (server === undefined && toolName === undefined) return null;
  return [server, toolName].filter((part) => part !== undefined).join('/');
}

function stringInput(input: Record<string, unknown> | null, key: string): string | undefined {
  const value = input?.[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function safeCallTarget(url: string | undefined): string | null {
  if (url === undefined) return null;
  try {
    return new URL(url).hostname;
  } catch {
    try {
      return new URL(`https://${url}`).hostname;
    } catch {
      return null;
    }
  }
}

function isCommandTool(name: string): boolean {
  return name.includes('bash') || name.includes('shell') || name.includes('exec');
}

function isReadTool(name: string): boolean {
  return name === 'read' || name.includes('read_file') || name.includes('view');
}

function isWriteTool(name: string): boolean {
  return name.includes('edit') || name.includes('write');
}

function isPatchTool(name: string): boolean {
  return name.includes('patch');
}

function isGrepTool(name: string): boolean {
  return name.includes('grep') || name.includes('search') || name.includes('rg');
}

function isGlobTool(name: string): boolean {
  return name.includes('glob');
}

function isTaskTool(name: string, agentType: string | undefined): boolean {
  return (
    name === 'task' || name === 'agent' || name.includes('subagent') || agentType !== undefined
  );
}

function isWebTool(name: string): boolean {
  return name.includes('web') || name.includes('fetch');
}

function isMcpTool(name: string): boolean {
  return name.includes('mcp');
}

function isExternalCallTool(name: string): boolean {
  return isWebTool(name) || isMcpTool(name);
}

function isPlanTool(name: string): boolean {
  return name.includes('plan');
}

function activityKindForExternalTool(name: string): RunnerCallActivityKind {
  return isMcpTool(name) ? 'mcp' : 'web';
}

function cleanActivityText(value: string, maxCells: number): ActivityText | null {
  const redacted = redactSecretsWithMetadata(stripTerminalControls(value));
  const clean = redacted.text.replace(/\s+/g, ' ').trim();
  if (clean.length === 0) return null;
  return {
    text: truncateTerminalDisplayText(clean, maxCells),
    redacted: redacted.redacted,
  };
}
