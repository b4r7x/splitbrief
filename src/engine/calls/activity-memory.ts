import type { z } from 'zod';
import type { RunnerCallActivityKindSchema } from './schema.js';

type RunnerCallActivityKind = Exclude<z.infer<typeof RunnerCallActivityKindSchema>, 'session'>;

interface RememberedActivityDetails {
  kind: RunnerCallActivityKind;
  label: string;
  target: string;
  redacted: boolean;
}

interface ActivityTargetDetails {
  kind: RunnerCallActivityKind;
  label: string;
  target?: string | undefined;
  redacted: boolean;
}

const memoryByCall = new Map<string, Map<string, RememberedActivityDetails>>();

export function retainToolDeltaTarget(
  callId: string,
  toolUseId: string,
  activity: ActivityTargetDetails,
): ActivityTargetDetails {
  if (activity.target !== undefined) {
    let tools = memoryByCall.get(callId);
    if (tools === undefined) {
      tools = new Map<string, RememberedActivityDetails>();
      memoryByCall.set(callId, tools);
    }
    tools.set(toolUseId, {
      kind: activity.kind,
      label: activity.label,
      target: activity.target,
      redacted: activity.redacted,
    });
    return activity;
  }

  const remembered = memoryByCall.get(callId)?.get(toolUseId);
  if (remembered === undefined) return activity;
  return {
    kind: remembered.kind,
    label: remembered.label,
    target: remembered.target,
    redacted: remembered.redacted,
  };
}

export function releaseToolUseActivityMemory(callId: string, toolUseId: string | null): void {
  if (toolUseId === null) return;
  const tools = memoryByCall.get(callId);
  if (tools === undefined) return;
  tools.delete(toolUseId);
  if (tools.size === 0) memoryByCall.delete(callId);
}

export function releaseCallActivityMemory(callId: string): void {
  memoryByCall.delete(callId);
}
