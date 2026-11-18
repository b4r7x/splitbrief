import { classifyHaltSignature } from '../../../../core/pipeline-spec/halts.js';
import type { RunnerCallResult } from '../../../calls/types.js';
import type { CliProtocolEvent } from '../contract.js';
import { fail, haltFailure, HALT_FAILURES, isFailureExit, namesHalt } from './failures.js';
import type { ProcessCall, ProcessClose } from './types.js';

/**
 * The outcome of a call whose tool closed. The warning of a failure exit after an answer and the
 * final text record now; the returned finish writes the terminal record after the steering
 * session has closed.
 */
export function closedCallFinish(call: ProcessCall, closed: ProcessClose): () => RunnerCallResult {
  const { adapter, protocolEvents, state } = call;
  const diagnoseHalt = (stdoutTail?: readonly string[]) =>
    haltFailure(closed.stderr, stdoutTail, state.recognizedHalt);
  const stdoutTail =
    state.recognizedHalt === undefined ? [state.stdoutLastLine, state.stdoutTailCarry] : [];
  // The process can finish on its own before the guard's abort reaches it.
  if (state.guardFailure !== null) {
    const failure = state.guardFailure;
    return () => fail({ recorder: state.recorder, status: 'failed', error: failure });
  }

  const finishSignal =
    closed.signal === null
      ? null
      : () =>
          fail({
            recorder: state.recorder,
            status: 'failed',
            error: diagnoseHalt(stdoutTail) ?? {
              code: 'signal-exit',
              message: `CLI exited from signal ${closed.signal}`,
            },
          });
  if (finishSignal !== null && (!closed.stoppedForDrain || !state.terminalSeen))
    return finishSignal;
  if (adapter.outputContract.kind === 'structured-terminal' && !state.terminalSeen) {
    // Without a parsed terminal the exit code is the only diagnosis available.
    if (closed.exitCode !== 0) {
      return () =>
        fail({
          recorder: state.recorder,
          status: 'failed',
          error: diagnoseHalt(stdoutTail) ?? {
            code: 'non-zero-exit',
            message: `CLI exited with code ${closed.exitCode ?? 'unknown'}`,
          },
        });
    }
    // The tool printed no terminal, so its diagnostic channel decides. Only stderr counts
    // here: stdout frames can restate the model's prose.
    const stderrHalt = diagnoseHalt();
    if (stderrHalt !== null) {
      return () => fail({ recorder: state.recorder, status: 'failed', error: stderrHalt });
    }
    return () =>
      fail({
        recorder: state.recorder,
        status: 'incomplete',
        error: {
          code: 'protocol-failure',
          message: 'CLI ended without its required terminal result',
        },
      });
  }

  let terminal: Extract<CliProtocolEvent, { type: 'result' }>;
  try {
    terminal = adapter.terminal({
      outputContract: adapter.outputContract,
      events: protocolEvents.events(),
      stderr: closed.stderr,
      exitCode: closed.exitCode,
      signal: closed.signal,
    });
  } catch {
    if (finishSignal !== null) return finishSignal;
    return () =>
      fail({
        recorder: state.recorder,
        status: 'failed',
        error: { code: 'protocol-failure', message: 'CLI terminal result was invalid' },
      });
  }

  const terminalNamesHalt = terminal.status !== 'completed' && namesHalt(terminal.error);
  if (finishSignal !== null && !terminalNamesHalt) return finishSignal;

  // A failure exit preserves a text-exit answer only when it ends the stream without a halt.
  // Parsed failures keep their diagnosis; structured success against a failure exit fails closed.
  const refusedBeforeResult = !state.terminalSeen && state.recognizedHalt !== undefined;
  if (
    terminal.status === 'completed' &&
    (refusedBeforeResult || isFailureExit(adapter.outputContract, closed.exitCode))
  ) {
    const halt = diagnoseHalt(stdoutTail);
    if (halt !== null)
      return () => fail({ recorder: state.recorder, status: 'failed', error: halt });
    const last = protocolEvents.events().at(-1);
    if (
      adapter.outputContract.kind === 'text-exit' &&
      terminal.text.length > 0 &&
      last?.type === 'text' &&
      (last.channel === 'assistant' || last.channel === 'result')
    ) {
      state.recorder.warning({
        warning: {
          code: 'non_zero_exit_after_answer',
          source: 'system',
          message: `CLI exited with code ${closed.exitCode ?? 'unknown'} after its final answer; the answer is kept`,
        },
      });
    } else {
      return () =>
        fail({
          recorder: state.recorder,
          status: 'failed',
          error: {
            code: 'non-zero-exit',
            message: `CLI exited with code ${closed.exitCode ?? 'unknown'}`,
          },
        });
    }
  }

  if (terminal.text.length > 0) {
    state.recorder.text({ channel: 'result', text: terminal.text, semantics: 'final' });
  }
  if (terminal.status === 'completed') {
    return () =>
      state.recorder.finishCompleted({
        usage: terminal.usage,
        nativeSessionId: terminal.nativeSessionId,
        ...(terminal.structured !== undefined && { structured: terminal.structured }),
      });
  }
  // A failed terminal that names no halt of its own leaves the diagnosis to stderr.
  const stderrHalt = terminalNamesHalt ? null : diagnoseHalt();
  // A tool refuses an oversized prompt or a model it cannot serve as an ordinary failed result
  // (Claude Code: "Prompt is too long"; OpenCode: `provider.no-route`). No later reader looks at
  // those words again, so the refusal takes the halt's code here.
  const refusal = classifyHaltSignature([terminal.error.message]);
  const refusalCode =
    refusal === 'input-too-large' || refusal === 'missing-model'
      ? HALT_FAILURES[refusal].code
      : undefined;
  return () =>
    state.recorder.finishFailed({
      status: stderrHalt === null && refusalCode === undefined ? terminal.status : 'failed',
      error:
        refusalCode !== undefined
          ? { ...terminal.error, code: refusalCode }
          : (stderrHalt ?? terminal.error),
      usage: terminal.usage,
      nativeSessionId: terminal.nativeSessionId,
      partial: terminal.partial,
    });
}
