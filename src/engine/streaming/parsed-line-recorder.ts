import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { RunnerCallRecorder } from '../calls/recorder.js';
import type { ParsedLine, ParsedTextChannel } from '../runners/types.js';
import { reconcileFinalText } from './final-text.js';
import { accumulateUsage } from './token-usage.js';

export interface ParsedLineRecorder {
  readonly text: string;
  readonly usage: TokenDelta | null;
  readonly sessionId: string | null;
  apply: (parsed: ParsedLine) => void;
}

export function createParsedLineRecorder(opts: {
  recorder: RunnerCallRecorder;
  onText?: ((text: string) => void) | undefined;
  onSessionId?: ((id: string) => void) | undefined;
}): ParsedLineRecorder {
  let text = '';
  let usage: TokenDelta | null = null;
  let sessionId: string | null = null;
  let activeToolUse: { id: string | null; name: string } | null = null;

  return {
    get text() {
      return text;
    },
    get usage() {
      return usage;
    },
    get sessionId() {
      return sessionId;
    },
    apply(parsed) {
      if (parsed.text) {
        const channel = parsed.channel ?? inferredTextChannel(parsed);
        if (channel === 'result') {
          const reconciliation = reconcileFinalText(text, parsed.text);
          text = parsed.text;
          if (reconciliation.kind === 'full') {
            opts.onText?.(reconciliation.text);
            opts.recorder.text({ channel: 'result', text: parsed.text, semantics: 'final' });
          } else if (reconciliation.kind === 'suffix') {
            opts.onText?.(reconciliation.text);
            opts.recorder.text({ channel: 'assistant', text: reconciliation.text });
          } else if (reconciliation.kind === 'replace') {
            opts.recorder.text({ channel: 'result', text: parsed.text, semantics: 'final' });
          }
        } else {
          if (contributesToRunnerResult(channel)) {
            text += parsed.text;
            opts.onText?.(parsed.text);
          }
          opts.recorder.text({ channel, text: parsed.text, semantics: 'delta' });
        }
      }

      if (parsed.usage) {
        const semantics = parsed.isResult || parsed.channel === 'result' ? 'final' : 'delta';
        usage = accumulateUsage(usage, parsed.usage, semantics);
        opts.recorder.usage({ usage: parsed.usage, semantics });
      }

      if (parsed.sessionId && parsed.sessionId !== sessionId) {
        sessionId = parsed.sessionId;
        opts.recorder.sessionId({ nativeSessionId: parsed.sessionId });
        opts.onSessionId?.(parsed.sessionId);
      }

      if (parsed.toolUseStart) {
        for (const toolUse of parsed.toolUseStart) {
          activeToolUse = { id: toolUse.id ?? null, name: toolUse.name };
          opts.recorder.toolUseDelta({
            toolUseId: toolUse.id ?? null,
            name: toolUse.name,
            inputDelta: JSON.stringify(toolUse.input),
          });
        }
      }

      if (parsed.toolUseDelta) {
        for (const toolUse of parsed.toolUseDelta) {
          const usesSyntheticId = toolUse.id?.startsWith('content-block-') === true;
          const toolUseId =
            usesSyntheticId && activeToolUse
              ? activeToolUse.id
              : (toolUse.id ?? activeToolUse?.id ?? null);
          const name =
            toolUse.name ??
            (usesSyntheticId || toolUse.id === activeToolUse?.id
              ? activeToolUse?.name
              : undefined) ??
            null;
          opts.recorder.toolUseDelta({
            toolUseId,
            name,
            inputDelta: toolUse.inputDelta,
          });
        }
      }

      if (parsed.toolUse) {
        for (const toolUse of parsed.toolUse) {
          opts.recorder.toolUseDone({
            toolUse: {
              id: toolUse.id ?? null,
              name: toolUse.name,
              input: toolUse.input,
              ...(toolUse.output !== undefined && { output: toolUse.output }),
            },
          });
        }
      }

      if (parsed.toolUseDone) {
        for (const toolUse of parsed.toolUseDone) {
          opts.recorder.toolUseDone({
            toolUse: {
              id: toolUse.id ?? null,
              name: toolUse.name,
              input: toolUse.input,
              ...(toolUse.output !== undefined && { output: toolUse.output }),
            },
          });
        }
      }

      if (parsed.warning) {
        for (const warning of parsed.warning) {
          opts.recorder.warning({ warning });
        }
      }

      if (parsed.isError) {
        opts.recorder.finishFailed({
          status: 'failed',
          error: {
            code: 'runner_result_error',
            message: parsed.text ?? 'Runner result failed',
          },
        });
      }
    },
  };
}

function inferredTextChannel(parsed: ParsedLine): ParsedTextChannel {
  return parsed.isResult ? 'result' : 'stdout';
}

function contributesToRunnerResult(channel: ParsedTextChannel): boolean {
  return channel === 'assistant' || channel === 'result' || channel === 'stdout';
}
