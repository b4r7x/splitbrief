import { resolve } from 'node:path';
import { SOFT_SEP } from '../../../core/separators.js';
import { projectRelativePathLabel } from '../../../utils/path/links.js';
import { countNoun } from '../../../utils/pluralize.js';
import { shellCommandFromText } from '../../../utils/shell-quote.js';
import { isRecord } from '../../../utils/type-guards.js';
import type { RunnerCallActivityKind } from './memory.js';
import {
  isCommandTool,
  isPatchTool,
  isReadTool,
  isWriteTool,
  isGrepTool,
  isGlobTool,
  isTaskTool,
  isWebTool,
  isMcpTool,
  isExternalCallTool,
  activityKindForExternalTool,
  isPlanTool,
} from './tool-kinds.js';

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

export function parseToolInputDelta(
  inputDelta: string | undefined,
): Record<string, unknown> | null {
  if (inputDelta === undefined || inputDelta.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(inputDelta);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function toolUseDetails(
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
  if (isReadTool(normalized)) {
    const rawPaths = input?.paths;
    const listedPaths = Array.isArray(rawPaths)
      ? rawPaths
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          .map((value) => projectRelativePathLabel({ path: value.trim(), rootDir }))
      : [];
    const readPaths = filePath === undefined ? listedPaths : [filePath];
    if (readPaths.length > 0) {
      const explicitStart =
        positiveIntegerInput(input, 'offset') ?? positiveIntegerInput(input, 'StartLine');
      const endLine = positiveIntegerInput(input, 'EndLine');
      const limit = positiveIntegerInput(input, 'limit');
      const start = explicitStart ?? (endLine !== undefined || limit !== undefined ? 1 : undefined);
      const end =
        start === undefined
          ? undefined
          : (endLine ?? (limit === undefined ? 'end' : start + limit - 1));
      const targets =
        start === undefined ? readPaths : readPaths.map((path) => `${path}:${start}-${end}`);
      const target = targets.join(SOFT_SEP);
      return { kind: 'read', label: `reading ${target}`, target };
    }
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
