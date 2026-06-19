import { describe, expect, it } from 'vitest';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { projectRunnerCallActivity } from './activity.js';
import type { RunnerCallEvent } from './types.js';

const runnerCallBase = {
  ts: 1_200,
  callId: 'call-1',
  role: 'implementer',
  backendKind: 'cli',
  runnerName: 'codex',
  model: 'xhigh',
  attempt: 0,
} as const;

type RunnerToolUseDeltaEvent = Extract<RunnerCallEvent, { type: 'call_tool_use_delta' }>;

function runnerToolUse(overrides?: Partial<RunnerToolUseDeltaEvent>): RunnerCallEvent {
  return {
    ...runnerCallBase,
    type: 'call_tool_use_delta',
    channel: 'tool',
    toolUseId: 'tool-1',
    name: 'Read',
    inputDelta: '{"file_path":"src/app.ts"}',
    ...overrides,
  };
}

describe('projectRunnerCallActivity', () => {
  it('normalizes safe structured tool, session, artifact, and warning activity', () => {
    expect(projectRunnerCallActivity(runnerToolUse(), 1)).toMatchObject({
      kind: 'read',
      label: 'reading src/app.ts',
    });
    expect(
      projectRunnerCallActivity(
        runnerToolUse({ name: 'Bash', inputDelta: '{"command":"npm run typecheck"}' }),
        1,
      ),
    ).toMatchObject({ kind: 'command', label: 'running npm run typecheck' });
    expect(
      projectRunnerCallActivity(
        runnerToolUse({ name: 'Grep', inputDelta: '{"pattern":"useWorkflowRunner"}' }),
        1,
      ),
    ).toMatchObject({ kind: 'search', label: 'searching useWorkflowRunner' });
    expect(
      projectRunnerCallActivity(
        runnerToolUse({ name: 'Glob', inputDelta: '{"pattern":"src/**/*.tsx"}' }),
        1,
      ),
    ).toMatchObject({ kind: 'glob', label: 'matching src/**/*.tsx' });
    expect(
      projectRunnerCallActivity(
        runnerToolUse({ name: 'Edit', inputDelta: '{"file_path":"src/app.tsx"}' }),
        1,
      ),
    ).toMatchObject({ kind: 'write', label: 'editing src/app.tsx' });
    expect(projectRunnerCallActivity(runnerToolUse({ name: 'apply_patch' }), 1)).toMatchObject({
      kind: 'edit',
      label: 'applying patch',
    });
    expect(
      projectRunnerCallActivity(
        { ...runnerCallBase, type: 'call_session_id', nativeSessionId: 'native-session-1' },
        1,
      ),
    ).toMatchObject({ kind: 'session', label: 'session native-session-1' });
    expect(
      projectRunnerCallActivity(
        {
          ...runnerCallBase,
          type: 'call_artifact',
          artifact: {
            id: 'artifact-1',
            source: 'file',
            name: 'plan.md',
            path: null,
            mimeType: 'text/markdown',
            text: null,
          },
        },
        1,
      ),
    ).toMatchObject({ kind: 'artifact', label: 'artifact plan.md' });
    expect(
      projectRunnerCallActivity(
        { ...runnerCallBase, type: 'call_warning', warning: { code: 'stderr', message: 'raw' } },
        1,
      ),
    ).toMatchObject({ kind: 'warning', label: 'warning stderr' });
  });

  it('ignores prompt-like tool fields and does not invent exploring labels', () => {
    const activity = projectRunnerCallActivity(
      runnerToolUse({
        name: 'Task',
        inputDelta: JSON.stringify({
          subagent_type: 'general',
          prompt: 'inspect token sk-abcdefghijklmnopqrstuvwxyz',
          description: 'explore the codebase',
          task: 'find the bug',
        }),
      }),
      1,
    );

    expect(activity).toMatchObject({ label: 'task general' });
    expect(activity?.label).not.toContain('prompt');
    expect(activity?.label).not.toContain('explore');
    expect(activity?.label).not.toContain('abcdefghijklmnopqrstuvwxyz');

    expect(
      projectRunnerCallActivity(
        runnerToolUse({ name: 'Explore', inputDelta: '{"description":"files"}' }),
        1,
      ),
    ).toMatchObject({ label: 'tool Explore' });
  });

  it('uses safe web and MCP targets without leaking URL query strings', () => {
    expect(
      projectRunnerCallActivity(
        runnerToolUse({
          name: 'WebFetch',
          inputDelta: '{"url":"https://example.com/path?token=sk-abcdefghijklmnopqrstuvwxyz"}',
        }),
        1,
      ),
    ).toMatchObject({ kind: 'web', label: 'calling WebFetch example.com' });

    expect(
      projectRunnerCallActivity(runnerToolUse({ name: 'mcp__chrome_devtools__click' }), 1),
    ).toMatchObject({ kind: 'mcp', label: 'calling mcp__chrome_devtools__click' });
  });

  it('falls back to a safe tool name for malformed input deltas', () => {
    expect(
      projectRunnerCallActivity(runnerToolUse({ name: 'Bash', inputDelta: '{"command":' }), 1),
    ).toMatchObject({ label: 'tool Bash' });
  });

  it('only projects explicitly system text activity', () => {
    expect(
      projectRunnerCallActivity(
        {
          ...runnerCallBase,
          type: 'call_text_delta',
          channel: 'system',
          text: 'reading\u001b[31m files\u001b[0m token sk-abcdefghijklmnopqrst',
        },
        1,
      ),
    ).toMatchObject({
      label: 'reading files token sk-***REDACTED***',
      redacted: true,
    });
    expect(
      projectRunnerCallActivity(
        { ...runnerCallBase, type: 'call_text_delta', channel: 'stdout', text: 'stdout' },
        1,
      ),
    ).toBeNull();
    expect(
      projectRunnerCallActivity(
        { ...runnerCallBase, type: 'call_text_delta', channel: 'assistant', text: 'answer' },
        1,
      ),
    ).toBeNull();
    expect(
      projectRunnerCallActivity(
        { ...runnerCallBase, type: 'call_text_delta', channel: 'result', text: 'answer' },
        1,
      ),
    ).toBeNull();
  });

  it('bounds activity labels by terminal cell width', () => {
    const activity = projectRunnerCallActivity(
      runnerToolUse({ name: 'Bash', inputDelta: `{"command":"${'界🙂'.repeat(80)}"}` }),
      1,
    );

    expect(activity).not.toBeNull();
    if (activity !== null) expect(getTerminalCellWidth(activity.label)).toBeLessThanOrEqual(80);
  });
});
