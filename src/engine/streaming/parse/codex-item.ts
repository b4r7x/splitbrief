import { z } from 'zod';
import { optionalString, isRecord } from '../../../utils/type-guards.js';
import type { ParsedLine } from '../../runners/types.js';

const CodexItemEvent = z.object({
  type: z.enum(['item.started', 'item.completed']),
  item: z.record(z.string(), z.unknown()),
});

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const candidate = optionalString(value, { trim: true, nonEmpty: true });
    if (candidate) return candidate;
  }
  return undefined;
}

function codexToolName(item: Record<string, unknown>): string | null {
  const itemType = firstString(item.type);
  if (!itemType || itemType === 'agent_message') return null;
  return itemType;
}

function codexToolInput(item: Record<string, unknown>): Record<string, unknown> {
  const explicit = item.input ?? item.arguments ?? item.args;
  const input: Record<string, unknown> = isRecord(explicit) ? { ...explicit } : {};
  for (const key of [
    'type',
    'command',
    'path',
    'file',
    'file_path',
    'query',
    'url',
    'server',
    'tool_name',
    'status',
  ]) {
    if (item[key] !== undefined && input[key] === undefined) input[key] = item[key];
  }
  return input;
}

function codexToolOutput(item: Record<string, unknown>): unknown {
  return item.output ?? item.result ?? item.text ?? item.content ?? item.status;
}

export function parseCodexToolItem(event: unknown): ParsedLine | null {
  const parsed = CodexItemEvent.safeParse(event);
  if (!parsed.success) return null;
  const { item } = parsed.data;
  const name = codexToolName(item);
  if (!name) return null;
  const id = firstString(item.id, item.item_id, item.call_id);
  const toolUse = {
    ...(id !== undefined && { id }),
    name,
    input: codexToolInput(item),
  };
  if (parsed.data.type === 'item.started') return { toolUseStart: [toolUse] };
  const output = codexToolOutput(item);
  return {
    toolUseDone: [
      {
        ...toolUse,
        ...(output !== undefined && { output }),
      },
    ],
  };
}
