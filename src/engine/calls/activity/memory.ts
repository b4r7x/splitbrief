import type { z } from 'zod';
import type { RunnerCallActivityKindSchema } from '../schema.js';

export type RunnerCallActivityKind = Exclude<
  z.infer<typeof RunnerCallActivityKindSchema>,
  'session'
>;

interface RememberedActivityDetails {
  kind: RunnerCallActivityKind;
  label: string;
  target: string;
  redacted: boolean;
  description?: string | undefined;
  moreLines?: number | undefined;
}

interface ActivityTargetDetails {
  kind: RunnerCallActivityKind;
  label: string;
  target?: string | undefined;
  redacted: boolean;
  description?: string | undefined;
  moreLines?: number | undefined;
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
      ...(activity.description !== undefined && { description: activity.description }),
      ...(activity.moreLines !== undefined && { moreLines: activity.moreLines }),
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
    ...(remembered.description !== undefined && { description: remembered.description }),
    ...(remembered.moreLines !== undefined && { moreLines: remembered.moreLines }),
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
