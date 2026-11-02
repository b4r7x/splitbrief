import { describe, expect, it } from 'vitest';
import { invokeCommandRunner } from './command-based.js';

const TOOL_USES = 5;

/** A stream-json child that reports five finished tool calls, then its answer, and exits. */
const program = [
  'const emit = (record) => process.stdout.write(JSON.stringify(record) + "\\n");',
  `for (let index = 0; index < ${TOOL_USES}; index += 1) {`,
  '  const id = "tool-" + index;',
  '  emit({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Read", input: { path: "file-" + index + ".ts" } }] } });',
  '  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id }] } });',
  '}',
  'emit({ type: "result", result: "VERDICT: pass" });',
].join('\n');

function invokeReviewer(maxToolCalls: number) {
  return invokeCommandRunner({
    source: {
      kind: 'config',
      runner: {
        command: process.execPath,
        args: ['-e', program],
        outputFormat: 'stream-json',
        maxToolCalls,
      },
      env: process.env,
      notFoundMessage: 'node not found',
    },
    prompt: 'Review the change.',
    cwd: process.cwd(),
    callContext: { callId: 'call-review', role: 'review', backendKind: 'shell' },
  });
}

describe('a shell reviewer seat with maxToolCalls', () => {
  it('stops the call at the tool call after its maxToolCalls', async () => {
    const result = await invokeReviewer(2);

    expect(result.status).toBe('truncated');
    expect(result.error?.code).toBe('runner_call_tool_use_stop');
    expect(result.error?.message).toContain(
      'The call reached the maxToolCalls limit of 2 tool calls and was stopped.',
    );
    expect(result.error?.message).toContain('file-2.ts');
  });
});
