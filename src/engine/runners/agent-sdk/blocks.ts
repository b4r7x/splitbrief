import { isRecord } from '../../../utils/type-guards.js';
import type { RunnerCallRecorder } from '../../calls/recorder.js';
import { runnerCallUnknownUpstreamPreview } from '../../calls/unknown-upstream.js';
import {
  blockType,
  SdkTextBlockSchema,
  SdkToolUseBlockSchema,
  type SdkMessage,
} from './protocol.js';

export function recordInvalidSdkPayload(
  recorder: RunnerCallRecorder,
  payload: unknown,
  issues: Parameters<typeof runnerCallUnknownUpstreamPreview>[0]['issues'],
): void {
  const upstreamType = blockType(payload);
  recorder.unknownUpstream({
    rawPreview: runnerCallUnknownUpstreamPreview({
      label: 'Invalid Agent SDK stream message',
      value: payload,
      issues,
    }),
    backendMetadata: {
      backendKind: recorder.context.backendKind,
      source: 'agent-sdk',
      parser: 'sdk_message',
      ...(upstreamType !== undefined && { upstreamType }),
    },
  });
}

function extractTextFromBlocks(
  blocks: readonly unknown[] | undefined,
  recorder: RunnerCallRecorder,
): string {
  if (!blocks) return '';
  const texts: string[] = [];
  for (const block of blocks) {
    const parsed = SdkTextBlockSchema.safeParse(block);
    if (parsed.success) {
      texts.push(parsed.data.text);
      continue;
    }
    if (blockType(block) === 'text') recordInvalidSdkPayload(recorder, block, parsed.error.issues);
  }
  return texts.join('');
}

export function extractAssistantText(
  message: Extract<SdkMessage, { type: 'assistant' }>,
  recorder: RunnerCallRecorder,
): string {
  return extractTextFromBlocks(message.message?.content, recorder);
}

interface SdkToolUse {
  id: string | null;
  name: string;
  input: Record<string, unknown>;
}

export function extractToolUses(
  message: Extract<SdkMessage, { type: 'assistant' }>,
  recorder: RunnerCallRecorder,
): SdkToolUse[] {
  const blocks = message.message?.content;
  if (!blocks) return [];
  const tools: SdkToolUse[] = [];
  for (const block of blocks) {
    const parsed = SdkToolUseBlockSchema.safeParse(block);
    if (!parsed.success) {
      if (blockType(block) === 'tool_use')
        recordInvalidSdkPayload(recorder, block, parsed.error.issues);
      continue;
    }
    const data = parsed.data;
    tools.push({
      id: data.id ?? data.tool_use_id ?? null,
      name: data.name,
      input: isRecord(data.input) ? data.input : {},
    });
  }
  return tools;
}
