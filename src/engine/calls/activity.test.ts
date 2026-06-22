import { describe, expect, it } from 'vitest';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { projectRunnerCallActivity } from './activity.js';
import type { RunnerCallEvent, RunnerCallWarningInput } from './types.js';
import { normalizeRunnerCallWarning } from './warnings.js';

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

function runnerWarning(input: RunnerCallWarningInput) {
  return normalizeRunnerCallWarning(input);
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
        runnerToolUse({
          name: 'command_execution',
          inputDelta: '{"type":"command_execution","command":"npm test"}',
        }),
        1,
      ),
    ).toMatchObject({ kind: 'command', label: 'running npm test', target: 'npm test' });
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
    ).toMatchObject({ kind: 'session', label: 'session captured' });
    expect(
      JSON.stringify(
        projectRunnerCallActivity(
          { ...runnerCallBase, type: 'call_session_id', nativeSessionId: 'native-session-1' },
          1,
        ),
      ),
    ).not.toContain('native-session-1');
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
        {
          ...runnerCallBase,
          type: 'call_warning',
          warning: runnerWarning({ code: 'stderr', message: 'raw' }),
        },
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

    expect(
      projectRunnerCallActivity(
        runnerToolUse({
          name: 'mcp_tool_call',
          inputDelta: '{"type":"mcp_tool_call","server":"github","tool_name":"list_issues"}',
        }),
        1,
      ),
    ).toMatchObject({
      kind: 'mcp',
      label: 'calling mcp_tool_call github/list_issues',
      target: 'github/list_issues',
    });
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
      label: 'system activity',
      textPartial: 'reading files token sk-***REDACTED***',
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
    expect(
      projectRunnerCallActivity(
        {
          ...runnerCallBase,
          type: 'call_stderr_delta',
          channel: 'stderr',
          text: 'benign progress',
        },
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

  it('projects terminal success and failure states as distinct activity', () => {
    expect(
      projectRunnerCallActivity(
        {
          ...runnerCallBase,
          type: 'call_completed',
          status: 'completed',
          error: null,
          startedAt: 1_000,
          endedAt: 2_000,
          durationMs: 1_000,
          partial: false,
          usage: null,
          nativeSessionId: null,
        },
        10,
      ),
    ).toMatchObject({
      activityId: 'call-1:terminal',
      stage: 'completed',
      kind: 'text',
      label: 'completed implementer',
      rawAvailable: false,
    });

    expect(
      projectRunnerCallActivity(
        {
          ...runnerCallBase,
          type: 'call_error',
          status: 'timeout',
          error: { code: 'timeout', message: 'runner timed out sk-abcdefghijklmnopqrst' },
          startedAt: 1_000,
          endedAt: 2_000,
          durationMs: 1_000,
          partial: true,
          usage: null,
          nativeSessionId: null,
        },
        11,
      ),
    ).toMatchObject({
      activityId: 'call-1:terminal',
      stage: 'timeout',
      kind: 'error',
      label: 'timeout timeout',
      diagnosticPartial: 'runner timed out sk-***REDACTED***',
      rawAvailable: true,
      redacted: true,
    });
  });

  it('keeps safe warning detail separate from text partials', () => {
    const warning = runnerWarning({ code: 'stderr', message: 'line one sk-abcdefghijklmnopqrst' });

    expect(warning).toMatchObject({
      message: 'line one sk-***REDACTED***',
      redacted: true,
    });
    expect(JSON.stringify(warning)).not.toContain('abcdefghijklmnopqrst');
    expect(
      projectRunnerCallActivity(
        {
          ...runnerCallBase,
          type: 'call_warning',
          warning,
        },
        12,
      ),
    ).toMatchObject({
      stage: 'warning',
      kind: 'warning',
      label: 'warning stderr',
      diagnosticPartial: 'line one sk-***REDACTED***',
      rawAvailable: false,
      redacted: true,
    });
  });

  it('uses normalized visible warning content for activity identity', () => {
    const first = projectRunnerCallActivity(
      {
        ...runnerCallBase,
        type: 'call_warning',
        warning: runnerWarning({ code: 'stderr', message: 'line one sk-abcdefghijklmnopqrst' }),
      },
      12,
    );
    const repeated = projectRunnerCallActivity(
      {
        ...runnerCallBase,
        type: 'call_warning',
        warning: runnerWarning({ code: 'stderr', message: 'line one sk-abcdefghijklmnopqrst' }),
      },
      13,
    );
    const changed = projectRunnerCallActivity(
      {
        ...runnerCallBase,
        type: 'call_warning',
        warning: runnerWarning({ code: 'stderr', message: 'line two sk-abcdefghijklmnopqrst' }),
      },
      14,
    );

    expect(first?.activityId).toBe(repeated?.activityId);
    expect(changed?.activityId).not.toBe(first?.activityId);
    expect(first?.activityId).not.toContain('abcdefghijklmnopqrst');
  });
});
