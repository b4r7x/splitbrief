import { z } from 'zod';
import { isRecord } from '../../../utils/type-guards.js';
import type { ParsedLine } from '../../runners/types.js';
import { firstString } from './fields.js';

const CodexItemEvent = z.object({
  type: z.enum(['item.started', 'item.completed']),
  item: z.record(z.string(), z.unknown()),
});

function codexToolName(item: Record<string, unknown>): string | null {
  const itemType = firstString(item.type);
  if (!itemType || itemType === 'agent_message') return null;
  return itemType;
}

// The item fields a reader of the record uses: the activity row reads the command, the file path,
// the URL, the MCP server and tool and the query, and the isolation guard reads the command, its
// `cwd`, the path fields and the paths of `changes`.
const CODEX_ITEM_INPUT_FIELDS = [
  'command',
  'cwd',
  'changes',
  'path',
  'file',
  'file_path',
  'url',
  'server',
  'tool_name',
  'query',
] as const;

/** An item's own `input` or `arguments`, with the item fields a reader uses that it lacks. */
export function codexToolInput(item: Record<string, unknown>): Record<string, unknown> {
  const explicit = [item.input, item.arguments].find(isRecord);
  const input: Record<string, unknown> = explicit === undefined ? {} : { ...explicit };
  for (const field of CODEX_ITEM_INPUT_FIELDS) {
    if (item[field] !== undefined && input[field] === undefined) input[field] = item[field];
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
