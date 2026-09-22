import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { RunnerCallRecorder } from '../calls/recorder.js';
import type { ParsedLine, ParsedTextChannel } from '../runners/types.js';
import {
  createRunnerCallDeltaLimiter,
  type RunnerCallDeltaLimitResult,
} from '../calls/output-limit.js';
import { reconcileFinalText } from './final-text.js';
import { accumulateTokenUsage } from '../calls/usage.js';

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
  /**
   * Bounds only what streams live. The recorder receives every byte, cuts the
   * call's text past its own budget, and reports the cut only when the text the
   * call ends with was cut, not narration a final text replaced.
   */
  let liveLimiter = createLiveLimiter();

  function acceptTextDelta(textDelta: string): RunnerCallDeltaLimitResult {
    return liveLimiter.accept(textDelta);
  }

  function acceptFinalText(textDelta: string): RunnerCallDeltaLimitResult {
    liveLimiter = createLiveLimiter();
    return liveLimiter.accept(textDelta);
  }

  function applyResultText(resultText: string): void {
    const reconciliation = reconcileFinalText(text, resultText);
    if (reconciliation.kind === 'none') return;

    const accepted =
      reconciliation.kind === 'suffix'
        ? acceptTextDelta(reconciliation.text)
        : acceptFinalText(reconciliation.text);
    if (reconciliation.kind === 'full') {
      text = accepted.text;
      if (accepted.text.length > 0) {
        opts.onText?.(accepted.text);
      }
      opts.recorder.text({ channel: 'result', text: reconciliation.text, semantics: 'final' });
      return;
    }
    if (reconciliation.kind === 'suffix') {
      text += accepted.text;
      if (accepted.text.length > 0) opts.onText?.(accepted.text);
      opts.recorder.text({ channel: 'assistant', text: reconciliation.text });
      return;
    }

    text = accepted.text;
    opts.recorder.text({ channel: 'result', text: reconciliation.text, semantics: 'final' });
  }

  function applyDeltaText(channel: ParsedTextChannel, textDelta: string): void {
    const accepted = acceptTextDelta(textDelta);
    if (accepted.text.length > 0 && contributesToRunnerResult(channel)) {
      text += accepted.text;
      opts.onText?.(accepted.text);
    }
    opts.recorder.text({ channel, text: textDelta, semantics: 'delta' });
  }

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
          applyResultText(parsed.text);
        } else {
          applyDeltaText(channel, parsed.text);
        }
      }

      if (parsed.usage) {
        const semantics =
          parsed.usageSemantics ??
          (parsed.isResult || parsed.channel === 'result' ? 'final' : 'delta');
        usage = accumulateTokenUsage(usage, parsed.usage, semantics);
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
            stage: 'started',
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

function createLiveLimiter(): ReturnType<typeof createRunnerCallDeltaLimiter> {
  return createRunnerCallDeltaLimiter({
    code: 'runner_output_text_limit',
    label: 'runner output text',
  });
}
