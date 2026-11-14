import type { RunnerCallActivityKind } from './memory.js';

export function isCommandTool(name: string): boolean {
  return (
    name.includes('bash') ||
    name.includes('shell') ||
    name.includes('exec') ||
    name.includes('command')
  );
}

export function isReadTool(name: string): boolean {
  return name === 'read' || name.includes('read_file') || name.includes('view');
}

export function isWriteTool(name: string): boolean {
  return name.includes('edit') || name.includes('write') || name.includes('replace');
}

export function isPatchTool(name: string): boolean {
  return name.includes('patch');
}

export function isGrepTool(name: string): boolean {
  return name.includes('grep') || name.includes('search') || name.includes('rg');
}

export function isGlobTool(name: string): boolean {
  return name.includes('glob');
}

export function isTaskTool(name: string, agentType: string | undefined): boolean {
  return (
    name === 'task' ||
    name === 'agent' ||
    name === 'spawn_agent' ||
    name.includes('subagent') ||
    agentType !== undefined
  );
}

export function isWebTool(name: string): boolean {
  return name.includes('web') || name.includes('fetch');
}

export function isMcpTool(name: string): boolean {
  return name.includes('mcp');
}

export function isExternalCallTool(name: string): boolean {
  return isWebTool(name) || isMcpTool(name);
}

export function isPlanTool(name: string): boolean {
  return name.includes('plan');
}

export function activityKindForExternalTool(name: string): RunnerCallActivityKind {
  return isMcpTool(name) ? 'mcp' : 'web';
}
