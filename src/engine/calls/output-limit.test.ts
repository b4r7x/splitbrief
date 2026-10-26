import { describe, expect, it } from 'vitest';
import {
  boundRunnerCallToolUse,
  createRunnerCallDeltaLimiter,
  formatLimitSize,
  RUNNER_CALL_OUTPUT_MAX_BYTES,
  RUNNER_CALL_TOOL_USE_MAX_ITEMS,
  runnerCallItemLimit,
  runnerCallLimitError,
  runnerCallLimitWarning,
  runnerCallLineOutputLimit,
  runnerCallToolUseCountLimit,
} from './output-limit.js';

describe('formatLimitSize', () => {
  it('writes a whole number of MiB as MB', () => {
    expect(formatLimitSize(1_048_576)).toBe('1 MB');
  });

  it('writes a whole number of KiB as KB', () => {
    expect(formatLimitSize(262_144)).toBe('256 KB');
  });

  it('writes any other size in bytes', () => {
    expect(formatLimitSize(1000)).toBe('1000 bytes');
  });
});

describe('runnerCallLineOutputLimit', () => {
  it('writes the skipped line as one sentence with its size', () => {
    const limit = runnerCallLineOutputLimit({
      code: 'stderr_line_overflow',
      label: 'the tool error output',
      lineBytes: 9_000,
      maxLineBytes: 8 * 1024,
    });

    expect(limit).toMatchObject({
      code: 'stderr_line_overflow',
      message: 'A line of the tool error output longer than 8 KB was skipped.',
      bytesSeen: 9_000,
      maxBytes: 8 * 1024,
    });
  });
});

describe('createRunnerCallDeltaLimiter', () => {
  it('keeps a prefix of the limit and names the reply in the byte-limit sentence', () => {
    const limiter = createRunnerCallDeltaLimiter({
      code: 'runner_call_text_limit',
      label: 'The reply',
      maxBytes: RUNNER_CALL_OUTPUT_MAX_BYTES,
    });

    const accepted = limiter.accept('x'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES + 10));

    expect(Buffer.byteLength(accepted.text, 'utf8')).toBe(RUNNER_CALL_OUTPUT_MAX_BYTES);
    expect(accepted.limit).toMatchObject({
      code: 'runner_call_text_limit',
      message: 'The reply was larger than 1 MB and was not kept in full.',
    });
  });
});

describe('boundRunnerCallToolUse', () => {
  it('names a tool call output past its byte limit', () => {
    const bounded = boundRunnerCallToolUse({
      id: 'tool-1',
      name: 'read',
      input: {},
      output: 'y'.repeat(300 * 1024),
    });

    expect(bounded.limit).toMatchObject({
      code: 'runner_call_tool_output_limit',
      message: 'A tool call output was larger than 256 KB and was not kept in full.',
    });
  });
});

describe('runnerCallItemLimit', () => {
  it('names the kept items as one sentence', () => {
    const limit = runnerCallItemLimit({
      code: 'runner_call_artifact_count_limit',
      label: 'artifacts',
      maxItems: 64,
    });

    expect(limit).toMatchObject({
      code: 'runner_call_artifact_count_limit',
      message: 'Only the first 64 artifacts of this call are kept.',
    });
  });
});

describe('runnerCallToolUseCountLimit', () => {
  const toolUses = [
    { id: 'tool-1', name: 'read_file', input: { path: 'a.ts' } },
    { id: 'tool-2', name: 'read_file', input: { path: 'b.ts' } },
  ];

  it('writes the warning as one sentence with no recent tool calls', () => {
    const limit = runnerCallToolUseCountLimit(toolUses);

    expect(limit.message).toBe(
      `Only the first ${RUNNER_CALL_TOOL_USE_MAX_ITEMS} tool calls of this call are kept.`,
    );
    expect(runnerCallLimitWarning(limit).message).not.toContain('Recent tool calls');
  });

  it('keeps the recent tool calls in the call error after the sentence', () => {
    const error = runnerCallLimitError(runnerCallToolUseCountLimit(toolUses));

    expect(error.code).toBe('runner_call_tool_use_count_limit');
    expect(error.message).toContain(
      `Only the first ${RUNNER_CALL_TOOL_USE_MAX_ITEMS} tool calls of this call are kept.`,
    );
    expect(error.message).toContain('Recent tool calls');
    expect(error.message).toContain('b.ts');
  });
});
