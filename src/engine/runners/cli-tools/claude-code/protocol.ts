import { parseStreamLine } from '../../../streaming/parse/stream-json/line.js';
import type { StreamParseResult } from '../../../streaming/parse/stream-json/result.js';
import type { CliProtocolEvent } from '../contract.js';
import { createClaudeReplyParser } from './reply-parser.js';

export function createClaudeParser(): (line: string) => readonly CliProtocolEvent[] {
  const parse = createClaudeReplyParser();
  return (line) => protocolEvents(parse(line));
}

export function toProtocolEvents(line: string): readonly CliProtocolEvent[] {
  return protocolEvents(parseStreamLine(line));
}

function protocolEvents(parsed: StreamParseResult): readonly CliProtocolEvent[] {
  const events: CliProtocolEvent[] = [];
  if (parsed.inputAck !== undefined) events.push({ type: 'input-ack', text: parsed.inputAck });
  if (parsed.sessionId !== undefined) {
    events.push({
      type: 'session',
      nativeSessionId: parsed.sessionId,
      ...(parsed.resolvedModel !== undefined && { resolvedModel: parsed.resolvedModel }),
    });
  }
  if (
    !parsed.isResult &&
    ((parsed.text !== undefined && parsed.text.length > 0) || parsed.textSemantics === 'final')
  ) {
    events.push({
      type: 'text',
      channel: parsed.channel ?? 'assistant',
      text: parsed.text ?? '',
      ...(parsed.subagentId !== undefined && { subagentId: parsed.subagentId }),
      ...(parsed.textSemantics !== undefined && { semantics: parsed.textSemantics }),
    });
  }
  // A tool is started from its first block until its `tool_result`; the whole input re-announces it.
  for (const toolUse of [...(parsed.toolUseStart ?? []), ...(parsed.toolUseInput ?? [])]) {
    events.push({
      type: 'tool-use',
      stage: 'started',
      id: toolUse.id ?? null,
      name: toolUse.name,
      input: { ...toolUse.input },
    });
  }
  for (const toolUse of parsed.toolUseDelta ?? []) {
    events.push({
      type: 'tool-use-delta',
      id: toolUse.id ?? null,
      name: toolUse.name ?? null,
      inputDelta: toolUse.inputDelta,
    });
  }
  for (const toolUse of parsed.toolUse ?? []) {
    events.push({
      type: 'tool-use',
      stage: 'done',
      id: toolUse.id ?? null,
      name: toolUse.name,
      input: { ...toolUse.input },
    });
  }
  for (const warning of parsed.warning ?? []) {
    events.push({
      type: 'warning',
      code: warning.code,
      message: warning.message,
      ...(warning.severity !== undefined && { severity: warning.severity }),
      ...(warning.originalModel !== undefined && { originalModel: warning.originalModel }),
      ...(warning.fallbackModel !== undefined && { fallbackModel: warning.fallbackModel }),
      ...(warning.usage !== undefined && { usage: warning.usage }),
    });
  }
  if (parsed.isHeartbeat) events.push({ type: 'heartbeat' });
  if (parsed.isResult) {
    const isError = parsed.isError === true;
    if (isError) {
      events.push({
        type: 'result',
        status: 'failed',
        text: parsed.text ?? '',
        nativeSessionId: parsed.sessionId ?? null,
        error: { code: 'runner_result_error', message: parsed.text ?? 'Claude result failed' },
        partial: true,
      });
    } else {
      events.push({
        type: 'result',
        status: 'completed',
        text: parsed.text ?? '',
        nativeSessionId: parsed.sessionId ?? null,
        error: null,
        partial: false,
        ...(parsed.structured !== undefined && { structured: parsed.structured }),
      });
    }
  }
  return events;
}

export function claudeProtocolEvents(line: string): readonly CliProtocolEvent[] {
  return toProtocolEvents(line);
}
