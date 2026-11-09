import { resolve } from 'node:path';
import type { z } from 'zod';
import { SOFT_SEP } from '../../core/separators.js';
import { countNoun } from '../../utils/pluralize.js';
import { redactSecretsWithMetadata } from '../../utils/redact.js';
import { stripTerminalControls } from '../../utils/display-text.js';
import { sha256Hex } from '../../utils/sha256.js';
import { projectRelativePathLabel } from '../../utils/path-links.js';
import { shellCommandFromText } from '../../utils/shell-quote.js';
import { assertNever, isRecord } from '../../utils/type-guards.js';
import {
  type RunnerCallActivityKind,
  releaseCallActivityMemory,
  releaseToolUseActivityMemory,
  retainToolDeltaTarget,
} from './activity-memory.js';
import type { RunnerCallActivityStageSchema } from './schema.js';
import type { RunnerCallEvent, RunnerCallWarning } from './types.js';
import { normalizeRunnerCallWarning, showsRunnerCallWarningOnPrimarySurface } from './warnings.js';

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

interface ActivityDetails {
  kind: RunnerCallActivityKind;
  label: string;
  target?: string | undefined;
  description?: string | undefined;
  moreLines?: number | undefined;
  rawAvailable?: boolean | undefined;
  redacted?: boolean | undefined;
  textPartial?: string | undefined;
  diagnosticPartial?: string | undefined;
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
      return warningActivity(
        event.callId,
        normalizeRunnerCallWarning({
          code: unknownUpstreamWarningLabel(event),
          severity: 'warning',
          source: event.backendMetadata.source ?? 'upstream',
          surface: 'activity',
          message: event.rawPreview,
        }),
      );
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

function toolUseDetails(
  name: string,
  input: Record<string, unknown> | null,
  rootDir: string,
): ActivityDetails {
  const normalized = name.toLowerCase();
  const rawFilePath =
    stringInput(input, 'file_path') ??
    stringInput(input, 'path') ??
    stringInput(input, 'Path') ??
    stringInput(input, 'AbsolutePath') ??
    stringInput(input, 'TargetFile');
  const filePath =
    rawFilePath === undefined
      ? undefined
      : projectRelativePathLabel({ path: rawFilePath, rootDir });
  const command =
    stringInput(input, 'command') ?? stringInput(input, 'cmd') ?? stringInput(input, 'CommandLine');
  const pattern =
    stringInput(input, 'pattern') ??
    stringInput(input, 'globPattern') ??
    stringInput(input, 'regex') ??
    stringInput(input, 'query');
  const agentType = stringInput(input, 'subagent_type') ?? stringInput(input, 'agent_type');
  const url = stringInput(input, 'url') ?? stringInput(input, 'uri');
  const mcpTarget = mcpCallTarget(input);

  if (command !== undefined && isCommandTool(normalized)) {
    const description = stringInput(input, 'description');
    const script = shellCommandFromText(command) ?? command;
    const lines = script
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const firstLine = lines[0];
    if (lines.length >= 2 && firstLine !== undefined) {
      return {
        kind: 'command',
        label: `running ${command}`,
        target: firstLine,
        moreLines: lines.length - 1,
        ...(description !== undefined && { description }),
      };
    }
    return {
      kind: 'command',
      label: `running ${command}`,
      target: command,
      ...(description !== undefined && { description }),
    };
  }
  if (isPatchTool(normalized)) return { kind: 'edit', label: 'applying patch' };
  if (filePath !== undefined && isReadTool(normalized)) {
    const explicitStart =
      positiveIntegerInput(input, 'offset') ?? positiveIntegerInput(input, 'StartLine');
    const endLine = positiveIntegerInput(input, 'EndLine');
    const limit = positiveIntegerInput(input, 'limit');
    const start = explicitStart ?? (endLine !== undefined || limit !== undefined ? 1 : undefined);
    if (start === undefined) {
      return { kind: 'read', label: `reading ${filePath}`, target: filePath };
    }
    const end = endLine ?? (limit === undefined ? 'end' : start + limit - 1);
    const target = `${filePath} :${start}-${end}`;
    return { kind: 'read', label: `reading ${target}`, target };
  }
  if (filePath !== undefined && isWriteTool(normalized)) {
    const raw = input?.new_string ?? input?.content ?? input?.streamContent;
    const text = typeof raw === 'string' ? raw : undefined;
    const lines =
      text === undefined || text.length === 0
        ? 0
        : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    const target = lines === 0 ? filePath : `${filePath}${SOFT_SEP}${countNoun(lines, 'line')}`;
    return { kind: 'write', label: `editing ${target}`, target };
  }
  if (pattern !== undefined && isGrepTool(normalized)) {
    const folder =
      rawFilePath !== undefined && resolve(rootDir, rawFilePath) !== resolve(rootDir)
        ? filePath
        : undefined;
    const glob = stringInput(input, 'glob') ?? stringInput(input, 'include');
    const target = [pattern, folder, glob]
      .filter((part): part is string => part !== undefined)
      .join(SOFT_SEP);
    return { kind: 'search', label: `searching ${target}`, target };
  }
  if (pattern !== undefined && isGlobTool(normalized)) {
    return { kind: 'glob', label: `matching ${pattern}`, target: pattern };
  }
  if (isTaskTool(normalized, agentType)) {
    return {
      kind: 'task',
      label: `task ${agentType ?? name}`,
      ...(agentType !== undefined && { target: agentType }),
    };
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
  if (isReadTool(normalized)) return { kind: 'read', label: 'reading file' };
  if (isWriteTool(normalized)) return { kind: 'write', label: 'editing file' };
  if (isCommandTool(normalized)) return { kind: 'command', label: 'running command' };
  return { kind: 'unknown', label: `tool ${name}` };
}

function mcpCallTarget(input: Record<string, unknown> | null): string | null {
  const server = stringInput(input, 'server');
  const toolName = stringInput(input, 'tool_name');
  if (server === undefined && toolName === undefined) return null;
  return [server, toolName].filter((part) => part !== undefined).join('/');
}

function positiveIntegerInput(
  input: Record<string, unknown> | null,
  key: string,
): number | undefined {
  const value = input?.[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return undefined;
  return value;
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
  return (
    name.includes('bash') ||
    name.includes('shell') ||
    name.includes('exec') ||
    name.includes('command')
  );
}

function isReadTool(name: string): boolean {
  return name === 'read' || name.includes('read_file') || name.includes('view');
}

function isWriteTool(name: string): boolean {
  return name.includes('edit') || name.includes('write') || name.includes('replace');
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
    name === 'task' ||
    name === 'agent' ||
    name === 'spawn_agent' ||
    name.includes('subagent') ||
    agentType !== undefined
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
